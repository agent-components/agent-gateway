#!/usr/bin/env node
/**
 * Single self-extracting executable embedding app + public/ + node_modules.
 * Host needs Node >= 22.13, bash, tar. First run unpacks to ~/.cache/agent-gateway/<ver>/.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { create as tarCreate } from "tar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "release");
const stageDir = path.join(outDir, ".stage");
const binName = "agent-gateway";
const binPath = path.join(outDir, binName);
const webSrc = path.join(root, "dist/public");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const sdkVersion = pkg.dependencies["@cursor/sdk"];
const MARKER = "__AGENT_GATEWAY_ARCHIVE__";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    ...opts,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("→ build");
run("pnpm", ["build"]);

if (!existsSync(webSrc)) {
  console.error(`missing web assets: ${webSrc}`);
  process.exit(1);
}

console.log("→ stage payload");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: [path.join(root, "src/main.ts")],
  outfile: path.join(stageDir, "app.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // @cursor/sdk: installed into the payload. Nest optional peers are
  // lazy-required and unused by this app — leave unresolved at runtime.
  external: [
    "@cursor/sdk",
    "@cursor/sdk/*",
    "@nestjs/microservices",
    "@nestjs/microservices/*",
    "@nestjs/websockets",
    "@nestjs/websockets/*",
    "@fastify/static",
    "class-validator",
    "class-transformer",
  ],
  logLevel: "info",
});

cpSync(webSrc, path.join(stageDir, "public"), { recursive: true });
writeFileSync(
  path.join(stageDir, "package.json"),
  `${JSON.stringify(
    {
      name: "agent-gateway",
      version,
      private: true,
      type: "module",
      dependencies: { "@cursor/sdk": sdkVersion },
    },
    null,
    2,
  )}\n`,
);

console.log("→ install @cursor/sdk");
run("npm", ["install", "--omit=dev", "--no-fund", "--no-audit"], {
  cwd: stageDir,
});

console.log("→ compress payload");
mkdirSync(outDir, { recursive: true });
const payloadPath = path.join(outDir, "payload.tgz");
await tarCreate(
  {
    gzip: true,
    file: payloadPath,
    cwd: stageDir,
  },
  ["app.mjs", "public", "package.json", "node_modules"],
);

const launcher = `#!/usr/bin/env bash
set -euo pipefail
VERSION=${JSON.stringify(version)}
MARKER=${JSON.stringify(MARKER)}
CACHE="\${AGENT_GATEWAY_HOME:-\${XDG_CACHE_HOME:-$HOME/.cache}/agent-gateway/\$VERSION}"
APP="\$CACHE/app.mjs"

if [[ ! -f "\$APP" ]]; then
  mkdir -p "\$CACHE"
  LINE="$(grep -an -m1 "^\$MARKER\$" "\$0" | cut -d: -f1)"
  if [[ -z "\$LINE" ]]; then
    echo "agent-gateway: embedded archive marker not found" >&2
    exit 1
  fi
  TMP="\$CACHE/.payload.tgz"
  tail -n +"\$((LINE + 1))" "\$0" > "\$TMP"
  tar -xzf "\$TMP" -C "\$CACHE"
  rm -f "\$TMP"
fi

export AGENT_GATEWAY_WEB_ROOT="\$CACHE/public"
exec node "\$APP" "\$@"

${MARKER}
`;

writeFileSync(binPath, launcher, "utf8");
appendFileSync(binPath, readFileSync(payloadPath));
chmodSync(binPath, 0o755);

rmSync(stageDir, { recursive: true, force: true });
rmSync(payloadPath, { force: true });

const sizeMb = (readFileSync(binPath).byteLength / (1024 * 1024)).toFixed(1);
console.log(`
Done.

  ${path.relative(root, binPath)}  (${sizeMb} MB)

One-click:
  CURSOR_API_KEY=… ./${binName}
`);
