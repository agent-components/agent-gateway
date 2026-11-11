#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";

function ensureToken(): string {
  if (process.env.AGENT_GATEWAY_TOKEN?.trim()) {
    return process.env.AGENT_GATEWAY_TOKEN.trim();
  }
  const token = randomBytes(16).toString("hex");
  process.env.AGENT_GATEWAY_TOKEN = token;
  return token;
}

async function bootstrap(): Promise<void> {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT || 6090);
  const cwd = process.env.AGENT_GATEWAY_CWD || process.cwd();
  const token = ensureToken();

  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register({ cwd, token }),
    { logger: ["error", "warn", "log"], bodyParser: false },
  );
  // Base64 attachments: 20MB of files expands to roughly 27MB of JSON.
  app.useBodyParser("json", { limit: "40mb" });
  app.useBodyParser("urlencoded", { limit: "40mb" });

  app.enableCors({
    origin: "*",
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "OPTIONS"],
  });

  await app.listen(port, host);
  const server = app.getHttpServer();
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  const url = `http://${host}:${port}`;
  console.log("");
  console.log("  agent-gateway");
  console.log(`  UI      ${url}`);
  console.log(`  OpenAPI ${url}/openapi.json`);
  console.log(`  cwd    ${cwd}`);
  if (process.env.AGENT_GATEWAY_UPLOAD_DIR?.trim()) {
    console.log(`  uploads ${process.env.AGENT_GATEWAY_UPLOAD_DIR.trim()}`);
  }
  console.log(`  token  ${token}`);
  console.log("");
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
