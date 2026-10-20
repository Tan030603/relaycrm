import { BadRequestException, Body, ConflictException, Controller, Get, GoneException, HttpCode, NotFoundException, Param, Post, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Tokens, sha256 } from './auth/auth.controller';
import { DUMMY_HASH, hashPassword, verifyPassword } from './auth/password';
import { AuthGuard, CurrentSession, Session, ownerOnly } from './auth/session';
import { Db } from './db';
import { MAIL_FROM, audit, log, mailer } from './infra';

const inviteBody = z.object({ email: z.email().max(254), role: z.enum(['owner', 'rep']).default('rep') });
const acceptBody = z.object({ name: z.string().trim().min(1).max(100).optional(), password: z.string().min(8).max(200) });
const INVITE_DAYS = 7;

/**
 * Invite tokens look like "<tenant id>.<secret>". The tenant part lets the public
 * accept endpoint set the RLS context before looking the invitation up; only the
 * hash of the secret is stored.
 */
function parseToken(token: string) {
  const [tenantId, secret] = token.split('.');
  if (!z.uuid().safeParse(tenantId).success || !secret) throw new NotFoundException('Invitation not found');
  return { tenantId, hash: sha256(secret) };
}

@Controller()
export class TeamController {
  constructor(
    private readonly db: Db,
    private readonly tokens: Tokens,
  ) {}

  @Get('members')
  @UseGuards(AuthGuard)
  async members(@CurrentSession() s: Session) {
    const ms = await this.db.withTenant(s.tenantId, (tx) =>
      tx.membership.findMany({ where: { tenantId: s.tenantId }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'asc' } }),
    );
    return ms.map((m) => ({ ...m.user, role: m.role, joinedAt: m.createdAt }));
  }

  @Get('invitations')
  @UseGuards(AuthGuard)
  async pending(@CurrentSession() s: Session) {
    return this.db.withTenant(s.tenantId, (tx) =>
      tx.invitation.findMany({
        where: { tenantId: s.tenantId, acceptedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
        orderBy: { id: 'desc' },
      }),
    );
  }

  @Post('invitations')
  @UseGuards(AuthGuard)
  async invite(@CurrentSession() s: Session, @Body() raw: unknown) {
    ownerOnly(s);
    const body = inviteBody.parse(raw);
    const email = body.email.toLowerCase();
    const secret = randomBytes(24).toString('base64url');
    const token = `${s.tenantId}.${secret}`;
    const tenant = await this.db.withTenant(s.tenantId, async (tx) => {
      const existing = await tx.membership.findFirst({ where: { tenantId: s.tenantId, user: { email } } });
      if (existing) throw new BadRequestException('Already a member');
      const inv = await tx.invitation.create({
        data: { tenantId: s.tenantId, email, role: body.role, tokenHash: sha256(secret), invitedBy: s.userId, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) },
      });
      await audit(tx, s.tenantId, s.userId, 'invitation.created', 'invitation', inv.id, { role: body.role });
      return tx.tenant.findFirstOrThrow();
    });
    const inviteUrl = `${process.env.APP_URL ?? 'http://localhost:5180'}/invite/${token}`;
    // Best effort: the owner also gets the link to share directly.
    mailer()
      .sendMail({ from: MAIL_FROM, to: email, subject: `Join ${tenant.name} on RelayCRM`, text: `You are invited to ${tenant.name}.\n\nAccept: ${inviteUrl}\n\nThis link expires in ${INVITE_DAYS} days.` })
      .catch((err: unknown) => log.warn({ err: String(err) }, 'invite email failed'));
    return { email, role: body.role, inviteUrl };
  }

  /** Public: shows who invited whom, for the accept page. */
  @Get('invitations/:token')
  async preview(@Param('token') token: string) {
    const { tenantId, hash } = parseToken(token);
    const r = await this.db.withTenant(tenantId, async (tx) => {
      const inv = await tx.invitation.findFirst({ where: { tokenHash: hash } });
      return inv && { inv, tenant: await tx.tenant.findFirstOrThrow() };
    });
    if (!r) throw new NotFoundException('Invitation not found');
    if (r.inv.acceptedAt || r.inv.expiresAt < new Date()) throw new GoneException('Invitation expired or already used');
    const shard = await this.db.shardOfUser({ email: r.inv.email });
    const existing = await this.db.cell(shard).user.findUnique({ where: { email: r.inv.email }, select: { id: true } });
    return { email: r.inv.email, role: r.inv.role, tenant: r.tenant.name, hasAccount: !!existing };
  }

  /** Public: joins the workspace. New people pick a name and password; existing users confirm theirs. */
  @Post('invitations/:token/accept')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  async accept(@Param('token') token: string, @Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const { tenantId, hash } = parseToken(token);
    const body = acceptBody.parse(raw);
    const inv = await this.db.withTenant(tenantId, (tx) => tx.invitation.findFirst({ where: { tokenHash: hash } }));
    if (!inv) throw new NotFoundException('Invitation not found');
    if (inv.acceptedAt || inv.expiresAt < new Date()) throw new GoneException('Invitation expired or already used');

    // A user lives in one cell: an existing account elsewhere cannot join this tenant.
    const tenantShard = await this.db.shardOfTenant(tenantId);
    const userShard = await this.db.shardOfUser({ email: inv.email });
    const existingDir = await this.db.userShard.findUnique({ where: { email: inv.email } });
    if (existingDir && userShard !== tenantShard) throw new ConflictException('This account lives in another data region; use a different email');
    const cell = this.db.cell(tenantShard);
    let user = await cell.user.findUnique({ where: { email: inv.email } });
    if (user) {
      if (!(await verifyPassword(body.password, user.passwordHash))) throw new UnauthorizedException('Wrong password for this account');
    } else {
      if (!body.name) throw new BadRequestException('Name is required');
      await DUMMY_HASH;
      const [{ id }] = await this.db.$queryRaw<{ id: string }[]>`SELECT uuidv7()::text AS id`;
      await this.db.userShard.create({ data: { userId: id, email: inv.email, shard: tenantShard } });
      user = await cell.user.create({ data: { id, email: inv.email, name: body.name, passwordHash: await hashPassword(body.password) } });
    }
    const userId = user.id;
    await this.db.withTenant(tenantId, async (tx) => {
      // Conditional update: two concurrent accepts cannot both succeed.
      const { count } = await tx.invitation.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (!count) throw new GoneException('Invitation already used');
      await tx.membership.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        create: { tenantId, userId, role: inv.role },
        update: {},
      });
      await audit(tx, tenantId, userId, 'member.joined', 'membership', undefined, { role: inv.role });
    });
    return this.tokens.issue(res, { userId, tenantId, role: inv.role });
  }
}
