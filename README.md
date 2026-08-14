# Local LLM Monitor

A zero-dependency Node script (Node 18+) that monitors a local LLM hosting
platform alongside the **NVIDIA** GPU it runs on, and prints a plain-text
snapshot on an interval. No `npm install` — it uses only Node built-ins plus
`nvidia-smi`.

The hosting platform is chosen at startup through a pluggable provider
(factory pattern). **Currently supported platforms:**

- **vLLM**
- **Ollama**

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

## Documentation

- **[metrics.md](metrics.md)** — where every number comes from, what it measures,
  and how to read it.
- **[keep-awake.md](keep-awake.md)** — how the machine is kept from idle-sleeping
  during a live watch, and how to turn that off.
- **[ollama-setup-windows.md](ollama-setup-windows.md)** — Ollama host setup.
- **[vllm-setup-windows-wsl2.md](vllm-setup-windows-wsl2.md)** — vLLM host setup.

## Run

```bash
npm start                  # live TUI, refreshes every 2s
npm run ollama             # live TUI, skip the platform prompt
npm run vllm               # live TUI, skip the platform prompt
npm run plain              # live plain text instead of the TUI
npm run once               # two samples ~1.5s apart, prints, exits
npm run once:ollama        # single snapshot of a specific platform
npm run once:vllm
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
| `--platform KEY` | prompt / first | Platform to monitor: `vllm` or `ollama` (also `LLM_PLATFORM` env) |
| `--vllm-host URL` | `http://localhost:8000` | vLLM base URL (also `VLLM_HOST` env) |
| `--ollama-host URL` | `http://localhost:11434` | Ollama base URL (also `OLLAMA_HOST` env; a missing `http://` is added) |
| `--ollama-log PATH` | platform default | Ollama `server.log` to read throughput from (also `OLLAMA_LOG` env) |
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

## Interpreting the output

Every number's source, what it actually measures, and the traps in reading it
(per-slot vs aggregate throughput, KV cache vs prompt cache, why a prefix-cache
hit *lowers* the prefill rate) are documented in **[metrics.md](metrics.md)**.

## Adding a platform

Platforms are resolved through a factory in `src/index.js`. To add one,
implement a provider class with an async `poll()` method that returns the same
result shape (`ok`, `models`, `running`, `waiting`, `kvUsage`, `cacheHitRate`,
`promptRate`, `decodeRate`) and a `label`/`host`, then add an entry to the
`PLATFORMS` registry. The startup selector and `--platform` flag pick it up
automatically.

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
