# Local LLM Monitor

A zero-dependency Node script (Node 18+) that monitors a local LLM hosting
platform alongside the **NVIDIA** GPU it runs on, and prints a plain-text
snapshot on an interval. No `npm install` — it uses only Node built-ins plus
`nvidia-smi`.

The hosting platform is chosen at startup through a pluggable provider
(factory pattern). **Currently supported platforms:**

- **vLLM**
- **Ollama**
- **llama.cpp**

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

## Documentation

- **[metrics.md](metrics.md)** — where every number comes from, what it measures,
  and how to read it.
- **[keep-awake.md](keep-awake.md)** — how the machine is kept from idle-sleeping
  during a live watch, and how to turn that off.
- **[ollama-setup-windows.md](ollama-setup-windows.md)** — Ollama host setup.
- **[vllm-setup-windows-wsl2.md](vllm-setup-windows-wsl2.md)** — vLLM host setup.
- **[llamacpp-setup-windows.md](llamacpp-setup-windows.md)** — llama.cpp host setup.

## Run

```bash
npm start                  # live TUI, refreshes every 2s
npm run ollama             # live TUI, skip the platform prompt
npm run vllm               # live TUI, skip the platform prompt
npm run llamacpp           # live TUI, skip the platform prompt
npm run plain              # live plain text instead of the TUI
npm run once               # two samples ~1.5s apart, prints, exits
npm run once:ollama        # single snapshot of a specific platform
npm run once:vllm
npm run once:llamacpp
```

Equivalent to running the script directly:

```bash
node src/index.js                    # live TUI
node src/index.js --plain            # live plain text
node src/index.js --once             # takes two samples ~1.5s apart, prints, exits
node src/index.js --platform ollama  # skip the platform prompt
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
watch isn't cut short mid-session. The display is still free to turn off, and
closing a laptop lid still sleeps as usual. Press **`k`** in the TUI to toggle it
on or off — the footer shows the current state. `--no-keep-awake` starts it off,
and `--once` never engages it. Details in [keep-awake.md](keep-awake.md).

## Options

| Flag | Default | Description |
|---|---|---|
| `--platform KEY` | prompt / first | Platform to monitor: `vllm`, `ollama` or `llamacpp` (also `LLM_PLATFORM` env) |
| `--vllm-host URL` | `http://localhost:8000` | vLLM base URL (also `VLLM_HOST` env) |
| `--ollama-host URL` | `http://localhost:11434` | Ollama base URL (also `OLLAMA_HOST` env; a missing `http://` is added) |
| `--ollama-log PATH` | platform default | Ollama `server.log` to read throughput from (also `OLLAMA_LOG` env) |
| `--llamacpp-host URL` | `http://localhost:8080` | llama.cpp base URL (also `LLAMACPP_HOST` env; a missing `http://` is added) |
| `--interval MS` | `2000` | Refresh / sampling interval |
| `--plain` | — | Plain text instead of the TUI (also automatic when piped / `NO_COLOR`) |
| `--once` | — | Print a single snapshot and exit |
| `--no-keep-awake` | — | Start with keep-awake off; toggle it with `k` in the TUI ([details](keep-awake.md)) |

### Keys

| Key | Action |
|---|---|
| `k` | Toggle keep-awake on / off (TUI only) |
| `Ctrl-C` | Exit |

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

  k keep-awake on  ·  Ctrl-C to exit
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

Note the two llama.cpp-specific readings.

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

**Prefix reuse** is cumulative since the server started, not the last prompt,
because `llamacpp:prompt_tokens_total` counts only the tokens actually evaluated.

## Interpreting the output

Every number's source, what it actually measures, and the traps in reading it
(per-slot vs aggregate throughput, KV cache vs prompt cache, why a prefix-cache
hit *lowers* the prefill rate) are documented in **[metrics.md](metrics.md)**.

## Adding a platform

Platforms are resolved through a factory in `src/index.js`. To add one,
implement a provider class with a `label`/`host` and an async `poll()` returning
the shared result shape, then add an entry to the `PLATFORMS` registry. The
startup selector and `--platform` flag pick it up automatically.

Both renderers branch on which fields are present rather than on the platform, so
a provider reports only what its server can actually answer:

- Always: `ok`, `error`, `models`.
- Aggregate-counter style (vLLM): `running`, `waiting`, `kvUsage`,
  `cacheHitRate`, `promptRate`, `decodeRate`.
- Per-model style (Ollama, llama.cpp): `loaded[]` with `id`, `size`, `params`,
  `quant`, `context`, and optionally `vram`, `placement`, `until`,
  `contextTrain`; plus `slots`, `kv`, `cacheHit` (add `scope` when it is not the
  last prompt), `peakTokens`, `promptCache`.
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

The `k` shortcut is the only feature that needs raw keyboard input. Where
`setRawMode` is unavailable (MinTTY without a pty), it is simply not offered:
the footer drops the `k` and shows the keep-awake state on its own, and
everything else behaves as before. The plain view has no key handling at all.

- The **TUI** homes the cursor and clears each line as it rewrites it, so the
  redraw does not flash. It reads `process.stdout.columns` on every frame and
  reflows on resize, clamping to 120 columns so gauges stay readable on a wide
  window; below ~30 columns content is truncated rather than wrapped.
- The **plain** view clears the screen and reprints each tick, exactly as
  before.
