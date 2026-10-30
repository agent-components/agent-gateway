import type { SDKMessage } from "@cursor/sdk";
import type { BusEvent, StreamMessage } from "../../protocol/types.js";

/**
 * Map Cursor SDKMessage into the unified stream envelope.
 */
function mapSdkMessage(
  event: SDKMessage,
  sessionId: string,
  runId: string,
): StreamMessage {
  const base = { sessionId, runId };
  const type = event.type as StreamMessage["type"];

  switch (event.type) {
    case "assistant":
      return {
        ...base,
        type: "assistant",
        message: (event as { message?: unknown }).message,
      };
    case "user":
      return {
        ...base,
        type: "user",
        message: (event as { message?: unknown }).message,
      };
    case "thinking":
      return {
        ...base,
        type: "thinking",
        text: (event as { text?: string }).text,
        thinking_duration_ms: (event as { thinking_duration_ms?: number }).thinking_duration_ms,
      };
    case "tool_call":
      return {
        ...base,
        type: "tool_call",
        call_id: (event as { call_id?: string }).call_id,
        name: (event as { name?: string }).name,
        status: (event as { status?: string }).status,
        args: (event as { args?: unknown }).args,
        result: (event as { result?: unknown }).result,
      };
    case "status":
      return {
        ...base,
        type: "status",
        status: (event as { status?: string }).status,
        message: (event as { message?: string }).message,
      };
    case "task":
      return {
        ...base,
        type: "task",
        status: (event as { status?: string }).status,
        text: (event as { text?: string }).text,
      };
    case "usage":
      return {
        ...base,
        type: "usage",
        usage: (event as { usage?: unknown }).usage,
      };
    case "system":
      return {
        ...base,
        type: "system",
        subtype: (event as { subtype?: string }).subtype,
        model: (event as { model?: unknown }).model,
        tools: (event as { tools?: unknown }).tools,
      };
    default:
      return {
        ...base,
        type: type || "status",
        raw: event,
      };
  }
}

export async function* sdkStreamToBusEvents(
  stream: AsyncIterable<SDKMessage>,
  sessionId: string,
  runId: string,
  wait: () => Promise<{
    status: string;
    result?: string;
    error?: { message: string; code?: string };
    usage?: Record<string, number>;
    durationMs?: number;
    model?: { id?: string } | string;
  }>,
): AsyncGenerator<BusEvent> {
  try {
    for await (const event of stream) {
      yield { kind: "message", data: mapSdkMessage(event, sessionId, runId) };
    }
    const result = await wait();
    const model =
      typeof result.model === "string" ? result.model : result.model?.id;
    yield {
      kind: "result",
      data: {
        sessionId,
        runId,
        status: (result.status as "finished" | "error" | "cancelled") || "finished",
        text: result.result,
        error: result.error,
        usage: result.usage,
        durationMs: result.durationMs,
        model,
      },
    };
    yield { kind: "done" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { kind: "error", data: { message } };
    yield { kind: "done" };
  }
}
