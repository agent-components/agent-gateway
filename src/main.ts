#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
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

  const app = await NestFactory.create(
    AppModule.register({ cwd, token }),
    { logger: ["error", "warn", "log"] },
  );

  app.enableCors({
    origin: "*",
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "OPTIONS"],
  });

  await app.listen(port, host);

  const url = `http://${host}:${port}`;
  console.log("");
  console.log("  agent-gateway");
  console.log(`  UI      ${url}`);
  console.log(`  OpenAPI ${url}/openapi.json`);
  console.log(`  cwd    ${cwd}`);
  console.log(`  token  ${token}`);
  console.log("");
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
