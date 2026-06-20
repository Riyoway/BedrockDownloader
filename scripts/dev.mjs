// Dynamic-port dev launcher.
//
// Finds a free TCP port, then starts `cargo tauri dev` with that port wired
// into BOTH sides so nothing collides with other apps you're developing:
//   * Vite reads it from the BDL_DEV_PORT env var (see vite.config.ts)
//   * Tauri's devUrl is overridden via a generated --config file
//
// Usage: npm run tauri:dev   (optionally PORT=1500 npm run tauri:dev to pin a base)

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Check a single host:port is bindable.
function canBind(port, host) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    // host: undefined -> Node binds the unspecified address (dual-stack).
    srv.listen(host ? { port, host } : { port });
  });
}

// A port is "free" only if it's bindable on every interface Vite may use
// (127.0.0.1 and the IPv6 ::1), so a server held on ::1 isn't mistaken as free.
async function findFreePort(start, end) {
  for (let p = start; p <= end; p++) {
    const v4 = await canBind(p, "127.0.0.1");
    const v6 = await canBind(p, "::1");
    if (v4 && v6) return p;
  }
  throw new Error(`no free port in ${start}-${end}`);
}

const base = Number(process.env.PORT) || 1420;
const port = await findFreePort(base, base + 200);

const overridePath = join(root, ".tauri.dev.conf.json");
writeFileSync(
  overridePath,
  JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }, null, 2),
);

const cleanup = () => {
  try {
    rmSync(overridePath, { force: true });
  } catch {
    /* ignore */
  }
};

console.log(`\n[bedrock-downloader] dev server on free port ${port}\n`);

const child = spawn("cargo", ["tauri", "dev", "--config", overridePath], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, BDL_DEV_PORT: String(port) },
});

const stop = (sig) => {
  if (!child.killed) child.kill(sig);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code) => {
  cleanup();
  process.exit(code ?? 0);
});
