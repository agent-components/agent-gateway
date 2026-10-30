import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Inject,
  InternalServerErrorException,
} from "@nestjs/common";
import type { Request } from "express";
import { SERVER_OPTIONS, type ServerOptions } from "../config/tokens.js";

function extractToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m?.[1]?.trim();
}

@Injectable()
export class TokenGuard implements CanActivate {
  constructor(@Inject(SERVER_OPTIONS) private readonly options: ServerOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const want = this.options.token ?? process.env.AGENT_GATEWAY_TOKEN;
    if (!want) {
      throw new InternalServerErrorException(
        "AGENT_GATEWAY_TOKEN is not configured on the server",
      );
    }
    const req = context.switchToHttp().getRequest<Request>();
    const got = extractToken(req);
    if (!got || got !== want) {
      throw new UnauthorizedException("Unauthorized");
    }
    return true;
  }
}
