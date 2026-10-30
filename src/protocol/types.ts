export type StreamMessageType =
  | "system"
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "status"
  | "usage"
  | "task";

export interface StreamMessage {
  type: StreamMessageType;
  sessionId: string;
  runId: string;
  [key: string]: unknown;
}

export interface RunResultEvent {
  sessionId: string;
  runId: string;
  status: "finished" | "error" | "cancelled";
  text?: string;
  error?: { message: string; code?: string };
  usage?: Record<string, number>;
  durationMs?: number;
  model?: string;
}

export type BusEvent =
  | { kind: "message"; data: StreamMessage }
  | { kind: "result"; data: RunResultEvent }
  | { kind: "done" }
  | { kind: "error"; data: { message: string; code?: string } };

export interface Session {
  id: string;
  name?: string;
  status: string;
  cwd?: string;
  createdAt?: number;
  updatedAt?: number;
  activeRunId?: string | null;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: unknown;
  createdAt?: number;
}

export interface SessionRun {
  id: string;
  status: string;
  createdAt?: number;
  updatedAt?: number;
  result?: string | null;
  error?: string | null;
}

export interface SessionDetail {
  session: Session;
  messages: SessionMessage[];
  runs: SessionRun[];
}

export interface ListResult<T> {
  items: T[];
  nextCursor?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
}

export interface CreateChatRequest {
  prompt: string;
  model: string;
  cwd: string;
  name?: string;
  mode?: string;
  mcpServers?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

export interface ResumeChatRequest {
  sessionId: string;
  prompt: string;
  model?: string;
  cwd?: string;
  mcpServers?: Record<string, unknown>;
  providerOptions?: Record<string, unknown>;
}

export interface ConnectChatRequest {
  sessionId: string;
  runId?: string;
}

export interface SteerChatRequest {
  sessionId: string;
  text: string;
}

export interface CancelChatRequest {
  sessionId: string;
}

export interface SteerResult {
  outcome: string;
}

export interface ProviderContext {
  signal?: AbortSignal;
}

export interface RunStream {
  sessionId: string;
  runId: string;
  events: AsyncIterable<BusEvent>;
  cancel?: () => Promise<void>;
  steer?: (text: string) => Promise<SteerResult>;
  dispose?: () => Promise<void>;
}

export interface ListSessionsQuery {
  cwd?: string;
  cursor?: string;
  limit?: number;
}

export interface GetSessionQuery {
  cwd?: string;
}

export interface AgentHttpProvider {
  readonly id: string;
  create(req: CreateChatRequest, ctx: ProviderContext): Promise<RunStream>;
  resume(req: ResumeChatRequest, ctx: ProviderContext): Promise<RunStream>;
  steer(req: SteerChatRequest, ctx: ProviderContext): Promise<SteerResult>;
  cancel(req: CancelChatRequest, ctx: ProviderContext): Promise<void>;
  listSessions(query: ListSessionsQuery, ctx: ProviderContext): Promise<ListResult<Session>>;
  getSession(id: string, query: GetSessionQuery, ctx: ProviderContext): Promise<SessionDetail>;
  listModels?(ctx: ProviderContext): Promise<ModelInfo[]>;
}

export interface StartServerOptions {
  token?: string;
  cwd?: string;
}
