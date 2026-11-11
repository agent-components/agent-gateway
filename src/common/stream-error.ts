export function explainStreamError(err: unknown): { message: string; code?: string } {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "terminated") {
    return {
      code: "terminated",
      message:
        "连接被中断（terminated）。带图片时，模型开始输出前会有一段没有数据的空档，中间代理会关掉这条空闲连接。请用 POST /api/v1/chat/connect 查看会话是否仍在运行。",
    };
  }
  return { message };
}
