/**
 * OpenAPI 3 document for the public chat API only.
 * UI-only routes (sessions, models) are intentionally omitted.
 */
export function buildOpenApiDocument(options?: {
  title?: string;
  providerId?: string;
  version?: string;
}): Record<string, unknown> {
  const title = options?.title ?? "agent-gateway Chat API";
  const version = options?.version ?? "0.1.0";
  const provider = options?.providerId ?? "provider";

  return {
    openapi: "3.0.3",
    info: {
      title,
      version,
      description: `Unified agent-gateway chat API (${provider}). Authenticate with AGENT_GATEWAY_TOKEN via Bearer.`,
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        AgentGatewayToken: {
          type: "http",
          scheme: "bearer",
          description: "Value of AGENT_GATEWAY_TOKEN",
        },
      },
      schemas: {
        ChatAttachment: {
          type: "object",
          required: ["name", "data"],
          properties: {
            name: { type: "string", description: "Original file name" },
            mimeType: { type: "string" },
            data: {
              type: "string",
              description: "Base64 file bytes, or a data URL. All files are stored under AGENT_GATEWAY_UPLOAD_DIR (or {cwd}/.agent-gateway/uploads) with a random filename. Images are passed through as received.",
            },
          },
        },
        CreateChatRequest: {
          type: "object",
          required: ["model", "cwd"],
          properties: {
            prompt: { type: "string", description: "Required when attachments is empty" },
            model: { type: "string" },
            cwd: { type: "string" },
            name: { type: "string" },
            mode: { type: "string" },
            mcpServers: { type: "object", additionalProperties: true },
            providerOptions: { type: "object", additionalProperties: true },
            attachments: {
              type: "array",
              maxItems: 8,
              items: { $ref: "#/components/schemas/ChatAttachment" },
            },
          },
        },
        ResumeChatRequest: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string" },
            prompt: { type: "string", description: "Required when attachments is empty" },
            model: { type: "string" },
            cwd: { type: "string" },
            mcpServers: { type: "object", additionalProperties: true },
            providerOptions: { type: "object", additionalProperties: true },
            attachments: {
              type: "array",
              maxItems: 8,
              items: { $ref: "#/components/schemas/ChatAttachment" },
            },
          },
        },
        ConnectChatRequest: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string" },
            runId: { type: "string" },
          },
        },
        SteerChatRequest: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string" },
            text: { type: "string", description: "Required when attachments is empty" },
            cwd: { type: "string", description: "Required when attachments is set" },
            attachments: {
              type: "array",
              maxItems: 8,
              items: { $ref: "#/components/schemas/ChatAttachment" },
            },
          },
        },
        CancelChatRequest: {
          type: "object",
          required: ["sessionId"],
          properties: {
            sessionId: { type: "string" },
          },
        },
        SteerResult: {
          type: "object",
          properties: {
            outcome: { type: "string" },
            text: { type: "string", description: "Text actually injected" },
          },
        },
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
      },
    },
    security: [{ AgentGatewayToken: [] }],
    paths: {
      "/api/v1/chat/create": {
        post: {
          operationId: "chatCreate",
          summary: "Create a session and stream the first turn",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CreateChatRequest" } },
            },
          },
          responses: {
            "200": {
              description: "SSE stream (events: message, result, done, error)",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/v1/chat/resume": {
        post: {
          operationId: "chatResume",
          summary: "Resume a session with a new prompt and stream",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ResumeChatRequest" } },
            },
          },
          responses: {
            "200": {
              description: "SSE stream",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "409": {
              description: "Session already has an active run. Use connect, steer, or cancel first.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      statusCode: { type: "integer", example: 409 },
                      message: { type: "string" },
                      error: { type: "string", example: "Conflict" },
                      code: { type: "string", example: "session_busy" },
                      sessionId: { type: "string" },
                      runId: { type: "string" },
                    },
                  },
                },
              },
            },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/v1/chat/connect": {
        post: {
          operationId: "chatConnect",
          summary: "Reconnect SSE to an in-flight run (replay + live)",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ConnectChatRequest" } },
            },
          },
          responses: {
            "200": {
              description: "SSE stream",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "404": { description: "No active run", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/v1/chat/steer": {
        post: {
          operationId: "chatSteer",
          summary: "Inject text into the active run",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/SteerChatRequest" } },
            },
          },
          responses: {
            "200": {
              description: "Steer outcome",
              content: { "application/json": { schema: { $ref: "#/components/schemas/SteerResult" } } },
            },
            "404": { description: "No active run", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
      "/api/v1/chat/cancel": {
        post: {
          operationId: "chatCancel",
          summary: "Cancel the active run for a session",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CancelChatRequest" } },
            },
          },
          responses: {
            "200": {
              description: "Cancelled",
              content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
            },
            "404": { description: "No active run", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "401": { description: "Unauthorized", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },
    },
  };
}
