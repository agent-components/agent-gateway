import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import {
  AGENT_PROVIDER,
  SERVER_OPTIONS,
  type AgentHttpProvider,
  type ServerOptions,
} from "../config/tokens.js";
import { buildOpenApiDocument } from "../protocol/openapi.js";

@Controller()
export class UiController {
  constructor(
    @Inject(AGENT_PROVIDER) private readonly provider: AgentHttpProvider,
    @Inject(SERVER_OPTIONS) private readonly options: ServerOptions,
  ) {}

  @Get("openapi.json")
  openapi() {
    return buildOpenApiDocument({ providerId: this.provider.id });
  }

  @Get("api/v1/ui-config")
  uiConfig() {
    return {
      providerId: this.provider.id,
      defaultCwd: this.options.cwd ?? process.cwd(),
      token: this.options.token ?? process.env.AGENT_GATEWAY_TOKEN ?? "",
    };
  }

  @Get("api/v1/sessions")
  listSessions(
    @Query("cwd") cwd?: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.provider.listSessions(
      {
        cwd: cwd ?? this.options.cwd,
        cursor,
        limit: limit ? Number(limit) : undefined,
      },
      {},
    );
  }

  @Get("api/v1/sessions/:id")
  getSession(@Param("id") id: string, @Query("cwd") cwd?: string) {
    return this.provider.getSession(id, { cwd: cwd ?? this.options.cwd }, {});
  }

  @Get("api/v1/models")
  async listModels() {
    if (!this.provider.listModels) return { items: [] };
    return { items: await this.provider.listModels({}) };
  }
}
