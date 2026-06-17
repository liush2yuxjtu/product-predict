# Local sandbox-runtime mode

`pp run` can execute each parallel synthetic user against its own local sandboxed app instance. This keeps filesystem writes, in-memory state, cookies, local storage, and server-side test data isolated while Playwright continues to run in the default headless mode.

The feature is opt-in through environment variables, so existing local and cloud runs keep their current behavior.

## Required variables

```bash
export PP_SANDBOX_RUNTIME="sandbox-runtime"
export PP_SANDBOX_COMMAND="npm run dev -- --host {host} --port {port}"
```

With those values, each agent is launched with a command shaped like:

```bash
sandbox-runtime run --cwd '<cwd>' -- npm run dev -- --host 127.0.0.1 --port 39001
```

Then Playwright visits the same path as the original target URL, but on that agent's isolated port.

## Example

```bash
cd pp
PP_MOCK_LLM=1 \
PP_SANDBOX_RUNTIME="sandbox-runtime" \
PP_SANDBOX_COMMAND="npm run dev -- --host {host} --port {port}" \
PP_SANDBOX_CWD="/path/to/app-under-test" \
npm run dev -- run http://127.0.0.1:3000 --agents 4 --concurrency 4 --no-open
```

`http://127.0.0.1:3000` is used as the canonical target for reports and for preserving the path/query/hash. Each agent actually receives a sandbox URL such as `http://127.0.0.1:39001/...`, `http://127.0.0.1:39002/...`, and so on.

## Optional variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PP_SANDBOX_CWD` | current working directory | Directory passed to `sandbox-runtime run --cwd`. |
| `PP_SANDBOX_HOST` | `127.0.0.1` | Host Playwright connects to. |
| `PP_SANDBOX_PORT_BASE` | `39000` | Probe uses this port; agents use `base + index + 1`. |
| `PP_SANDBOX_READY_PATH` | `/` | HTTP path polled until the sandboxed app is ready. |
| `PP_SANDBOX_READY_TIMEOUT_MS` | `30000` | Per-sandbox readiness timeout. |

## Custom runtime templates

If your installed `sandbox-runtime` uses a different CLI shape, include `{command}` or `{start}` in `PP_SANDBOX_RUNTIME` and pp will treat it as the full launch template:

```bash
export PP_SANDBOX_RUNTIME="sandbox-runtime exec --workdir {cwd} --agent {agentId} -- {command}"
export PP_SANDBOX_COMMAND="npm run dev -- --host {host} --port {port}"
```

Available placeholders:

- `{command}` / `{start}`: expanded `PP_SANDBOX_COMMAND`
- `{cwd}` / `{cwdRaw}`
- `{host}`
- `{port}`
- `{agentId}`
- `{runDir}` / `{runDirRaw}`
- `{readyPath}`

Sandbox stdout/stderr is written under the run directory at `sandbox/<agentId>.log`.
