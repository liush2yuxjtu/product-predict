import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export type LocalSandboxOptions = {
  /** Command or command template used to invoke the local sandbox runtime. */
  runtime: string;
  /** Command that starts the target app inside the sandbox. */
  command: string;
  /** Project directory mounted/used by sandbox-runtime. */
  cwd: string;
  /** Host Playwright should connect to. */
  host: string;
  /** First port reserved for the probe sandbox; agents use portBase + index + 1. */
  portBase: number;
  /** HTTP path polled until the sandboxed app is ready. */
  readyPath: string;
  /** Maximum time to wait for each sandboxed app to become reachable. */
  readyTimeoutMs: number;
};

export type LocalSandboxInstance = {
  host: string;
  port: number;
  origin: string;
  stop: () => Promise<void>;
};

type SandboxSession = {
  agentId: string;
  runDir: string;
  port: number;
  log?: (line: string) => void;
};

export function readLocalSandboxOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): LocalSandboxOptions | null {
  const runtime = trim(env.PP_SANDBOX_RUNTIME);
  const command = trim(env.PP_SANDBOX_COMMAND);

  if (!runtime && !command) return null;
  if (!runtime || !command) {
    throw new Error("set both PP_SANDBOX_RUNTIME and PP_SANDBOX_COMMAND to enable local sandbox isolation");
  }

  return {
    runtime,
    command,
    cwd: resolve(env.PP_SANDBOX_CWD || process.cwd()),
    host: trim(env.PP_SANDBOX_HOST) || "127.0.0.1",
    portBase: positiveInt("PP_SANDBOX_PORT_BASE", env.PP_SANDBOX_PORT_BASE, 39_000),
    readyPath: readyPath(env.PP_SANDBOX_READY_PATH || "/"),
    readyTimeoutMs: positiveInt("PP_SANDBOX_READY_TIMEOUT_MS", env.PP_SANDBOX_READY_TIMEOUT_MS, 30_000),
  };
}

export function sandboxTargetUrl(originalTargetUrl: string, host: string, port: number): string {
  const original = new URL(originalTargetUrl);
  const origin = `http://${host}:${port}`;
  return new URL(`${original.pathname}${original.search}${original.hash}`, origin).toString();
}

export function buildSandboxLaunchCommand(options: LocalSandboxOptions, session: SandboxSession): string {
  const command = expandTemplate(options.command, options, session, undefined);
  const runtimeTemplate = hasCommandPlaceholder(options.runtime)
    ? options.runtime
    : `${options.runtime} run --cwd {cwd} -- {command}`;
  return expandTemplate(runtimeTemplate, options, session, command);
}

export async function startLocalSandbox(
  options: LocalSandboxOptions,
  session: SandboxSession
): Promise<LocalSandboxInstance> {
  const origin = `http://${options.host}:${session.port}`;
  const readyUrl = new URL(options.readyPath, origin).toString();
  const command = buildSandboxLaunchCommand(options, session);
  const logDir = join(session.runDir, "sandbox");
  const logPath = join(logDir, `${safeName(session.agentId)}.log`);

  await mkdir(logDir, { recursive: true });
  await writeFile(logPath, `$ ${command}\n`, "utf8");

  const child = spawn(command, {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOST: options.host,
      PORT: String(session.port),
      PP_SANDBOX_HOST: options.host,
      PP_SANDBOX_PORT: String(session.port),
      PP_SANDBOX_AGENT_ID: session.agentId,
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.stdout?.on("data", (buf: Buffer) => {
    void appendFile(logPath, buf).catch(() => {});
  });
  child.stderr?.on("data", (buf: Buffer) => {
    void appendFile(logPath, buf).catch(() => {});
  });

  try {
    await waitForReady(readyUrl, options.readyTimeoutMs, () => exited);
  } catch (e) {
    await stopChild(child).catch(() => {});
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox-runtime for ${session.agentId} did not become ready at ${readyUrl}: ${why}`);
  }

  session.log?.(`  [${session.agentId}] sandbox-runtime ready on ${origin}`);
  return {
    host: options.host,
    port: session.port,
    origin,
    stop: () => stopChild(child),
  };
}

async function waitForReady(
  readyUrl: string,
  timeoutMs: number,
  getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "not reached";

  while (Date.now() < deadline) {
    const exit = getExit();
    if (exit) {
      throw new Error(`process exited early (${exit.signal ?? exit.code ?? "unknown"})`);
    }

    try {
      const res = await fetch(readyUrl, { method: "GET", signal: AbortSignal.timeout(1000) });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }

    await delay(500);
  }

  throw new Error(`timed out after ${timeoutMs}ms (${last})`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  const ac = new AbortController();
  child.kill("SIGTERM");
  const exited = once(child, "exit").then(() => ac.abort());
  const killed = delay(5_000, undefined, { signal: ac.signal })
    .then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    })
    .catch(() => {});
  await Promise.race([exited, killed]);
}

function expandTemplate(
  template: string,
  options: LocalSandboxOptions,
  session: SandboxSession,
  command: string | undefined
): string {
  const values: Record<string, string> = {
    agentId: session.agentId,
    command: command ?? "",
    cwd: shellQuote(options.cwd),
    cwdRaw: options.cwd,
    host: options.host,
    port: String(session.port),
    readyPath: options.readyPath,
    runDir: shellQuote(session.runDir),
    runDirRaw: session.runDir,
    start: command ?? "",
  };
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key: string) => values[key] ?? match);
}

function hasCommandPlaceholder(template: string): boolean {
  return /\{(?:command|start)\}/.test(template);
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function readyPath(path: string): string {
  const trimmed = path.trim() || "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function trim(value: string | undefined): string {
  return (value || "").trim();
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}
