import { Body, Controller, Get, HttpCode, Injectable, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Db } from '../db';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password';
import { AuthGuard, CurrentSession, Session } from './session';

const signupBody = z.object({
  company: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(8).max(200),
});
const loginBody = z.object({ email: z.email(), password: z.string().min(1).max(200), tenantId: z.uuid().optional() });
const switchBody = z.object({ tenantId: z.uuid() });

const REFRESH_COOKIE = 'rt';
const REFRESH_DAYS = 30;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function slugify(s: string) {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'team';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

function readCookie(req: Request, name: string) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

@Injectable()
export class Tokens {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  /**
   * Access token: 15 min JWT kept in memory by the SPA. Refresh token: random, stored
   * hashed, sent only as an httpOnly SameSite=Strict cookie scoped to /api/v1/auth,
   * rotated on every use.
   */
  async issue(res: Response, s: Session, familyId: string = randomUUID()) {
    const raw = randomBytes(32).toString('base64url');
    await this.db.refreshToken.create({
      data: { userId: s.userId, tenantId: s.tenantId, familyId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000) },
    });
    res.cookie(REFRESH_COOKIE, raw, {
      httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production',
      path: '/api/v1/auth', maxAge: REFRESH_DAYS * 86_400_000,
    });
    const [user, tenant] = await Promise.all([
      // users has no RLS; reading it inside the tenant transaction just picks the tenant's cell.
      this.db.withTenant(s.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: s.userId }, select: { id: true, name: true, email: true } })),
      this.db.withTenant(s.tenantId, (tx) => tx.tenant.findFirstOrThrow({ select: { id: true, name: true, slug: true } })),
    ]);
    return { accessToken: await this.jwt.signAsync({ sub: s.userId, tid: s.tenantId, role: s.role }), user, tenant, role: s.role };
  }

}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: Db,
    private readonly tokens: Tokens,
  ) {}

  /** Creates a tenant and its first user (the owner) in one transaction. */
  @Post('signup')
  @UseGuards(ThrottlerGuard)
  async signup(@Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const body = signupBody.parse(raw);
    const passwordHash = await hashPassword(body.password);
    const email = body.email.toLowerCase();
    // Ids are known before the inserts: the RLS WITH CHECK compares the tenant id to
    // app.tenant_id, and the directory rows below need both.
    const [{ tenantId, userId }] = await this.db.$queryRaw<{ tenantId: string; userId: string }[]>`SELECT uuidv7()::text AS "tenantId", uuidv7()::text AS "userId"`;

    // Directory first: its unique email keeps addresses unique across every cell (409 on clash).
    const shard = this.db.signupShard();
    await this.db.$transaction([
      this.db.userShard.create({ data: { userId, email, shard } }),
      this.db.tenantShard.create({ data: { tenantId, shard } }),
    ]);

    const user = await this.db.withTenant(tenantId, async (tx) => {
      await tx.tenant.create({ data: { id: tenantId, name: body.company, slug: slugify(body.company) } });
      const user = await tx.user.create({ data: { id: userId, email, name: body.name, passwordHash } });
      await tx.membership.create({ data: { tenantId, userId: user.id, role: 'owner' } });
      await tx.leadForm.create({
        data: {
          tenantId, name: 'Contact us', headline: 'Talk to our team',
          fields: [
            { key: 'name', label: 'Name', required: true },
            { key: 'email', label: 'Work email', required: true },
            { key: 'company', label: 'Company', required: false },
            { key: 'phone', label: 'Phone', required: false },
            { key: 'message', label: 'How can we help?', required: false },
          ],
        },
      });
      return user;
    }).catch(async (err: unknown) => {
      await this.db.$transaction([this.db.userShard.deleteMany({ where: { userId } }), this.db.tenantShard.deleteMany({ where: { tenantId } })]);
      throw err;
    });
    return this.tokens.issue(res, { userId: user.id, tenantId, role: 'owner' });
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  async login(@Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const body = loginBody.parse(raw);
    const email = body.email.toLowerCase();
    const user = await this.db.cell(await this.db.shardOfUser({ email })).user.findUnique({ where: { email } });
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await DUMMY_HASH));
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');

    const membership = await this.db.withUser(user.id, (tx) =>
      tx.membership.findFirst({ where: { userId: user.id, ...(body.tenantId && { tenantId: body.tenantId }) }, orderBy: { createdAt: 'asc' } }),
    );
    if (!membership) throw new UnauthorizedException('Invalid email or password');
    return this.tokens.issue(res, { userId: user.id, tenantId: membership.tenantId, role: membership.role });
  }

  /** Rotates the refresh token. Reusing an old one revokes the whole chain (stolen-token signal). */
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = readCookie(req, REFRESH_COOKIE);
    if (!raw) throw new UnauthorizedException('No session');
    const rt = await this.db.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (!rt) throw new UnauthorizedException('No session');
    if (rt.revokedAt) {
      await this.db.refreshToken.updateMany({ where: { familyId: rt.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new UnauthorizedException('Session revoked');
    }
    if (rt.expiresAt < new Date()) throw new UnauthorizedException('Session expired');
    // Only one concurrent refresh wins the rotation; the loser sees count 0.
    const { count } = await this.db.refreshToken.updateMany({ where: { id: rt.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!count) throw new UnauthorizedException('Session revoked');

    // Re-read the membership: a removed member or changed role takes effect here.
    const m = await this.db.withUser(rt.userId, (tx) => tx.membership.findFirst({ where: { userId: rt.userId, tenantId: rt.tenantId } }));
    if (!m) throw new UnauthorizedException('No longer a member of this workspace');
    return this.tokens.issue(res, { userId: rt.userId, tenantId: rt.tenantId, role: m.role }, rt.familyId);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const raw = readCookie(req, REFRESH_COOKIE);
    if (raw) {
      const rt = await this.db.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
      if (rt) await this.db.refreshToken.updateMany({ where: { familyId: rt.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentSession() s: Session) {
    const [user, tenant] = await Promise.all([
      this.db.withTenant(s.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: s.userId }, select: { id: true, name: true, email: true } })),
      this.db.withTenant(s.tenantId, (tx) => tx.tenant.findFirstOrThrow({ select: { id: true, name: true, slug: true } })),
    ]);
    return { user, tenant, role: s.role };
  }

  /** Workspaces this user belongs to, for the switcher. */
  @Get('workspaces')
  @UseGuards(AuthGuard)
  async workspaces(@CurrentSession() s: Session) {
    const ms = await this.db.withUser(s.userId, (tx) => tx.membership.findMany({ where: { userId: s.userId }, orderBy: { createdAt: 'asc' } }));
    return Promise.all(
      ms.map(async (m) => ({
        role: m.role,
        ...(await this.db.withTenant(m.tenantId, (tx) => tx.tenant.findFirstOrThrow({ select: { id: true, name: true } }))),
      })),
    );
  }

  @Post('switch')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async switch(@CurrentSession() s: Session, @Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const { tenantId } = switchBody.parse(raw);
    const m = await this.db.withUser(s.userId, (tx) => tx.membership.findFirst({ where: { userId: s.userId, tenantId } }));
    if (!m) throw new UnauthorizedException('Not a member of that workspace');
    return this.tokens.issue(res, { userId: s.userId, tenantId, role: m.role });
  }
}
