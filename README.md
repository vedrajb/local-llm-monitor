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

For vLLM, throughput is derived from its cumulative token counters
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
| `--platform KEY` | prompt / first | Platform to monitor: `vllm` or `ollama` (also `LLM_PLATFORM` env) |
| `--vllm-host URL` | `http://localhost:8000` | vLLM base URL (also `VLLM_HOST` env) |
| `--ollama-host URL` | `http://localhost:11434` | Ollama base URL (also `OLLAMA_HOST` env; a missing `http://` is added) |
| `--ollama-log PATH` | platform default | Ollama `server.log` to read throughput from (also `OLLAMA_LOG` env) |
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

## Notes

- **`input`** = prompt/prefill throughput; **`output`** = generation/decode
  throughput. Both come straight from vLLM's native token counters, as
  server-wide rates across every in-flight request. Ollama's `prefill` /
  `decode` are the per-request equivalents — see the Ollama notes below for how
  they differ.
- **VRAM fit/spill** comes from `nvidia-smi`, not vLLM: vLLM reserves its VRAM
  slice at startup and never spills — it either fits or refuses to boot.
- **KV cache %** is occupancy within vLLM's preallocated block pool, not a
  VRAM-residency signal.
- vLLM metric names change between releases. These were verified against vLLM
  0.26.0 (see `vllm-setup-windows-wsl2.md`); re-grep `/metrics` if a value reads
  as `—`.
- **Ollama throughput comes from `server.log`, not from HTTP.** Ollama has no
  Prometheus endpoint (`/metrics` is a 404 as of 0.32.5), and its HTTP token
  counters (`prompt_eval_count`, `eval_count`, …) are returned *only in the
  response to the request that produced them* — invisible to an observer. But
  the bundled `llama-server` logs a `print_timing` block per finished request at
  default verbosity, so tailing the log yields the true rates for **every**
  client without issuing any inference of its own. Verified: a log-derived
  `65.88 tok/s` decode matched the client-side figure of `65.9` exactly.
- **`last request` is the most recently *finished* request**, not a live rate —
  it holds its value while the next request generates. Pair it with `slots` and
  GPU util to tell "working" from "idle".
- **`decode` matches vLLM's `output`, but `prefill` is not quite vLLM's
  `input`.** vLLM's figures are server-wide rates across all in-flight
  requests; Ollama's are per-request, for one finished request. Two
  consequences:
  - Under concurrency the numbers are **per slot, not aggregate**. Three
    parallel requests measured 60.2 / 60.3 / 62.4 tok/s each — the server was
    doing ~183 tok/s in total, but the line shows the one that finished last.
    Read `slots N/4 busy` to know how many were sharing the GPU.
  - `prefill` counts only the tokens **actually evaluated**, which is why the
    token count is printed next to it. On a prefix-cache hit a 150-token prompt
    evaluates 1 token, so the rate is computed over that single token and
    collapses (e.g. `prefill 55.1 tok/s (1 tok)`) even though the request got
    *faster*. A low prefill next to a low token count means the cache did its
    job, not that prefill is slow. Ollama's HTTP `prompt_eval_count` keeps
    reporting the full 150 in that case, so a client-side calculation of the
    same request reads ~10,600 tok/s — the log figure is the honest one.
- **Ollama has two separate caches; the monitor keeps them apart.**
  - **`KV cache`** is the GPU KV pool — the true analogue of vLLM's `KV cache`.
    llama.cpp gives each of the `-np` slots `n_ctx_slot` tokens (here 4 × 16384
    = 65536), and reports a slot's live token count on `new prompt` and again on
    `release`. Occupancy is the sum over slots. Verified: four concurrent
    requests holding 333 + 1083 + 583 + 833 tokens reported exactly
    `2832/65536`.
  - **`prompt cache`** is a *host RAM* store of idle slots' prompts, sized by
    llama.cpp's `--cache-ram` (8192 MiB here) — **not** VRAM and not the KV
    pool. It is shown as `N prompts X/Y MiB RAM` so it is never mistaken for
    KV occupancy.
- **`prefix reuse` is per-request, where vLLM's `prefix cache hit` is
  cumulative.** It reports how much of *the last prompt* llama.cpp recovered
  from cache (`cached n_tokens` / `task.n_tokens`), so it swings between
  requests instead of converging on a server-wide average. Verified against the
  same prompt run twice: `21%` cold, then `97%` warm. This is also the number
  that explains a collapsed `prefill` rate — high reuse means few tokens were
  actually evaluated.
- **Log locations** are `%LOCALAPPDATA%\Ollama\server.log` (Windows) and
  `~/.ollama/logs/server.log` (macOS/Linux). A Linux **systemd** install logs to
  journald with no file to read, so throughput reports as unavailable — pass
  `--ollama-log PATH` if your setup writes elsewhere. Everything else
  (placement, VRAM, context, slots) still works without the log.
- **Ollama `placement`** is the fit/spill signal: it compares `size_vram`
  against `size` from `/api/ps`, the same ratio `ollama ps` shows in its
  `PROCESSOR` column. `100% GPU` means fully GPU-resident; anything less means
  layers are running on the CPU and decode will be far slower.
- **Ollama `loaded` bytes** (`/api/ps` `size`) are the in-memory footprint —
  weights plus KV cache and buffers — so it is larger than the model's
  on-disk size shown by `ollama list`.
- `until forever` means the model is pinned (`OLLAMA_KEEP_ALIVE=-1`), which
  Ollama reports as a date centuries in the future.

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

The live view clears the screen and reprints each tick (no alternate-screen
buffer or raw input), so it works in any terminal, including Git Bash / MinTTY.
