import type { ServerResponse } from "node:http";
import type { ActiveRun, RunEventBus } from "../bus/bus.service.js";
import type { BusEvent } from "../protocol/types.js";

const HEARTBEAT_MS = 15_000;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
  "Access-Control-Allow-Origin": "*",
};

function responseClosed(res: ServerResponse): boolean {
  return res.writableEnded || res.destroyed;
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
}

function writeComment(res: ServerResponse, text: string): boolean {
  if (responseClosed(res)) return false;
  try {
    res.write(`: ${text}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function busEventToSse(res: ServerResponse, event: BusEvent): void {
  switch (event.kind) {
    case "message":
      writeSseEvent(res, "message", event.data);
      break;
    case "result":
      writeSseEvent(res, "result", event.data);
      break;
    case "done":
      writeSseEvent(res, "done", {});
      break;
    case "error":
      writeSseEvent(res, "error", event.data);
      break;
  }
}

/**
 * Send SSE headers and a comment immediately, then a comment every 15s.
 * Image uploads and tool calls can sit silent longer than a proxy's read timeout.
 */
export function openSse(res: ServerResponse): () => void {
  res.socket?.setTimeout(0);
  res.socket?.setNoDelay(true);
  if (!res.headersSent) {
    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders();
  }
  writeComment(res, "ok");

  const timer = setInterval(() => {
    if (!writeComment(res, "ping")) clearInterval(timer);
  }, HEARTBEAT_MS);
  timer.unref();
  const stop = () => clearInterval(timer);
  res.on("close", stop);
  return stop;
}

export function endSseWithError(
  res: ServerResponse,
  stopHeartbeat: () => void,
  data: { message: string; code?: string; sessionId?: string; runId?: string },
): void {
  stopHeartbeat();
  if (responseClosed(res)) return;
  try {
    writeSseEvent(res, "error", data);
    writeSseEvent(res, "done", {});
    res.end();
  } catch {
    /* ignore */
  }
}

/** Replay buffered events then live updates until done / client disconnect. */
export function pipeRunToSse(
  res: ServerResponse,
  bus: RunEventBus,
  run: ActiveRun,
  stopHeartbeat?: () => void,
): Promise<void> {
  const stop = stopHeartbeat ?? openSse(res);
  if (responseClosed(res)) {
    stop();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      stop();
      unsubscribe();
      try {
        res.end();
      } catch {
        /* ignore */
      }
      resolve();
    };

    const onEvent = (event: BusEvent) => {
      if (settled) return;
      try {
        busEventToSse(res, event);
      } catch {
        finish();
        return;
      }
      if (event.kind === "done") finish();
    };

    unsubscribe = bus.subscribe(run, onEvent);
    res.on("close", finish);
  });
}
