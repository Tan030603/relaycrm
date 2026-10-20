import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { log, redis } from '../infra';

export interface Session {
  userId: string;
  tenantId: string;
  role: 'owner' | 'rep';
}

const TENANT_RPS = Number(process.env.TENANT_RATE_LIMIT ?? 100);

/**
 * Per-tenant rate limit (fixed 1 s window in Redis), shared by every API replica, so
 * one noisy tenant cannot starve the others. Fails open: if Redis is down the API
 * keeps serving rather than turning a cache outage into a full outage.
 */
async function overTenantLimit(tenantId: string) {
  try {
    const key = `rl:${tenantId}:${Math.floor(Date.now() / 1000)}`;
    const n = await redis().incr(key);
    if (n === 1) await redis().expire(key, 2);
    return n > TENANT_RPS;
  } catch (err) {
    log.debug({ err: String(err) }, 'rate limiter unavailable, allowing');
    return false;
  }
}

/** The tenant always comes from the signed token, never from a header or body the client controls. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const [type, token] = String(req.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Missing access token');
    let p: { sub: string; tid: string; role: Session['role'] };
    try {
      p = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    req.session = { userId: p.sub, tenantId: p.tid, role: p.role } satisfies Session;
    if (await overTenantLimit(p.tid)) throw new HttpException('Too many requests for this workspace', 429);
    return true;
  }
}

export const CurrentSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Session => ctx.switchToHttp().getRequest().session,
);

/** Role check in the API; RLS still isolates tenants underneath (defence in depth). */
export function ownerOnly(s: Session) {
  if (s.role !== 'owner') throw new ForbiddenException('Only workspace owners can do this');
}

/** Reps may change only records they own; owners may change anything in the workspace. */
export function ownsOrOwner(s: Session, ownerId: string | null | undefined) {
  if (s.role !== 'owner' && ownerId !== s.userId) throw new ForbiddenException('You can only change your own records');
}
