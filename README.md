# Local LLM Monitor

A zero-dependency Node script (Node 18+) that monitors a local LLM hosting
platform alongside the **NVIDIA** GPU it runs on, and prints a plain-text
snapshot on an interval. No `npm install` — it uses only Node built-ins plus
`nvidia-smi`.

The hosting platform is chosen at startup through a pluggable provider
(factory pattern). **Currently supported platforms:**

- **vLLM**

It reads:

- **GPU** (via `nvidia-smi`) — utilization, memory-bandwidth util, VRAM
  used/total, temperature, power.
- **Platform** (via the OpenAI-compatible API + Prometheus `/metrics`) — the
  served model, request queue (running / waiting), KV-cache occupancy,
  prefix-cache hit rate, and token throughput (input + output).

Throughput is derived from vLLM's cumulative token counters
(`vllm:prompt_tokens_total`, `vllm:generation_tokens_total`) as a rate between
polls, then EWMA-smoothed so it tracks vLLM's own averaged log figure instead of
spiking on a single short window.

## Run

```bash
node src/index.js          # live, refreshes every 2s
node src/index.js --once   # takes two samples ~1.5s apart, prints, exits
```

On startup you're prompted to select a hosting platform (skipped when only one
platform is available, when `--platform` / `LLM_PLATFORM` is set, in `--once`
mode, or when there's no interactive terminal). Stop the live view with
`Ctrl-C`.

## Options

| Flag | Default | Description |
|---|---|---|
| `--platform KEY` | prompt / first | Platform to monitor, e.g. `vllm` (also `LLM_PLATFORM` env) |
| `--vllm-host URL` | `http://localhost:8000` | vLLM base URL (also `VLLM_HOST` env) |
| `--interval MS` | `2000` | Refresh / sampling interval |
| `--once` | — | Print a single snapshot and exit |

## Example output

```
=== Local LLM Monitor (vLLM) === 4:30:03 pm

GPU (nvidia-smi)
  GPU0 NVIDIA GeForce RTX 5080 Laptop GPU  util 99%  memBW 86%  VRAM 13.6 GB/15.9 GB  62°C  137W

vLLM (http://localhost:8000)
  model local-llm (Qwen/Qwen3-8B-FP8)
  requests  running 8  waiting 0  KV cache 16%  prefix cache hit 51%
  throughput  input 11.2 tok/s  output 549.5 tok/s
```

## Notes

- **`input`** = prompt/prefill throughput; **`output`** = generation/decode
  throughput. Both come straight from vLLM's native token counters.
- **VRAM fit/spill** comes from `nvidia-smi`, not vLLM: vLLM reserves its VRAM
  slice at startup and never spills — it either fits or refuses to boot.
- **KV cache %** is occupancy within vLLM's preallocated block pool, not a
  VRAM-residency signal.
- vLLM metric names change between releases. These were verified against vLLM
  0.26.0 (see `vllm-setup-windows-wsl2.md`); re-grep `/metrics` if a value reads
  as `—`.

## Adding a platform

Platforms are resolved through a factory in `src/index.js`. To add one,
implement a provider class with an async `poll()` method that returns the same
result shape (`ok`, `models`, `running`, `waiting`, `kvUsage`, `cacheHitRate`,
`promptRate`, `decodeRate`) and a `label`/`host`, then add an entry to the
`PLATFORMS` registry. The startup selector and `--platform` flag pick it up
automatically.

## Terminal note

The live view clears the screen and reprints each tick (no alternate-screen
buffer or raw input), so it works in any terminal, including Git Bash / MinTTY.
