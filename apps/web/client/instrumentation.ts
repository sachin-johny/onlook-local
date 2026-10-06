// This guard prevents the Edge Runtime from crashing on Node.js-only imports.
// Next.js 16 (Turbopack) evaluates this module in Edge first; the node: imports
// below are only safe under the Node.js runtime which is checked in register().
let _child_process: typeof import("node:child_process") | undefined;
let _path: typeof import("node:path") | undefined;

try {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    _child_process = require("node:child_process");
    _path = require("node:path");
  }
} catch { }

let started = false; // hot-reload guard

async function pollHealth(port: number, retries = 20, interval = 150): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch { }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

export async function register() {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.ONLOOK_LOCAL_MODE !== "true" ||
    started
  ) return;

  started = true;

  const port = Number(process.env.ONLOOK_PTY_PORT ?? 3210);
  const projectsDir = _path!.resolve(
    process.cwd(),
    process.env.ONLOOK_LOCAL_PROJECTS_DIR ?? "./local-projects"
  );

  // Production-safe path: bun-server.ts is relative to the source root,
  // not __dirname (which shifts in .next/server/ after build)
  const scriptPath = _path!.resolve(process.cwd(), "src/server/pty/bun-server.ts");

  const child = _child_process!.spawn("bun", ["run", scriptPath], {
    env: {
      ...process.env,
      PTY_PORT: String(port),
      PTY_PROJECTS_DIR: projectsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (d) => console.log("[pty]", d.toString().trim()));
  child.stderr?.on("data", (d) => console.error("[pty]", d.toString().trim()));
  child.on("exit", (code) => console.warn(`[pty] process exited with code ${code}`));

  const ready = await pollHealth(port);
  if (!ready) {
    console.error("[pty] server failed to start after 3s — terminal unavailable");
    child.kill();
    started = false; // allow retry on next reload
    return;
  }

  console.log(`[pty] server ready on port ${port}`);

  // Ensure the PTY child is killed when this process exits.
  // The child is not detached and shares our process group, so it would
  // be cleaned up by the OS regardless — but a graceful SIGTERM lets the
  // Bun server run its own shutdown handler (killing PTYs, cleaning temp dirs).
  //
  // Use dynamic property access to evade Turbopack's Edge Runtime static
  // analysis, which flags `process.on(...)` even though this entire function
  // returns early for non-Node.js runtimes.
  const teardown = () => { child.kill("SIGTERM"); };
  void (typeof process === "object" && process?.on?.("SIGTERM", teardown));
  void (typeof process === "object" && process?.on?.("SIGINT", teardown));
}
