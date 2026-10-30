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
    if (!body?.prompt || !body?.model || !body?.cwd) {
      throw new HttpException("prompt, model, and cwd are required", HttpStatus.BAD_REQUEST);
    }
    const stream = await this.provider.create(body, {});
    const run = this.bus.attach(stream);
    await pipeRunToSse(res, this.bus, run);
  }

  @Post("resume")
  async resume(@Body() body: ResumeChatRequest, @Res() res: Response): Promise<void> {
    if (!body?.sessionId || !body?.prompt) {
      throw new HttpException("sessionId and prompt are required", HttpStatus.BAD_REQUEST);
    }
    const stream = await this.provider.resume(body, {});
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
    if (!body?.sessionId || !body?.text) {
      throw new HttpException("sessionId and text are required", HttpStatus.BAD_REQUEST);
    }
    const active = this.bus.getBySession(body.sessionId);
    if (active?.steer && !active.finished) {
      return active.steer(body.text);
    }
    return this.provider.steer(body, {});
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
