// npm run dev: start Temporal (Docker), the Worker and the API.
//
// The Worker is the "background service" that runs automatic offers. If it stops, the API and the
// dashboard keep running so staff can SEE that it stopped (banner + paused status lines), this console
// says so clearly, and the Worker is restarted automatically with backoff (2 s, 5 s, 10 s, then 30 s).
// Ctrl+C stops everything (a second Ctrl+C stops it straight away).
//
// Each child runs in its own process group (detached), and signals go to the whole group: `tsx` starts
// the real Worker as a grandchild, and killing only the tsx wrapper would leave that Worker running and
// polling the task queue, where it would look "healthy" to the dashboard.
import { connect } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve("tsx/cli");
const PORT = process.env.PORT ?? "3000";
const BACKOFF_MS = [2_000, 5_000, 10_000, 30_000];
/** A Worker that ran this long before stopping counts as a fresh failure (backoff starts again at 2 s). */
const STABLE_AFTER_MS = 60_000;

const compose = spawnSync("docker", ["compose", "up", "-d", "temporal"], { stdio: "inherit" });
if (compose.status !== 0) {
  console.error("\nCould not start Temporal. Is Docker Desktop running?");
  process.exit(compose.status ?? 1);
}

async function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Temporal did not become ready on port ${port}.`);
}

await waitForPort(7233);

let shuttingDown = false;
const running = new Map(); // name -> child process
const timers = new Set();

const stamp = () => new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
const banner = (lines) => {
  const width = Math.max(...lines.map((l) => l.length));
  const rule = "=".repeat(width + 4);
  console.error(`\n${rule}\n${lines.map((l) => `| ${l.padEnd(width)} |`).join("\n")}\n${rule}\n`);
};

/**
 * Run a process and restart it with backoff whenever it exits (unless we're shutting down).
 * describe(code, signal, delayMs) prints what happened.
 */
function supervise(name, script, describe) {
  let failures = 0;
  const start = () => {
    if (shuttingDown) return;
    const startedAt = Date.now();
    const child = spawn(process.execPath, [TSX_CLI, script], { stdio: "inherit", env: { ...process.env, PORT }, detached: true });
    running.set(name, child);
    child.once("exit", (code, signal) => {
      running.delete(name);
      // The tsx wrapper is gone: make sure the real process under it is too (nothing left polling).
      signalGroup(child, "SIGKILL");
      if (shuttingDown) return;
      if (Date.now() - startedAt >= STABLE_AFTER_MS) failures = 0;
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)];
      failures++;
      describe(code, signal, delay, failures);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (shuttingDown) return;
        console.log(`[${stamp()}] Restarting the ${name} (try ${failures})…`);
        start();
      }, delay);
      timers.add(timer);
    });
  };
  start();
}

supervise("Worker", "src/worker.ts", (code, signal, delay, tries) =>
  banner([
    `[${stamp()}] THE WORKER STOPPED (${signal ?? `exit code ${code}`}).`,
    "Automatic offers are NOT running: no texts are sent and no reply windows time out.",
    "The dashboard stays up and shows a banner; openings are safe and continue when it's back.",
    `Restarting the Worker in ${delay / 1000} s${tries > 1 ? ` (it has stopped ${tries} times in a row)` : ""}…`,
  ]),
);
supervise("API", "src/api.ts", (code, signal, delay) =>
  banner([
    `[${stamp()}] The dashboard/API stopped (${signal ?? `exit code ${code}`}).`,
    "The Worker keeps running automatic offers meanwhile.",
    `Restarting the API in ${delay / 1000} s…`,
  ]),
);

/** Signal a child's whole process group (the tsx wrapper and the real Worker/API under it). */
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function forceKillAll() {
  for (const child of running.values()) signalGroup(child, "SIGKILL");
}

async function shutdown() {
  if (shuttingDown) {
    console.log("\nStopping now.");
    forceKillAll();
    process.exit(1);
  }
  shuttingDown = true;
  console.log("\nStopping the Worker and the API… (Ctrl+C again to stop straight away)");
  for (const timer of timers) clearTimeout(timer);
  const exits = [...running.values()].map(
    (child) =>
      new Promise((resolve) => {
        child.once("exit", resolve);
        signalGroup(child, "SIGTERM");
      }),
  );
  const forceKill = setTimeout(forceKillAll, 8_000);
  await Promise.all(exits);
  clearTimeout(forceKill);
  console.log("Stopped. Temporal is still running in Docker (npm run stop to stop it).");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// If this script dies some other way, don't leave a Worker behind polling the task queue.
process.on("exit", forceKillAll);

console.log("\nJuniper Salon is launching:");
console.log(`  App:         http://localhost:${PORT}`);
console.log("  Temporal UI: http://localhost:8233");
console.log("  If the Worker stops, it is restarted automatically and the dashboard shows it. Ctrl+C stops everything.\n");
