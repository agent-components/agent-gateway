import {
  Body,
  Controller,
  Inject,
  Post,
  Res,
  UseGuards,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import { RunEventBus } from "../bus/bus.service.js";
import { prepareAttachments } from "../common/attachments.js";
import { pipeRunToSse } from "../common/sse.js";
import { TokenGuard } from "../common/token.guard.js";
import { AGENT_PROVIDER, type AgentHttpProvider } from "../config/tokens.js";
import type {
  CancelChatRequest,
  ConnectChatRequest,
  CreateChatRequest,
  ResumeChatRequest,
  SteerChatRequest,
} from "../protocol/types.js";

function hasAttachments(body: { attachments?: unknown[] } | undefined): boolean {
  return Array.isArray(body?.attachments) && body.attachments.length > 0;
}

function rethrowClientError(err: unknown): never {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status: unknown }).status)
      : NaN;
  if (err instanceof Error && status >= 400 && status < 500) {
    throw new HttpException(err.message, status);
  }
  throw err;
}

@Controller("api/v1/chat")
@UseGuards(TokenGuard)
export class ChatController {
  constructor(
    // Explicit token: esbuild/ESM bundles drop emitDecoratorMetadata for class types.
    @Inject(RunEventBus) private readonly bus: RunEventBus,
    @Inject(AGENT_PROVIDER) private readonly provider: AgentHttpProvider,
  ) {}

  @Post("create")
  async create(@Body() body: CreateChatRequest, @Res() res: Response): Promise<void> {
    if (!body?.model || !body?.cwd) {
      throw new HttpException("model and cwd are required", HttpStatus.BAD_REQUEST);
    }
    if (!body.prompt?.trim() && !hasAttachments(body)) {
      throw new HttpException("prompt or attachments are required", HttpStatus.BAD_REQUEST);
    }
    let stream;
    try {
      stream = await this.provider.create(body, {});
    } catch (err) {
      rethrowClientError(err);
    }
    const run = this.bus.attach(stream);
    await pipeRunToSse(res, this.bus, run);
  }

  @Post("resume")
  async resume(@Body() body: ResumeChatRequest, @Res() res: Response): Promise<void> {
    if (!body?.sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }
    if (!body.prompt?.trim() && !hasAttachments(body)) {
      throw new HttpException("prompt or attachments are required", HttpStatus.BAD_REQUEST);
    }
    let stream;
    try {
      stream = await this.provider.resume(body, {});
    } catch (err) {
      rethrowClientError(err);
    }
    const run = this.bus.attach(stream);
    await pipeRunToSse(res, this.bus, run);
  }

  @Post("connect")
  async connect(@Body() body: ConnectChatRequest, @Res() res: Response): Promise<void> {
    if (!body?.sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }
    const run = body.runId
      ? this.bus.getByRun(body.runId)
      : this.bus.getBySession(body.sessionId);
    if (!run || (body.runId && run.sessionId !== body.sessionId)) {
      throw new HttpException("No active run for session", HttpStatus.NOT_FOUND);
    }
    await pipeRunToSse(res, this.bus, run);
  }

  @Post("steer")
  async steer(@Body() body: SteerChatRequest) {
    if (!body?.sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }
    if (!body.text?.trim() && !hasAttachments(body)) {
      throw new HttpException("text or attachments are required", HttpStatus.BAD_REQUEST);
    }
    let text = body.text ?? "";
    if (hasAttachments(body)) {
      if (!body.cwd?.trim() && !process.env.AGENT_GATEWAY_UPLOAD_DIR?.trim()) {
        throw new HttpException(
          "cwd is required when uploading files unless AGENT_GATEWAY_UPLOAD_DIR is set",
          HttpStatus.BAD_REQUEST,
        );
      }
      try {
        const prepared = await prepareAttachments(body.cwd ?? "", text, body.attachments, {
          inlineImages: false,
        });
        text = prepared.text;
      } catch (err) {
        rethrowClientError(err);
      }
    }
    const active = this.bus.getBySession(body.sessionId);
    if (active?.steer && !active.finished) {
      const result = await active.steer(text);
      return { ...result, text };
    }
    const result = await this.provider.steer({ ...body, text }, {});
    return { ...result, text };
  }

  @Post("cancel")
  async cancel(@Body() body: CancelChatRequest) {
    if (!body?.sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }
    const active = this.bus.getBySession(body.sessionId);
    if (active?.cancel && !active.finished) {
      await active.cancel();
      return { ok: true };
    }
    await this.provider.cancel(body, {});
    return { ok: true };
  }
}
