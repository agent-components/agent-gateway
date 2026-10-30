import type { AgentHttpProvider, StartServerOptions } from "../protocol/types.js";

export const SERVER_OPTIONS = Symbol("SERVER_OPTIONS");
export const AGENT_PROVIDER = Symbol("AGENT_PROVIDER");

export type ServerOptions = StartServerOptions;
export type { AgentHttpProvider };
