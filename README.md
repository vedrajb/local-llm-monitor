# Local LLM Monitor

A zero-dependency Node script (Node 18+) that monitors a local LLM hosting
platform alongside available GPU telemetry, and prints a plain-text snapshot on
an interval. No `npm install` — it uses only Node built-ins plus `nvidia-smi`
or the host telemetry exposed by AMD Lemonade.

The hosting platform is chosen at startup through a pluggable provider
(factory pattern). **Currently supported platforms:**

- **vLLM**
- **Ollama**
- **llama.cpp**
- **LM Studio**
- **AMD Lemonade**
- **OpenClaw**
- **Hermes Agent**

It reads:

- **GPU** (via `nvidia-smi`) — utilization, memory-bandwidth util, VRAM
  used/total, temperature, power.
- **vLLM** (via the OpenAI-compatible API + Prometheus `/metrics`) — the
  served model, request queue (running / waiting), KV-cache occupancy,
  prefix-cache hit rate, and token throughput (input + output).
- **Ollama** (via `/api/ps` + `server.log`) — the loaded model with its
  parameter size and quantization, bytes loaded vs bytes resident in VRAM,
  GPU/CPU **placement**, runtime context length, keep-alive expiry, busy
  **slots**, **KV-cache** occupancy, **prefix reuse** on the last prompt, the
  host-RAM **prompt cache**, and the prefill/decode throughput of the last
  completed request.
- **llama.cpp** (via Prometheus `/metrics` + `/props`, `/v1/models`, `/slots`) —
  the loaded model with its parameter count, quant and context vs trained
  context, requests processing / deferred, busy **slots**, **KV-cache**
  occupancy with the peak sequence length seen, cumulative **prefix reuse**, and
  a **live decode rate** differenced from `/slots` (llama.cpp's own gauges go
  blank mid-generation), falling back to the server's figure for the last
  completed request when idle. Requires
  `llama-server --metrics`; without it everything except throughput still
  reports, and the panel says which flag is missing. VRAM residency is not
  exposed over HTTP, so there is no **placement** figure — read the `nvidia-smi`
  VRAM gauge instead.
- **AMD Lemonade** (via `/api/v1/health`, `/api/v1/models`, `/api/v1/stats`,
  `/api/v1/system-stats`) — loaded model, recipe/device/context, busy and
  streaming state, prefix-cache reuse from the last request, last-request
  token counts and decode speed, plus CPU/RAM/GPU/VRAM/NPU host telemetry.
  Lemonade's stats endpoint reports the last completed request; it does not
  expose a queue or live KV-cache occupancy through this provider.
- **LM Studio** (via `/api/v1/models` + `lms log stream`) — loaded
  model instances, model size, parameter count, quantization/format, configured
  context length, maximum supported context, and the token counts/decode speed
  of completed requests observed after the monitor starts. It also shows
  server-log-inferred request activity from request start until completion. If
  `lms log stream` is unavailable, request activity and throughput remain
  unavailable rather than estimated.
- **OpenClaw** (via `/ready`, `openclaw gateway call sessions.list` and
  `openclaw status --json`) — gateway readiness, uptime and event-loop health,
  process, task and session counts, busy state, completed requests, and the last
  request's model, run time, tokens and outcome. OpenClaw is a gateway in front
  of a model, so it has no prefill/decode rate; monitor the model server for that.
- **Hermes Agent** (via `/health`, `/health/detailed` and a read-only
  `state.db`) — gateway state and failing readiness checks, active API runs,
  pending processes and delegations, today's API-server counters, busy state,
  and per-turn duration, tokens, API calls, tool calls and outcome for every
  surface including `hermes chat`. Hermes is an agent in front of a model, so
  it has no prefill/decode rate; monitor the model server for that.

## Documentation

- **[metrics.md](docs/metrics.md)** — where every number comes from, what it measures,
  and how to read it.
- **[keep-awake.md](docs/keep-awake.md)** — how the machine is kept from idle-sleeping
  during a live watch, and how to turn that off.
- **[ollama-setup-windows.md](docs/ollama-setup-windows.md)** — Ollama host setup.
- **[vllm-setup-windows-wsl2.md](docs/vllm-setup-windows-wsl2.md)** — vLLM host setup,
  including how to restart the server after a reboot.
- **[llamacpp-setup-windows.md](docs/llamacpp-setup-windows.md)** — llama.cpp host setup.
- **[lm-studio-setup-windows.md](docs/lm-studio-setup-windows.md)** — LM Studio and
  Qwen3 host setup.
- **[amd-lemonade-setup-windows.md](docs/amd-lemonade-setup-windows.md)** — AMD Lemonade host setup for
  `Qwen3-8B-GGUF-Q8_0` on
  Windows.
- **[openclaw-setup-windows.md](docs/openclaw-setup-windows.md)** — OpenClaw gateway
  setup on native Windows, including local model servers and Tailscale exposure.
- **[hermes-setup-windows.md](docs/hermes-setup-windows.md)** — Hermes Agent setup on
  native Windows, local model servers, and enabling the API server for monitoring.

### Generating load

An idle server reports zeros, so the queue, KV-cache and throughput panels only
become readable under load. Two ready-to-run helpers:

- **[10k-word-prompt.md](docs/10k-word-prompt.md)** — one long streaming request per
  platform (vLLM, Ollama, llama.cpp, LM Studio, AMD Lemonade), each with the right host and payload
  shape. Exercises **decode throughput** on a single sequence; runs for minutes.
- **[keep-llm-busy-prompt.txt](docs/keep-llm-busy-prompt.txt)** — 8-way concurrent
  request loop against vLLM until `Ctrl-C`. Use this to drive **slots / running
  vs waiting / KV-cache occupancy** off idle; a single request leaves the GPU
  mostly idle between decode steps and shows none of that.

## Run

```bash
npm start                  # live TUI, refreshes every 2s
npm run ollama             # live TUI, skip the platform prompt
npm run vllm               # live TUI, skip the platform prompt
npm run llamacpp           # live TUI, skip the platform prompt
npm run lmstudio           # live TUI, skip the platform prompt
npm run lemonade           # live TUI, skip the platform prompt
npm run plain              # live plain text instead of the TUI
npm run once               # two samples ~1.5s apart, prints, exits
npm run once:ollama        # single snapshot of a specific platform
npm run once:vllm
npm run once:llamacpp
npm run once:lmstudio
npm run once:lemonade
npm test                   # run the Node test suite
```

### Starting the servers being monitored

Two launchers in this repo bring a host up with the settings these metrics depend
on, so the monitor is not left reporting a server configured to hide them:

```bash
cmd /c start-llamacpp.bat   # foreground llama-server on :8080, Ctrl-C to stop
cmd /c start-ollama.bat     # restarts the Ollama tray app on :11434
```

- **[start-llamacpp.bat](start-llamacpp.bat)** passes `--metrics` (off by default,
  and the monitor needs it) and `-np 1` explicitly, because `-c` is the *total* KV
  pool divided across slots and `-np` defaults to auto — so a bare `-c 32768` can
  silently become four 8192-token slots. It checks PATH first and says so rather
  than failing with `not recognized`.
- **[start-ollama.bat](start-ollama.bat)** sets the five `OLLAMA_*` variables in
  process so the tray app inherits them, waits for `/api/version`, then prints
  what the server *actually* loaded from `server.log` — the check that catches a
  silently-failed restart, since `taskkill` can be denied without saying so.

Both are conveniences over the documented steps, not a replacement for them; the
reasoning for every value is in the setup docs.

Equivalent to running the script directly:

```bash
node src/index.js                    # live TUI
node src/index.js --plain            # live plain text
node src/index.js --once             # takes two samples ~1.5s apart, prints, exits
node src/index.js --platform ollama  # skip the platform prompt
node src/index.js --platform lmstudio # monitor LM Studio on :1234
node src/index.js --platform lemonade # monitor Lemonade on :13305
```

The live view is a **TUI** (boxes, gauges, sparklines). It automatically falls
back to plain text when output is not a terminal (piped or redirected), when
`NO_COLOR` or `TERM=dumb` is set, in `--once` mode, or with `--plain` — so
scripting and logging keep the same plain output as before.

On startup you're prompted to select a hosting platform (skipped when only one
platform is available, when `--platform` / `LLM_PLATFORM` is set, in `--once`
mode, or when there's no interactive terminal). Stop the live view with
`Ctrl-C`.

While the live view runs, the machine is kept from **idle-sleeping**, so a long
watch isn't cut short mid-session. The display is still free to turn off. Press
**`k`** in the TUI to toggle it on or off — the footer shows the current state.
`--no-keep-awake` starts it off, and `--once` never engages it. Details in
[keep-awake.md](docs/keep-awake.md).

Closing the laptop lid still sleeps the machine, because that is a separate
setting no runtime request can override. Press **`l`** (Windows only) to set the
lid-close action to *do nothing*, and `l` again to put the previous value back.
Two things are worth knowing before using it:

- It changes a **persistent system power setting**, for both AC and battery — not
  a per-process request scoped to this run.
- It is **not reverted automatically on exit.** Quit with the override on and it
  stays on until you toggle it off. The original values are saved to
  `~/.llm-monitor-lid-action.json`, and that file's presence is how a later run
  knows there is something to restore — so it survives a crash or `Ctrl-C`.

Windows normally lets you change power policy without elevation, and only when
that is denied does an admin prompt appear. The footer reads `awaiting admin…`
for as long as a toggle is in flight, so on the usual unelevated path it is a
brief flicker rather than a sign that a prompt is waiting for you. The new value
is read back before the footer settles, so a denied or dismissed change leaves
the state showing as unchanged instead of claiming success.

The override is Windows-only. Elsewhere the key is not bound and the footer omits
the lid-close segment rather than offering a control that does nothing.

## Options

| Flag | Default | Description |
|---|---|---|
| `--platform KEY` | prompt / first | Platform to monitor: `vllm`, `ollama`, `llamacpp`, `lmstudio`, `lemonade`, `openclaw` or `hermes` (also `LLM_PLATFORM` env) |
| `--vllm-host URL` | `http://localhost:8000` | vLLM base URL (also `VLLM_HOST` env) |
| `--ollama-host URL` | `http://localhost:11434` | Ollama base URL (also `OLLAMA_HOST` env; a missing `http://` is added) |
| `--ollama-log PATH` | platform default | Ollama `server.log` to read throughput from (also `OLLAMA_LOG` env) |
| `--llamacpp-host URL` | `http://localhost:8080` | llama.cpp base URL (also `LLAMACPP_HOST` env; a missing `http://` is added) |
| `--lmstudio-host URL` | `http://localhost:1234` | LM Studio native API base URL (also `LMSTUDIO_HOST` or `LM_STUDIO_HOST` env; a missing `http://` is added) |
| `--lmstudio-api-key KEY` | — | Optional LM Studio bearer token (also `LMSTUDIO_API_KEY` or `LM_STUDIO_API_KEY` env) |
| `--lemonade-host URL` | `http://localhost:13305` | AMD Lemonade server base URL (also `LEMONADE_HOST` env; a missing `http://` is added) |
| `--lemonade-api-key KEY` | — | Optional Lemonade bearer token (also `LEMONADE_API_KEY` env) |
| `--openclaw-host URL` | `http://127.0.0.1:18789` | OpenClaw gateway base URL; polls `/ready` every interval and `openclaw status --json` every 30 s (also `OPENCLAW_HOST` env; a missing `http://` is added) |
| `--hermes-host URL` | `http://127.0.0.1:8642` | Hermes Agent API server base URL; polls `/health` and `/health/detailed` every interval, with `/api/sessions` as the fallback when `state.db` cannot be read (also `HERMES_HOST` env; a missing `http://` is added) |
| `--hermes-api-key KEY` | — | Hermes `API_SERVER_KEY` bearer token, needed for `/health/detailed` and sessions (also `HERMES_API_KEY` or `API_SERVER_KEY` env; if unset, read from `API_SERVER_KEY` in Hermes's own `.env`) |
| `--hermes-db PATH` | `%LOCALAPPDATA%\hermes\state.db` (`~/.hermes/state.db` elsewhere) | Hermes session database, opened read-only for per-turn duration, tokens, API and tool calls, including `hermes chat` turns; falls back to `/api/sessions` if unreadable (also `HERMES_DB` env) |
| `--interval MS` | `2000` | Refresh / sampling interval |
| `--plain` | — | Plain text instead of the TUI (also automatic when piped / `NO_COLOR`) |
| `--once` | — | Print a single snapshot and exit |
| `--no-keep-awake` | — | Start with keep-awake off; toggle it with `k` in the TUI ([details](docs/keep-awake.md)) |

### Keys

| Key | Action |
|---|---|
| `k` | Toggle keep-awake on / off (TUI only) |
| `l` | Toggle the lid-close override on / off (TUI only, **Windows only**) |
| `Ctrl-C` | Exit |

The footer reports what is actually in effect rather than what was requested:

| Reads | Meaning |
|---|---|
| `keep-awake on` / `off` | An inhibitor is / is not being held |
| `keep-awake unavailable` | Requested, but the helper could not be started ([why](docs/keep-awake.md)) |
| `lid-close user setting` | Your own lid-close action, untouched |
| `lid-close do nothing` | Override active — **persists after exit** |
| `lid-close awaiting admin…` | Waiting on an elevation prompt |

## Example output

The default live TUI (colour omitted here — severity is colour-coded green /
amber / red, and `trend` sparklines show the recent history):

```
  Local LLM Monitor  Ollama · http://localhost:11434  ● 11:33:01 am · 2s

┌─ GPU0  NVIDIA GeForce RTX 5080 Laptop GPU ───────────────────────────┐
│ util   ████████████████████▊· 94%    trend ▁▃▅▇████▆▄▂▁▂▅███▇▄
│ memBW  ████████████████▋····· 76%
│ VRAM   █████████████████▉···· 14.1 GB/15.9 GB
│ temp 81°C   power 148W
└──────────────────────────────────────────────────────────────────────┘
┌─ Model ──────────────────────────────────────────────────────────────┐
│ qwen3:8b-q8_0  8.2B Q8_0  12.7 GB loaded (12.7 GB VRAM)
│ placement 100% GPU   context 16384   until forever
└──────────────────────────────────────────────────────────────────────┘
┌─ Runtime ────────────────────────────────────────────────────────────┐
│ slots     ████████████···· 3/4 busy
│ KV cache  ▋··············· 4%   (2832/65536 tok)
│ reuse     ███████████████▌ 97%  of last prompt (37/38 tok)
│ prompts   ███············· 24 cached · 1552/8192 MiB RAM
└──────────────────────────────────────────────────────────────────────┘
┌─ Throughput  (last completed request) ───────────────────────────────┐
│ prefill 687.1 tok/s (23 tok)    decode 65.9 tok/s (120 tok)
│ decode trend ▄▆▆▇▇▇▆▇▇▇▇▇
└──────────────────────────────────────────────────────────────────────┘

  k keep-awake on  ·  l lid-close user setting  ·  Ctrl-C to exit
```

Plain text (`--plain`, `--once`, or when piped):

```
=== Local LLM Monitor (vLLM) === 4:30:03 pm

GPU (nvidia-smi)
  GPU0 NVIDIA GeForce RTX 5080 Laptop GPU  util 99%  memBW 86%  VRAM 13.6 GB/15.9 GB  62°C  137W

vLLM (http://localhost:8000)
  model local-llm (Qwen/Qwen3-8B-FP8)
  requests  running 8  waiting 0  KV cache 16%  prefix cache hit 51%
  throughput  input 11.2 tok/s  output 549.5 tok/s
```

```
=== Local LLM Monitor (Ollama) === 3:49:47 pm

GPU (nvidia-smi)
  GPU0 NVIDIA GeForce RTX 5080 Laptop GPU  util 93%  memBW 84%  VRAM 14.1 GB/15.9 GB  54°C  117W

Ollama (http://localhost:11434)
  model qwen3:8b-q8_0  8.2B Q8_0  12.7 GB loaded (12.7 GB VRAM)
  placement 100% GPU  context 16384  until forever
  slots  3/4 busy  KV cache 4% (2832/65536 tok)
  prefix reuse 97% of last prompt (37/38 tok)  prompt cache 12 prompts 122/8192 MiB RAM
  last request  prefill 687.1 tok/s (23 tok)  decode 65.9 tok/s (120 tok)
```

```
=== Local LLM Monitor (llama.cpp) === 4:19:10 pm

GPU (nvidia-smi)
  GPU0 NVIDIA GeForce RTX 5080 Laptop GPU  util 88%  memBW 71%  VRAM 13.4 GB/15.9 GB  59°C  121W

llama.cpp (http://localhost:8080)
  model qwen3-8b-q8  8.2B Q8_0  8.1 GB loaded
  context 32768/40960 trained
  requests  1 processing  0 deferred
  slots  1/1 busy  KV cache 16% (5120/32768 tok, peak 5184)
  prefix reuse 98% of all prompt tokens (4992/5120 tok)
  throughput (live)  prefill 0.0 tok/s  decode 66.1 tok/s
```

Note the three llama.cpp-specific readings.

```
=== Local LLM Monitor (AMD Lemonade) === 4:22:10 pm

GPU (nvidia-smi)
  nvidia-smi not available

Lemonade system-stats
  CPU 23%  RAM 6.5 GB used  GPU 68%  VRAM 4.2 GB used  NPU 11%

AMD Lemonade (http://localhost:13305)
  model Qwen3-8B-GGUF-Q8_0  8.7 GB loaded
  device gpu  context 32768/40960 trained
  request state  busy yes  streaming yes
  requests completed  12
  prefix reuse 43% (96/224 tok)
  last request  input 128 tok  decode 42.5 tok/s (32 tok)
```

**Throughput** is labelled `(live)` or `(last completed)`, and the difference
matters. llama.cpp commits its Prometheus timings only when a request *finishes*,
and the gauge is emptied by whichever client reads `/metrics` first — so through a
long generation the gauge reads `0.0 tok/s` on every poll, and a browser sitting
on the built-in web UI can silently steal the reading. Decode is therefore
differenced from `/slots` `n_decoded`, which does climb live; that is the `(live)`
figure, and it is immune to both problems. `prefill` has no live equivalent
because it lands in one batch, so it reads `0.0` during decode — correctly, since
nothing is being prefilled. When nothing is in flight the box falls back to the
server's own figure for the last completed request.

For AMD Lemonade, the TUI's `decode per request` graph records one point only
when `request_count_total` changes, and is labelled `(on completion)`. It is a
local history collected from the time the monitor starts; Lemonade exposes the
latest request through `/api/v1/stats`, not a historical list of all requests.

**Prefix reuse** is cumulative since the server started, not the last prompt,
because `llamacpp:prompt_tokens_total` counts only the tokens actually evaluated.

**KV cache** has no metric of its own, so the denominator is summed from `/slots`:
each slot's `n_ctx`, added up. That is right at llama.cpp's default of separate
per-slot pools (`kv_unified = 'false'` in the startup banner), which is what
`-c` ÷ `-np` produces. It is **wrong if the server was started with
`--kv-unified`**: the slots then share one pool, and summing overstates the
denominator by the slot count, reporting a proportionally low percentage. `/props`
exposes `n_ctx` and `total_slots` but not `kv_unified`, so the monitor cannot
detect this — check the banner if the figure looks implausibly low.

## Interpreting the output

Every number's source, what it actually measures, and the traps in reading it
(per-slot vs aggregate throughput, KV cache vs prompt cache, why a prefix-cache
hit *lowers* the prefill rate) are documented in **[metrics.md](docs/metrics.md)**.

## Adding a platform

Platforms are resolved through a factory in `src/index.js`. To add one,
implement a provider class in `src/providers/` with a `label`/`host` and an async
`poll()` returning the shared result shape, then add an entry to the `PLATFORMS`
registry. Host settings live in `src/config.js`; the shared HTTP helper is in
`src/http.js`. The
startup selector and `--platform` flag pick it up automatically.

Both renderers branch on which fields are present rather than on the platform, so
a provider reports only what its server can actually answer:

- Always: `ok`, `error`, `models`.
- Aggregate-counter style (vLLM): `running`, `waiting`, `kvUsage`,
  `cacheHitRate`, `promptRate`, `decodeRate`.
- Per-model style (Ollama, llama.cpp, AMD Lemonade, LM Studio): `loaded[]` with
  `id`, `size`, `params`, `quant`, `context`, and optionally `format`, `vram`,
  `placement`, `device`, `until`, `contextTrain`, `busy`, `streaming`, and
  `activitySource`; plus platform specific `slots`, `kv`, `cacheHit` (add
  `scope` when it is not the last prompt), `peakTokens`, `promptCache`, and
  `requestCountTotal`.
- AMD Lemonade host telemetry: `systemStats` with CPU/RAM/GPU/VRAM/NPU values
  from its `/api/v1/system-stats` endpoint.
- LM Studio request telemetry: `lastRequest` and `requestCountTotal` are populated
  from completed `lms log stream --json --stats --source model --filter output`
  output; `busy` is inferred from the server log stream's request boundaries. The
  streams only observe requests emitted after the monitor starts.
- Throughput, first match wins: `lastRequest` (per request, from a log),
  `metricsDisabled`, `promptRate`/`decodeRate` (plus `rateLive` when the rate is
  sampled live rather than read off a completed request),
  `metricsError`, `logMissing`.

Any field the platform cannot supply may be left `null` — the `gb()` / `pct()` /
`rate()` helpers render it as `—`, so the output never implies a metric is zero
when it is merely unobservable.

## Terminal note

Neither view uses the alternate-screen buffer, so both work in any terminal,
including Git Bash / MinTTY. `Ctrl-C` exits.

The `k` and `l` shortcuts are the only features that need raw keyboard input.
Where `setRawMode` is unavailable (MinTTY without a pty), they are simply not
offered: the footer drops the key letters and shows the states on their own, and
everything else behaves as before. The plain view has no key handling at all, so
`--no-keep-awake` is the only way to control keep-awake there.

- The **TUI** homes the cursor and clears each line as it rewrites it, so the
  redraw does not flash. It reads `process.stdout.columns` on every frame and
  reflows on resize, clamping to 120 columns so gauges stay readable on a wide
  window; below ~30 columns content is truncated rather than wrapped.
- The **plain** view clears the screen and reprints each tick, exactly as
  before.
