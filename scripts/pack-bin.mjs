#!/usr/bin/env node
/**
 * Self-extracting launcher embedding tsc dist + public/ + production node_modules.
 * Nest stays unbundled (CJS packages + emitDecoratorMetadata). Host needs Node ≥ 22.13, bash, tar.
 * First run unpacks to ~/.cache/agent-gateway/<ver>/.
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
import { create as tarCreate } from "tar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "release");
const stageDir = path.join(outDir, ".stage");
const binName = "agent-gateway";
const binPath = path.join(outDir, binName);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
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

const distMain = path.join(root, "dist/main.js");
const webSrc = path.join(root, "dist/public");
if (!existsSync(distMain)) {
  console.error(`missing ${distMain}`);
  process.exit(1);
}
if (!existsSync(webSrc)) {
  console.error(`missing web assets: ${webSrc}`);
  process.exit(1);
}

console.log("→ stage payload (tsc dist, no esbuild bundle)");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

cpSync(path.join(root, "dist"), path.join(stageDir, "dist"), { recursive: true });

writeFileSync(
  path.join(stageDir, "package.json"),
  `${JSON.stringify(
    {
      name: "agent-gateway",
      version,
      private: true,
      type: "module",
      dependencies: pkg.dependencies,
    },
    null,
    2,
  )}\n`,
);

console.log("→ install production dependencies");
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
  ["dist", "package.json", "node_modules"],
);

const launcher = `#!/usr/bin/env bash
set -euo pipefail
VERSION=${JSON.stringify(version)}
MARKER=${JSON.stringify(MARKER)}
CACHE="\${AGENT_GATEWAY_HOME:-\${XDG_CACHE_HOME:-$HOME/.cache}/agent-gateway/\$VERSION}"
APP="\$CACHE/dist/main.js"

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

export AGENT_GATEWAY_WEB_ROOT="\$CACHE/dist/public"
cd "\$CACHE"
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
