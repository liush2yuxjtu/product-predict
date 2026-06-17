import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSandboxLaunchCommand,
  readLocalSandboxOptionsFromEnv,
  sandboxTargetUrl,
  type LocalSandboxOptions,
} from "../sandbox.js";

const base: LocalSandboxOptions = {
  runtime: "sandbox-runtime",
  command: "npm run dev -- --host {host} --port {port}",
  cwd: "/tmp/product app",
  host: "127.0.0.1",
  portBase: 39_000,
  readyPath: "/healthz",
  readyTimeoutMs: 10_000,
};

test("sandbox env is opt-in", () => {
  assert.equal(readLocalSandboxOptionsFromEnv({}), null);
});

test("sandbox env requires runtime and command together", () => {
  assert.throws(
    () => readLocalSandboxOptionsFromEnv({ PP_SANDBOX_RUNTIME: "sandbox-runtime" }),
    /PP_SANDBOX_RUNTIME and PP_SANDBOX_COMMAND/
  );
});

test("sandbox env parses runtime options", () => {
  const opts = readLocalSandboxOptionsFromEnv({
    PP_SANDBOX_RUNTIME: "sandbox-runtime",
    PP_SANDBOX_COMMAND: "npm run dev -- --port {port}",
    PP_SANDBOX_CWD: "/tmp/app",
    PP_SANDBOX_HOST: "127.0.0.2",
    PP_SANDBOX_PORT_BASE: "41000",
    PP_SANDBOX_READY_PATH: "ready",
    PP_SANDBOX_READY_TIMEOUT_MS: "1234",
  });

  assert.deepEqual(opts, {
    runtime: "sandbox-runtime",
    command: "npm run dev -- --port {port}",
    cwd: "/tmp/app",
    host: "127.0.0.2",
    portBase: 41_000,
    readyPath: "/ready",
    readyTimeoutMs: 1234,
  });
});

test("default sandbox-runtime command wraps the target command", () => {
  const cmd = buildSandboxLaunchCommand(base, {
    agentId: "a01",
    runDir: "/tmp/run 1",
    port: 39_001,
  });

  assert.equal(
    cmd,
    "sandbox-runtime run --cwd '/tmp/product app' -- npm run dev -- --host 127.0.0.1 --port 39001"
  );
});

test("runtime template can fully control sandbox invocation", () => {
  const cmd = buildSandboxLaunchCommand(
    { ...base, runtime: "sandbox-runtime exec --workdir {cwd} --agent {agentId} -- {command}" },
    { agentId: "a02", runDir: "/tmp/run", port: 39_002 }
  );

  assert.equal(
    cmd,
    "sandbox-runtime exec --workdir '/tmp/product app' --agent a02 -- npm run dev -- --host 127.0.0.1 --port 39002"
  );
});

test("sandbox target URL preserves path, query, and hash while swapping origin", () => {
  assert.equal(
    sandboxTargetUrl("http://localhost:3000/products?q=x#reviews", "127.0.0.1", 39_001),
    "http://127.0.0.1:39001/products?q=x#reviews"
  );
});
