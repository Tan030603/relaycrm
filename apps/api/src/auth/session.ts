import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export interface Session {
  userId: string;
  tenantId: string;
  role: 'owner' | 'rep';
}

/** The tenant always comes from the signed token, never from a header or body the client controls. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const [type, token] = String(req.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Missing access token');
    try {
      const p = await this.jwt.verifyAsync<{ sub: string; tid: string; role: Session['role'] }>(token);
      req.session = { userId: p.sub, tenantId: p.tid, role: p.role } satisfies Session;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }
}

export const CurrentSession = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Session => ctx.switchToHttp().getRequest().session,
);
