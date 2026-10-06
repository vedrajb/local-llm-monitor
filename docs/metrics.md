# Metrics computation

How every number in the monitor is obtained, what it actually measures, and how
to read it without drawing the wrong conclusion.

For usage and flags see [README.md](README.md). For the sleep-inhibitor see
[keep-awake.md](keep-awake.md).

## Sources

| Section | Source | Platform |
|---|---|---|
| GPU util, memBW, VRAM, temp, power | `nvidia-smi` | all platforms when NVIDIA telemetry is available |
| Model, queue, KV cache, prefix cache, throughput | OpenAI-compatible API + Prometheus `/metrics` | vLLM |
| Model, placement, context, keep-alive, slots | `/api/ps` | Ollama |
| Slots, KV cache, prefix reuse, prompt cache, throughput | `server.log` | Ollama |
| Loaded model, recipe, device, context, busy/streaming state | `/api/v1/health` + `/api/v1/models` | AMD Lemonade |
| Last-request performance, token counts, cache reuse, completed-request total | `/api/v1/stats` | AMD Lemonade |
| CPU, RAM, GPU, VRAM, and NPU usage | `/api/v1/system-stats` | AMD Lemonade |
| Loaded model instances, model metadata, and load configuration | `/api/v1/models` | LM Studio |
| Last completed-request token counts and decode speed | `lms log stream --json --stats --source model --filter output` | LM Studio |
| Ongoing request state | `lms log stream --json --source server` | LM Studio |

## Throughput

- **`input`** = prompt/prefill throughput; **`output`** = generation/decode
  throughput. Both come straight from vLLM's native token counters, as
  server-wide rates across every in-flight request. Ollama's `prefill` /
  `decode` are the per-request equivalents — see the Ollama section below for how
  they differ.
- For vLLM, throughput is derived from its cumulative token counters
  (`vllm:prompt_tokens_total`, `vllm:generation_tokens_total`) as a rate between
  polls, then EWMA-smoothed so it tracks vLLM's own averaged log figure instead
  of spiking on a single short window.

## vLLM

- **VRAM fit/spill** comes from `nvidia-smi`, not vLLM: vLLM reserves its VRAM
  slice at startup and never spills — it either fits or refuses to boot.
- **KV cache %** is occupancy within vLLM's preallocated block pool, not a
  VRAM-residency signal.
- vLLM metric names change between releases. These were verified against vLLM
  0.26.0 (see [vllm-setup-windows-wsl2.md](vllm-setup-windows-wsl2.md)); re-grep
  `/metrics` if a value reads as `—`.

## Ollama

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

## AMD Lemonade

- **Loaded-model state** comes from `/api/v1/health`. Its `all_models_loaded`
  entries identify the model, checkpoint, recipe, device declaration,
  `recipe_options.ctx_size`, and whether the model is busy or streaming. The
  monitor reports the device string as-is; `device gpu` is not a measured
  percentage of VRAM residency.
- **Model size and context** come from `/api/v1/models`. Lemonade reports model
  `size` in GB, so the monitor converts it to the byte-shaped value used by the
  shared renderer. This is catalog/model size, not a live process footprint.
  `context_length` is paired with `max_context_window` when both are present.
- **Request telemetry** comes from `/api/v1/stats`. `tokens_per_second` is the
  decode speed of the last completed request; input and output token counts are
  shown alongside it. Lemonade does not provide a prefill speed in this
  response, so the monitor shows the input token count without inventing a
  prefill rate. Prefix reuse is calculated as
  `cache_tokens / (cache_tokens + prompt_tokens)`, where `prompt_tokens` is the
  newly evaluated portion of the prompt. `request_count_total` is the cumulative
  completed-request count. These are server-wide last-request/cumulative values,
  not per-client attribution.
- **The Lemonade TUI graph is per request, not per poll.** It appends one decode
  point when `request_count_total` changes, labels the line `decode per request
  (on completion)`, and starts collecting history when the monitor starts.
  Lemonade's API exposes the latest request rather than a historical list.
- **Activity state** comes from the health entry's `is_busy` and `is_streaming`
  flags. They identify active work but do not expose a queue depth or the
  number of waiting requests. The monitor leaves queue and KV-cache occupancy
  unreported rather than estimating them from GPU utilization.
- **AMD-capable host telemetry** comes from `/api/v1/system-stats`: CPU and GPU
  utilization are percentages, while `memory_gb` and `vram_gb` are currently
  used memory values. `npu_percent` is shown when the installed driver and
  Lemonade backend can report it. `nvidia-smi` remains a separate source and is
  still displayed when an NVIDIA adapter is available.

## LM Studio

- **Loaded-model state** comes from LM Studio's native [`GET /api/v1/models`
  endpoint](https://lmstudio.ai/docs/developer/rest/list). The response lists
  available models and their `loaded_instances`. Each loaded instance provides
  its configured `context_length`; the model entry provides `max_context_length`,
  `size_bytes`, `params_string`, quantization, and file format. Embedding models
  are filtered out because this monitor is for text-generation servers.
- **Model size** is the API's `size_bytes` value. The provider reports it as
  model metadata and does not treat it as live VRAM residency; GPU utilization
  and VRAM usage continue to come from `nvidia-smi` when available.
- **Completed-request telemetry comes from the model log stream.** The provider
  starts `lms log stream --json --stats --source model --filter output` and parses
  `llm.prediction.output` events. LM Studio reports input tokens, generated
  tokens, tokens/sec, TTFT, and total time in the event's `stats` object. This
  is a passive observation path: the monitor does not send an inference request.
  The stream starts at monitor launch, so requests completed before that point
  are not replayed. LM Studio's [`/api/v1/chat` response](https://lmstudio.ai/docs/developer/rest/chat)
  still reports the same request statistics directly to the calling client.
- **Ongoing request state is server-log-inferred.** A second stream,
  `lms log stream --json --source server`, watches `Received request: POST` for
  chat/completion endpoints and `Generated prediction/response` for completion.
  The TUI displays `busy yes (server log inferred)` while a matching request is
  in progress. There is no native busy field in the models response, the stream
  begins at monitor launch, and concurrent requests cannot be perfectly
  correlated when the log has no stable request ID.
- If the `lms` CLI is missing or either log stream exits, the monitor retains the
  last captured request where possible and marks the unavailable telemetry rather
  than estimating it.
- **Authentication** is optional. If LM Studio API authentication is enabled,
  pass `--lmstudio-api-key KEY` or set `LMSTUDIO_API_KEY` (the alternate
  `LM_STUDIO_API_KEY` name is also accepted).

## OpenClaw

OpenClaw is a gateway in front of a model, like Hermes. A run's time includes
tool calls, every model call in the run, queueing and prompt prefill, so
dividing output tokens by it does not measure model speed. **There is no
prefill or decode rate for OpenClaw**; monitor the model server for that.

- **Readiness** is `GET /ready`, polled every interval: ready state, failing
  checks, uptime, and event-loop p99 delay, utilization and degraded reasons.
- **Requests** come from `openclaw gateway call sessions.list --json` every 3 s:
  busy state and elapsed time of running sessions, runs completed since the
  monitor started, and the last run's model, run time, input and output tokens
  and outcome.
- **Process and agent state** comes from `openclaw status --json` every 30 s:
  version, pid, RSS, connect latency, task counts by status, sessions, channels,
  and degraded model runtime or plugins.

## Hermes Agent

Hermes is an agent, not an inference server. It forwards each model call to a
provider (OpenAI, Nous Portal, or a local server such as Ollama) and receives a
finished response, so it never sees token timing. **There is no prefill or
decode rate for Hermes**, and the monitor does not estimate one. For a local
model, run a second monitor on the model server (for example
`--platform ollama`) to see real throughput and VRAM placement.

- **Liveness** is `GET /health` on the API server (default
  `http://127.0.0.1:8642`). It needs no key and decides reachable vs not.
- **Gateway detail** is `GET /health/detailed`, which needs the API server key.
  It supplies the gateway state, readiness checks (any check not `ok` is listed
  as failing), active API runs, pending process completions, active delegations,
  and today's API-server requests, tokens and p95 latency. Those daily counters
  cover API-server traffic only; `hermes chat` and TUI turns are not in them.
- **Per-turn stats come from Hermes's session database**, `state.db`, opened
  read-only. A turn runs from a `user` message to the next final `assistant`
  message (one without tool calls); `tool` messages in between are counted as
  tool calls, and the final message's `finish_reason` is the outcome. This
  covers every Hermes surface, including `hermes chat` and the TUI.
  - **Duration** is the gap between the two message timestamps, so it includes
    tool execution and every model call in the turn.
  - **Tokens and API calls** are the growth of the session's running totals
    across the turn, because Hermes does not record tokens per message. They
    render as `—` for a turn that finished before the monitor started, and when
    several turns in one session finish between two refreshes.
  - **Busy** is a turn with no final reply yet whose latest message is under 15
    minutes old, or any active API run.
  - With a local model, tokens appear only if the server returns OpenAI-style
    `usage` in its responses; the other per-turn fields do not depend on it.
- `state.db` is an internal Hermes schema, not a documented API, so a Hermes
  update can change it. If it cannot be read, the monitor falls back to
  `GET /api/sessions` (per-session totals only) and shows why.
- **Authentication:** the key is taken from `--hermes-api-key`, `HERMES_API_KEY`
  or `API_SERVER_KEY`, and otherwise read from `API_SERVER_KEY` in Hermes's own
  `.env`. Without a key only liveness and the `state.db` stats are shown.

## ComfyUI

ComfyUI generates images, not text, so **there are no token counts and no
prefill or decode rate for ComfyUI**. The monitor polls three REST endpoints
(default host `http://127.0.0.1:8188`) every interval, with a 3 s timeout each.
It does not use the `/ws` WebSocket, so it shows no per-step progress.

ComfyUI tokenizes prompt text inside its text-encoder nodes (CLIP or T5) but
never exposes the count, and its output is images rather than tokens, so no
endpoint reports input or output tokens. Estimating them from the prompt text
would need a model-specific tokenizer, which this zero-dependency monitor does
not ship. If a workflow calls an LLM through a custom node (for example an
Ollama or llama.cpp node), run a second monitor against that model server to
see its per-request tokens.

- **Liveness and memory** come from `GET /system_stats`, which decides
  reachable vs not. It gives the ComfyUI, Python and PyTorch versions, host RAM
  used (`ram_total - ram_free`) and, per device, VRAM used of total and
  PyTorch's own reserved pool (`torch_vram_total - torch_vram_free`). On AMD
  or Intel GPUs, where `nvidia-smi` is unavailable, this is the only VRAM
  figure.
- **Queue** comes from `GET /queue`: the number of running and pending prompts.
  ComfyUI does not report when the running prompt started, so its elapsed time
  is measured from the first poll that saw it and is approximate.
- **Jobs** come from `GET /history?max_items=20`, sorted by queue number:
  - **Outcome** is `success`, `error` or `interrupted`, from
    `status.status_str` and the `execution_error` / `execution_interrupted`
    messages. An error also shows the failing node type and exception message.
  - **Duration** runs from the `execution_start` timestamp to the final
    `execution_success`, `execution_error` or `execution_interrupted`
    timestamp. Builds that do not record those timestamps show `—`.
  - **Cached nodes** is the number of nodes ComfyUI skipped because their
    outputs were cached, out of the nodes in the submitted graph.
  - **Images** is the number of images across the job's outputs.
  - **Average duration** covers the jobs in that history window.
- **Jobs completed, errors and interrupted** count jobs that finished after the
  monitor started, once each by prompt ID. Jobs already in the history at
  startup are not counted. On builds that record no timestamps, a job counts
  if it was not in the history on the monitor's first poll.
- If `/queue` or `/history` fails, the monitor keeps showing the server as
  reachable and says which part is unavailable. Older builds that ignore
  `max_items` return the full history, which can be slow on a long session.

## Unavailable values

Any field a platform cannot supply is `null` and renders as `—`. That is
deliberate: the output never implies a metric is zero when it is merely
unobservable.
