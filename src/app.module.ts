import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicModule, Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { RunEventBus } from "./bus/bus.service.js";
import { ChatController } from "./chat/chat.controller.js";
import { TokenGuard } from "./common/token.guard.js";
import {
  AGENT_PROVIDER,
  SERVER_OPTIONS,
  type ServerOptions,
} from "./config/tokens.js";
import { createCursorProvider } from "./providers/cursor/provider.js";
import { UiController } from "./ui/ui.controller.js";

function resolveWebRoot(): string {
  if (process.env.AGENT_GATEWAY_WEB_ROOT) {
    return process.env.AGENT_GATEWAY_WEB_ROOT;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // Nest convention: static assets live in /public (copied to dist/public on build)
  const candidates = [join(here, "public"), join(here, "..", "public")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return candidates[0]!;
}

@Module({})
export class AppModule {
  static register(options: ServerOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ServeStaticModule.forRoot({
          rootPath: resolveWebRoot(),
          // path-to-regexp v8 (Express 5) — no legacy /(.*) groups
          exclude: ["/api/{*path}", "/openapi.json"],
        }),
      ],
      controllers: [ChatController, UiController],
      providers: [
        { provide: SERVER_OPTIONS, useValue: options },
        { provide: AGENT_PROVIDER, useFactory: () => createCursorProvider() },
        RunEventBus,
        TokenGuard,
      ],
    };
  }
}
