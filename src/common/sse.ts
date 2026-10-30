import type { ServerResponse } from "node:http";
import type { ActiveRun, RunEventBus } from "../bus/bus.service.js";
import type { BusEvent } from "../protocol/types.js";

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
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

/** Replay buffered events then live updates until done / client disconnect. */
export function pipeRunToSse(
  res: ServerResponse,
  bus: RunEventBus,
  run: ActiveRun,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(": ok\n\n");

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
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
