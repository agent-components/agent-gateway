import { Injectable } from "@nestjs/common";
import type { BusEvent, RunStream, SteerResult } from "../protocol/types.js";

export interface ActiveRun {
  sessionId: string;
  runId: string;
  buffer: BusEvent[];
  listeners: Set<(event: BusEvent) => void>;
  finished: boolean;
  cancel?: () => Promise<void>;
  steer?: (text: string) => Promise<SteerResult>;
  dispose?: () => Promise<void>;
}

/**
 * In-process run event bus: buffers events for replay and fans out to SSE subscribers.
 */
@Injectable()
export class RunEventBus {
  private readonly bySession = new Map<string, ActiveRun>();
  private readonly byRun = new Map<string, ActiveRun>();

  getBySession(sessionId: string): ActiveRun | undefined {
    return this.bySession.get(sessionId);
  }

  getByRun(runId: string): ActiveRun | undefined {
    return this.byRun.get(runId);
  }

  attach(stream: RunStream): ActiveRun {
    const existing = this.bySession.get(stream.sessionId);
    if (existing && !existing.finished) {
      throw new Error(`Session ${stream.sessionId} already has an active run`);
    }

    const run: ActiveRun = {
      sessionId: stream.sessionId,
      runId: stream.runId,
      buffer: [],
      listeners: new Set(),
      finished: false,
      cancel: stream.cancel,
      steer: stream.steer,
      dispose: stream.dispose,
    };

    this.bySession.set(stream.sessionId, run);
    this.byRun.set(stream.runId, run);

    void this.pump(stream, run);
    return run;
  }

  private async pump(stream: RunStream, run: ActiveRun): Promise<void> {
    try {
      for await (const event of stream.events) {
        this.publish(run, event);
        if (event.kind === "done" || event.kind === "error") break;
      }
      if (!run.finished) this.publish(run, { kind: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.publish(run, { kind: "error", data: { message } });
      this.publish(run, { kind: "done" });
    } finally {
      run.finished = true;
      try {
        await run.dispose?.();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (this.bySession.get(run.sessionId) === run) {
          this.bySession.delete(run.sessionId);
        }
        this.byRun.delete(run.runId);
      }, 30_000);
    }
  }

  private publish(run: ActiveRun, event: BusEvent): void {
    run.buffer.push(event);
    for (const listener of run.listeners) {
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
    if (event.kind === "done") run.finished = true;
  }

  subscribe(run: ActiveRun, onEvent: (event: BusEvent) => void): () => void {
    for (const event of run.buffer) onEvent(event);
    if (run.finished) return () => undefined;
    run.listeners.add(onEvent);
    return () => {
      run.listeners.delete(onEvent);
    };
  }
}
