import { Body, Controller, Get, HttpCode, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { randomBytes } from 'node:crypto';
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
const loginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });

function slugify(s: string) {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'team';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
  ) {}

  private token(s: Session) {
    return this.jwt.signAsync({ sub: s.userId, tid: s.tenantId, role: s.role });
  }

  /** Creates a tenant and its first user (the owner) in one transaction. */
  @Post('signup')
  @UseGuards(ThrottlerGuard)
  async signup(@Body() raw: unknown) {
    const body = signupBody.parse(raw);
    const passwordHash = await hashPassword(body.password);
    // The id must be known before the insert: the RLS WITH CHECK compares it to app.tenant_id.
    const [{ id: tenantId }] = await this.db.$queryRaw<{ id: string }[]>`SELECT uuidv7()::text AS id`;

    const { tenant, user } = await this.db.withTenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.create({ data: { id: tenantId, name: body.company, slug: slugify(body.company) } });
      const user = await tx.user.create({ data: { email: body.email.toLowerCase(), name: body.name, passwordHash } });
      await tx.membership.create({ data: { tenantId, userId: user.id, role: 'owner' } });
      return { tenant, user };
    });

    const session: Session = { userId: user.id, tenantId, role: 'owner' };
    return {
      accessToken: await this.token(session),
      user: { id: user.id, name: user.name, email: user.email },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      role: session.role,
    };
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  async login(@Body() raw: unknown) {
    const body = loginBody.parse(raw);
    const user = await this.db.user.findUnique({ where: { email: body.email.toLowerCase() } });
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await DUMMY_HASH));
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');

    // ponytail: signs in to the user's first tenant; add a workspace picker when invites ship.
    const membership = await this.db.withUser(user.id, (tx) =>
      tx.membership.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
    );
    if (!membership) throw new UnauthorizedException('Invalid email or password');

    const session: Session = { userId: user.id, tenantId: membership.tenantId, role: membership.role };
    const tenant = await this.db.withTenant(session.tenantId, (tx) => tx.tenant.findFirstOrThrow());
    return {
      accessToken: await this.token(session),
      user: { id: user.id, name: user.name, email: user.email },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
      role: session.role,
    };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentSession() s: Session) {
    const [user, tenant] = await Promise.all([
      this.db.user.findUniqueOrThrow({ where: { id: s.userId }, select: { id: true, name: true, email: true } }),
      this.db.withTenant(s.tenantId, (tx) => tx.tenant.findFirstOrThrow({ select: { id: true, name: true, slug: true } })),
    ]);
    return { user, tenant, role: s.role };
  }
}
