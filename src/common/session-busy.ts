export const SESSION_BUSY_CODE = "session_busy";

export type SessionBusyError = Error & {
  status: number;
  code: typeof SESSION_BUSY_CODE;
  sessionId: string;
  runId?: string;
};

export function sessionBusyMessage(sessionId: string, runId?: string): string {
  const run = runId ? `（run ${runId}）` : "";
  return `会话 ${sessionId} 正在进行中${run}，无法 resume。请改用 POST /api/v1/chat/connect 订阅当前输出，或用 POST /api/v1/chat/steer 追加内容；需要重新开始时请先 POST /api/v1/chat/cancel。`;
}

export function sessionBusyError(sessionId: string, runId?: string): SessionBusyError {
  const err = new Error(sessionBusyMessage(sessionId, runId)) as SessionBusyError;
  err.status = 409;
  err.code = SESSION_BUSY_CODE;
  err.sessionId = sessionId;
  if (runId) err.runId = runId;
  return err;
}

export function isSessionBusyError(err: unknown): err is SessionBusyError {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { code?: unknown }).code === SESSION_BUSY_CODE
  );
}
