import { Agent, Cursor } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import type {
  AgentHttpProvider,
  CancelChatRequest,
  CreateChatRequest,
  GetSessionQuery,
  ListResult,
  ListSessionsQuery,
  ModelInfo,
  ProviderContext,
  RenameSessionRequest,
  ResumeChatRequest,
  RunStream,
  Session,
  SessionDetail,
  SessionMessage,
  SessionRun,
  SteerChatRequest,
  SteerResult,
} from "../../protocol/types.js";
import { sdkStreamToBusEvents } from "./map-events.js";

type DisposableAgent = {
  agentId: string;
  send: (
    prompt: string,
    opts?: Record<string, unknown>,
  ) => Promise<{
    id: string;
    stream: () => AsyncIterable<unknown>;
    wait: () => Promise<{
      status: string;
      result?: string;
      error?: { message: string; code?: string };
      usage?: Record<string, number>;
      durationMs?: number;
      model?: { id?: string } | string;
    }>;
    cancel?: () => Promise<void>;
    steer?: (text: string) => Promise<string>;
  }>;
  [Symbol.asyncDispose]?: () => Promise<void>;
};

function requireApiKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) {
    const err = new Error("CURSOR_API_KEY is not set");
    (err as Error & { status: number }).status = 500;
    throw err;
  }
  return key;
}

function isMcpServerConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cfg = value as Record<string, unknown>;
  return typeof cfg.command === "string" || typeof cfg.url === "string";
}

function asMcpServers(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;

  let servers = value;
  if (
    "mcpServers" in servers &&
    servers.mcpServers &&
    typeof servers.mcpServers === "object" &&
    !Array.isArray(servers.mcpServers) &&
    !isMcpServerConfig(servers.mcpServers)
  ) {
    servers = servers.mcpServers as Record<string, unknown>;
  }

  const entries = Object.entries(servers);
  if (!entries.length) return undefined;

  for (const [name, cfg] of entries) {
    if (!isMcpServerConfig(cfg)) {
      const err = new Error(
        `Invalid MCP server "${name}": each value needs "command" (stdio) or "url" (http/sse).`,
      );
      (err as Error & { status: number }).status = 400;
      throw err;
    }
  }

  return servers;
}

function notActive(): never {
  const err = new Error("No active run for session");
  (err as Error & { status: number }).status = 404;
  throw err;
}

export function createCursorProvider(): AgentHttpProvider {
  async function buildRunStream(
    agent: DisposableAgent,
    prompt: string,
    sendOpts: Record<string, unknown> | undefined,
  ): Promise<RunStream> {
    const run = await agent.send(prompt, sendOpts);
    const sessionId = agent.agentId;
    const runId = run.id;

    return {
      sessionId,
      runId,
      events: sdkStreamToBusEvents(
        run.stream() as AsyncIterable<import("@cursor/sdk").SDKMessage>,
        sessionId,
        runId,
        () => run.wait(),
      ),
      cancel: async () => {
        if (run.cancel) await run.cancel();
      },
      steer: async (text: string): Promise<SteerResult> => {
        if (!run.steer) return { outcome: "revert_to_followup" };
        return { outcome: await run.steer(text) };
      },
      dispose: async () => {
        try {
          await agent[Symbol.asyncDispose]?.();
        } catch {
          /* ignore */
        }
      },
    };
  }

  return {
    id: "cursor",

    async create(req: CreateChatRequest, _ctx: ProviderContext): Promise<RunStream> {
      const apiKey = requireApiKey();
      const agent = (await Agent.create({
        apiKey,
        model: { id: req.model },
        name: req.name,
        mcpServers: asMcpServers(req.mcpServers) as never,
        local: {
          cwd: req.cwd,
          ...(req.providerOptions?.local as object | undefined),
        },
        ...(req.mode ? { mode: req.mode as "agent" | "plan" } : {}),
      })) as unknown as DisposableAgent;

      return buildRunStream(agent, req.prompt, {
        ...(req.providerOptions?.send as object | undefined),
      });
    },

    async resume(req: ResumeChatRequest, _ctx: ProviderContext): Promise<RunStream> {
      const apiKey = requireApiKey();
      const cwd = req.cwd ?? process.cwd();
      const agent = (await Agent.resume(req.sessionId, {
        apiKey,
        ...(req.model ? { model: { id: req.model } } : {}),
        mcpServers: asMcpServers(req.mcpServers) as never,
        local: { cwd },
      })) as unknown as DisposableAgent;

      return buildRunStream(agent, req.prompt, {
        ...(req.model ? { model: { id: req.model } } : {}),
        ...(req.providerOptions?.send as object | undefined),
      });
    },

    async steer(_req: SteerChatRequest, _ctx: ProviderContext): Promise<SteerResult> {
      // Prefer ActiveRun.steer on the bus; this is only a fallback.
      notActive();
    },

    async cancel(_req: CancelChatRequest, _ctx: ProviderContext): Promise<void> {
      notActive();
    },

    async listSessions(
      query: ListSessionsQuery,
      _ctx: ProviderContext,
    ): Promise<ListResult<Session>> {
      const cwd = query.cwd ?? process.cwd();
      const result = await Agent.list({
        runtime: "local",
        cwd,
        cursor: query.cursor,
        limit: query.limit,
      });

      const storeById = new Map<
        string,
        { status?: string; name?: string | null; activeRunId?: string | null; updatedAt?: number }
      >();
      try {
        const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd });
        try {
          const listed = await store.agents.list({
            filter: { cwd, limit: query.limit ?? 50 },
          });
          for (const doc of listed.items) {
            storeById.set(doc.agentId, {
              status: doc.status,
              name: doc.name,
              activeRunId: doc.activeRunId ?? null,
              updatedAt: doc.updatedAt,
            });
          }
        } finally {
          await store.dispose();
        }
      } catch {
        /* list still works from Agent.list */
      }

      return {
        items: result.items.map((item) => {
          const local = storeById.get(item.agentId);
          return {
            id: item.agentId,
            name: local?.name ?? item.name ?? undefined,
            // Prefer local store status (idle/running) when available.
            status: String(local?.status ?? item.status ?? "unknown"),
            cwd: (item as { cwd?: string }).cwd ?? cwd,
            createdAt: item.createdAt,
            updatedAt: local?.updatedAt ?? item.lastModified,
            activeRunId:
              local?.activeRunId ??
              (item as { activeRunId?: string | null }).activeRunId ??
              null,
          };
        }),
        nextCursor: result.nextCursor,
      };
    },

    async getSession(
      id: string,
      query: GetSessionQuery,
      _ctx: ProviderContext,
    ): Promise<SessionDetail> {
      const cwd = query.cwd ?? process.cwd();
      const info = await Agent.get(id, { cwd });

      let messages: SessionMessage[] = [];
      try {
        const listed = await Agent.messages.list(id, {
          runtime: "local",
          cwd,
          limit: 200,
        });
        messages = listed.map((m) => ({
          id: m.uuid,
          role: m.type,
          content: m.message,
        }));
      } catch {
        messages = [];
      }

      let runs: SessionRun[] = [];
      try {
        const runList = await Agent.listRuns(id, {
          runtime: "local",
          cwd,
          limit: 50,
        });
        runs = runList.items.map((r) => ({
          id: r.id,
          status: String(r.status),
          createdAt: r.createdAt,
          result: r.result ?? null,
          error: r.error?.message ?? null,
        }));
      } catch {
        runs = [];
      }

      let activeRunId = (info as { activeRunId?: string | null }).activeRunId ?? null;
      let status = String(info.status ?? "unknown");
      let name = info.name ?? undefined;
      let updatedAt = info.lastModified;
      try {
        const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd });
        try {
          const doc = await store.agents.get({ agentId: id });
          if (doc) {
            activeRunId = doc.activeRunId ?? activeRunId;
            status = String(doc.status ?? status);
            name = doc.name ?? name;
            updatedAt = doc.updatedAt ?? updatedAt;
          }
        } finally {
          await store.dispose();
        }
      } catch {
        /* keep Agent.get fields */
      }

      return {
        session: {
          id: info.agentId,
          name,
          status,
          cwd: (info as { cwd?: string }).cwd ?? cwd,
          createdAt: info.createdAt,
          updatedAt,
          activeRunId,
        },
        messages,
        runs,
      };
    },

    async renameSession(
      id: string,
      req: RenameSessionRequest,
      _ctx: ProviderContext,
    ): Promise<Session> {
      const name = req.name?.trim();
      if (!name) {
        const err = new Error("name is required");
        (err as Error & { status: number }).status = 400;
        throw err;
      }
      const cwd = req.cwd ?? process.cwd();
      const store = await SqliteLocalAgentStore.open({ workspaceRef: cwd });
      try {
        const doc = await store.agents.get({ agentId: id });
        if (!doc) {
          const err = new Error(`Session not found: ${id}`);
          (err as Error & { status: number }).status = 404;
          throw err;
        }
        const updated = await store.agents.update({
          agent: {
            ...doc,
            name,
            updatedAt: Date.now(),
          },
        });
        return {
          id: updated.agentId,
          name: updated.name ?? name,
          status: String(updated.status ?? "unknown"),
          cwd: updated.cwd ?? cwd,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
          activeRunId: updated.activeRunId ?? null,
        };
      } finally {
        await store.dispose();
      }
    },

    async listModels(_ctx: ProviderContext): Promise<ModelInfo[]> {
      try {
        const apiKey = requireApiKey();
        const models = await Cursor.models.list({ apiKey });
        return models.map((m) => ({
          id: m.id,
          name: (m as { name?: string }).name ?? m.id,
        }));
      } catch {
        return [{ id: "composer-2.5", name: "composer-2.5" }];
      }
    },
  };
}
