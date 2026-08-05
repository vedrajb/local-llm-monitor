# Ollama Setup on Windows 11 (native) — Verified Steps

Working setup as built and confirmed on 2026-08-04. Every version, path, and
value below was read off the running system, not assumed.

Companion to [vllm-setup-windows-wsl2.md](vllm-setup-windows-wsl2.md), which
covers the same GPU running `Qwen/Qwen3-8B-FP8` under vLLM in WSL2. All shell
commands here are **Git Bash**, except the installer, which is PowerShell.

## Target configuration

| Component | Value |
|---|---|
| Host OS | Windows 11 Home 26200 |
| GPU | NVIDIA GeForce RTX 5080 Laptop, 16303 MiB |
| NVIDIA driver | 591.83, reports CUDA 13.1 |
| Host RAM / CPU | 32 GB LPDDR5X (soldered), 16 cores |
| Ollama | 0.32.5, native Windows, `%LOCALAPPDATA%\Programs\Ollama` |
| Model | `qwen3:8b-q8_0` — 8.9 GB on disk, 12.70 GiB resident, 100% GPU |
| Endpoint | `http://localhost:11434` |

**Ollama runs natively on Windows.** No WSL2, no admin rights, no CUDA toolkit.
It binds `127.0.0.1:11434`, so it does not collide with the vLLM setup on 8000 —
both can be installed side by side, though not loaded into VRAM at once.

---

## Why not `Qwen/Qwen3-8B-FP8`

Ollama cannot run that repo. This is a hard incompatibility, not a tuning
problem.

`Qwen/Qwen3-8B-FP8` ships **block-wise FP8 safetensors** (`F8_E4M3`, block size
128). Ollama's backend is llama.cpp/GGUF, and its safetensors importer covers
only Llama, Mistral, Gemma, and Phi3 architectures from FP16/FP32 weights —
Qwen3 is not on that list and FP8 is not a supported input precision. The Qwen3
model card claims FP8 compatibility only for `transformers`, `sglang`, and
`vllm`.

`qwen3:8b-q8_0` is the practical equivalent — same bits-per-weight class,
8-bit weights:

| Tag | Size | Verdict on 15.9 GB VRAM |
|---|---|---|
| `qwen3:8b-q8_0` | 8.9 GB | **Use this.** Closest to FP8 |
| `qwen3:8b` / `8b-q4_K_M` | 5.2 GB | Default pull — 4-bit, shares one digest with `latest` |
| `qwen3:8b-fp16` | 16 GB | Will not fit with any usable context |

Converting the FP8 repo by hand with llama.cpp's
`convert_hf_to_gguf.py --fp8-as-q8` dequantizes FP8 and stores Q8_0, arriving at
the same place as the prebuilt tag. Not worth the effort.

Note also that the `qwen3:8b` tags are the original release with a 40K context.
The newer `2507` refresh with 256K context exists only at 4b, 30b-a3b, and
235b — **there is no 8B 2507 build**.

---

## Step 1 — Install

PowerShell:

```powershell
irm https://ollama.com/install.ps1 | iex
```

The script downloads `OllamaSetup.exe`, **verifies its Authenticode signature**
and aborts if that fails, runs it `/VERYSILENT /NORESTART`, and patches PATH.
Per-user install, no admin. Set `$env:OLLAMA_INSTALL_DIR` first for a custom
location; the script also accepts `-Uninstall`.

Two behaviours that matter for Step 3:

- It writes an `%LOCALAPPDATA%\Ollama\upgraded` marker so the app starts hidden.
- **The installer launches the server as a child process.** Ollama is already
  running when the command returns — started *before* the Step 2 variables
  exist.

It only patches PATH in the calling PowerShell session. A **fresh** Git Bash
picks `ollama` up from the persisted user PATH; an already-open one will not.
For an existing shell:

```bash
export PATH="$PATH:$LOCALAPPDATA/Programs/Ollama"
```

Mixed forward/back slashes in `$LOCALAPPDATA` resolve correctly under Git Bash.

## Step 2 — Set the required environment variables

**This is the non-standard part.** Ollama's defaults are actively hostile to the
metrics in [local-llm-monitoring-summary.md](local-llm-monitoring-summary.md).
The first three are not optional if those metrics are the goal.

| Variable | Default | Value | Why |
|---|---|---|---|
| `OLLAMA_CONTEXT_LENGTH` | **4096** | `16384` | 4K silently truncates. Prefill and ETA figures are meaningless against a 4K cap |
| `OLLAMA_NUM_PARALLEL` | **1** | `4` | At 1, concurrent requests serialize. GPU util reads low and the classifier sits permanently `scheduler/queue-bound` — a false starvation signal |
| `OLLAMA_KEEP_ALIVE` | **5m** | `-1` | Model unloads after 5 min idle. `/api/ps` then returns an empty array and placement collapses to `unknown` mid-session |
| `OLLAMA_FLASH_ATTENTION` | auto | `1` | Prerequisite — `OLLAMA_KV_CACHE_TYPE` has no effect without it |
| `OLLAMA_KV_CACHE_TYPE` | `f16` | `q8_0` | Halves KV cache VRAM. Required to avoid spill at this context × parallel setting |

```bash
setx OLLAMA_CONTEXT_LENGTH 16384 && setx OLLAMA_NUM_PARALLEL 4 && setx OLLAMA_KEEP_ALIVE "-1" && setx OLLAMA_FLASH_ATTENTION 1 && setx OLLAMA_KV_CACHE_TYPE q8_0
```

`-1` must stay quoted or `setx` parses it as a flag.

`setx` writes to `HKCU\Environment` and persists across reboots. Verify:

```bash
reg query "HKCU\Environment" | grep -i OLLAMA
```

### The memory multiplier

`NUM_PARALLEL × CONTEXT_LENGTH` is the real KV allocation, not
`CONTEXT_LENGTH`. At 4 × 16384 the server allocates **65536 tokens** of KV
cache. This is the number to tune first if placement degrades.

## Step 3 — Restart Ollama so it reads them

Mandatory, and easy to skip. The tray app reads environment variables **once at
startup**, and the Step 1 installer already started it. Setting variables in a
shell before `ollama run` does nothing — the CLI is a thin client that talks to
the background server.

```bash
taskkill /F /IM "ollama app.exe" /IM ollama.exe 2>/dev/null; sleep 3; "$LOCALAPPDATA/Programs/Ollama/ollama app.exe" &
```

If that returns `Access is denied`, use the documented Windows path instead:
right-click the Ollama tray icon → **Quit Ollama**, then relaunch **Ollama** from
the Start menu.

> On this machine `taskkill` and PowerShell `Stop-Process` both returned
> `Access is denied` when issued from an agent-driven shell, despite the
> processes being owned by the same non-elevated user and no Ollama Windows
> service existing. The same commands work from an interactive shell. If
> scripting a restart, verify it actually took effect rather than trusting the
> exit code.

### Step 3b — Verify the restart took effect

This check is what catches a silently-failed restart:

```bash
grep -oE 'OLLAMA_(CONTEXT_LENGTH|NUM_PARALLEL|KEEP_ALIVE|FLASH_ATTENTION|KV_CACHE_TYPE):[^ ]*' "$LOCALAPPDATA/Ollama/server.log" | tail -6
```

Healthy output:

```text
OLLAMA_CONTEXT_LENGTH:16384
OLLAMA_FLASH_ATTENTION:true
OLLAMA_KEEP_ALIVE:2562047h47m16.854775807s
OLLAMA_KV_CACHE_TYPE:q8_0
OLLAMA_NUM_PARALLEL:4
```

`2562047h47m…` is Go's maximum duration — that is `-1` applied correctly, i.e.
never unload.

A server that missed the variables logs the defaults instead, and this is
exactly what a skipped Step 3 looks like:

```text
OLLAMA_CONTEXT_LENGTH:0
OLLAMA_FLASH_ATTENTION:false
OLLAMA_KEEP_ALIVE:5m0s
OLLAMA_KV_CACHE_TYPE:
OLLAMA_NUM_PARALLEL:1
```

## Step 4 — Pull the model

```bash
ollama pull qwen3:8b-q8_0
```

8.9 GB. Lands in `~/.ollama/models` (8.3 GiB measured on disk). Relocate with
`OLLAMA_MODELS` if needed.

## Step 5 — Load it and confirm placement

An **empty prompt** to `/api/generate` loads the model into VRAM without
generating anything — the cheapest way to warm it:

```bash
curl -s http://localhost:11434/api/generate -d '{"model":"qwen3:8b-q8_0"}' && ollama ps
```

The response confirms a load rather than a generation, and takes ~7.3 s cold:

```json
{"model":"qwen3:8b-q8_0","response":"","done":true,"done_reason":"load"}
```

Verified output:

```text
NAME             ID              SIZE     PROCESSOR    CONTEXT    UNTIL
qwen3:8b-q8_0    e56358ca25dd    13 GB    100% GPU     16384      Forever
```

`PROCESSOR` must read `100% GPU`. A split such as `48%/52% CPU/GPU` means the
allocation did not fit — drop `OLLAMA_NUM_PARALLEL` to `2` and redo Step 3.
`CONTEXT 16384` and `UNTIL Forever` double as confirmation that Step 2 applied.

### Verified VRAM budget

From the load log, at `OLLAMA_KV_CACHE_TYPE=q8_0` and `n_ctx = 65536`:

| Component | Size |
|---|---|
| `CUDA0 model buffer` | 7804.77 MiB |
| KV cache — K (q8_0) 2448.00 + V (q8_0) 2448.00 | 4896.00 MiB |
| `CUDA0 compute buffer` | 304.09 MiB |
| **Total** | **13004.86 MiB = 12.70 GiB** |

That total matches `/api/ps` `size_vram` (13,636,584,078 bytes) to within
rounding. `load_tensors: offloaded 37/37 layers to GPU`.

KV cost works out to **76.5 KiB/token** at q8_0. At the `f16` default the same
65536-token allocation needs roughly 9.8 GB and **will** spill — which is why
`OLLAMA_KV_CACHE_TYPE` is listed as required rather than optional.

`nvidia-smi` reports 14395 MiB / 16303 MiB with the model loaded and idle. The
~1390 MiB above `size_vram` is the Windows desktop compositor and other
processes, which also hold VRAM on a laptop GPU.

## Step 6 — Confirm the metrics are readable

**Placement, VRAM, and effective context** — the `size` / `size_vram` /
`context_length` source:

```bash
curl -s http://localhost:11434/api/ps
```

**Throughput** from the native nanosecond timings:

```bash
curl -s http://localhost:11434/api/chat -d '{"model":"qwen3:8b-q8_0","messages":[{"role":"user","content":"Explain how a CPU cache hierarchy works, in detail."}],"stream":false,"think":false,"options":{"num_predict":300}}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("prefill",(r.prompt_eval_count/(r.prompt_eval_duration/1e9)).toFixed(1),"tok/s   decode",(r.eval_count/(r.eval_duration/1e9)).toFixed(1),"tok/s")})'
```

Measured on this setup, 28 prompt tokens and 300 generated:

```text
prefill 114.0 tok/s   decode 71.0 tok/s
```

**GPU and starvation signals** — unchanged from the vLLM setup:

```bash
nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits
```

PCIe counters for the transfer-bound classification are available on this GPU
(gen 5 ×8):

```bash
nvidia-smi --query-gpu=pcie.link.gen.current,pcie.link.width.current --format=csv,noheader
```

**Load generator** — 8 workers against `NUM_PARALLEL=4`, so 4 run and 4 queue.
That is deliberate: it is how to exercise the `scheduler/queue-bound`
classification. `Ctrl-C` to stop.

```bash
i=0; while true; do i=$((i+1)); for c in 1 2 3 4 5 6 7 8; do curl -s -m 300 http://localhost:11434/api/chat -H 'Content-Type: application/json' -d "{\"model\":\"qwen3:8b-q8_0\",\"messages\":[{\"role\":\"user\",\"content\":\"Explain in exhaustive detail with worked examples how a CPU cache hierarchy works. Run $i worker $c.\"}],\"stream\":false,\"think\":false,\"options\":{\"num_predict\":2000,\"temperature\":0.9}}" > /dev/null & done; wait; echo "round $i done"; done
```

---

## Two mandatory API rules

### Never use `/v1/chat/completions` for monitoring

Ollama's OpenAI-compatible endpoint returns OpenAI-shaped output only. It
**drops `prompt_eval_duration` and `eval_duration` entirely** — no timings means
no throughput metric at all. It also cannot set `num_ctx`. Use `/api/chat` or
`/api/generate`.

### Always send `think:false` when measuring

Qwen3 has thinking **on by default**, and reasoning tokens are counted inside
`eval_count`. Verified on this setup with an identical prompt and
`num_predict:300`:

| Setting | `eval_count` | `message.thinking` | `message.content` |
|---|---|---|---|
| `think:false` | 300 | absent | full answer |
| default (thinking on) | 300 | 1252 chars | **0 chars** |

Decode rate stays honest either way — 71.0 tok/s in both cases — but the entire
budget went to reasoning and the user-visible answer was empty. Any
ETA-to-visible-answer computed from `eval_count` is therefore badly wrong on a
thinking response. Either send `think:false`, or track thinking and content
token counts separately.

Note the response shape: for `/api/chat` the field is **`message.thinking`**,
not a top-level `thinking`. The top-level field is the `/api/generate` shape.

---

## Metric coverage vs the vLLM setup

Mapped against [local-llm-monitoring-summary.md](local-llm-monitoring-summary.md):

| Metric | Ollama source | vs. vLLM |
|---|---|---|
| **VRAM fit / spill** | `/api/ps` `size` vs `size_vram`; `ollama ps` `PROCESSOR` column | **Better.** vLLM never spills, so its adapter can only ever report `gpu_resident`. Ollama genuinely does hybrid splits, making all five residency states reachable |
| **Throughput** | `prompt_eval_count / (prompt_eval_duration / 1e9)`, `eval_count / (eval_duration / 1e9)` | Per-request, not server-wide. The monitor must aggregate |
| **GPU util / starvation** | `nvidia-smi` — unchanged | Equivalent, but VRAM is now shared with other apps, so add `--query-compute-apps=pid,used_memory` to attribute Ollama's slice |
| **ETA** | Same formulas; `num_predict` is the `max_tokens` equivalent for the upper bound | Equivalent |
| **Queue depth** | **Lost.** No `num_requests_running` / `waiting` equivalent | vLLM better. Only inferable by counting own in-flight requests |
| **KV cache occupancy** | **Lost.** Not exposed | vLLM better |
| **Prefix cache hit rate** | **Lost.** Not exposed | vLLM better |

### Ollama has no Prometheus endpoint

Verified on 0.32.5:

```text
GET /metrics      -> 404
GET /api/metrics  -> 404
```

There are **no cumulative token counters of any kind**. Two consequences for the
monitor in [src/index.js](src/index.js), which is built entirely around diffing
vLLM's `vllm:prompt_tokens_total` and `vllm:generation_tokens_total`:

1. **It cannot work against Ollama by changing the host URL.** The data source
   has to be replaced, not repointed.
2. **The monitor can no longer be a passive side-car.** Timings arrive only in a
   response body, so it must proxy or originate requests — the "master app
   launches or proxies LLM requests" caveat from the summary doc's opening
   paragraph. Aggregate throughput must be accumulated client-side by summing
   `eval_count` / `eval_duration` across completed requests.

The existing EWMA smoothing logic ports over unchanged; feed it per-request
rates instead of counter deltas.

### Caveat — `size_vram == size` does not mean nothing is host-side

The load log shows both a `CUDA0 model buffer size = 7804.77 MiB` **and** a
`CUDA_Host model buffer size = 630.59 MiB`. Only the CUDA0 figure appears in the
`size` / `size_vram` arithmetic above; the 630.59 MiB host-side buffer is
counted in neither, while `ollama ps` still reports `100% GPU`.

So treat `size_vram == size` as "the runtime placed every layer it intended to
place on the GPU", not as "zero bytes of this model live in host RAM". For the
`hybrid_cpu_gpu` versus `gpu_resident` distinction that is the right signal.
For a byte-accurate host-RAM figure, read the process working set instead.

---

## Starting and stopping

Two independent layers. "Stop Ollama" is ambiguous until you say which one:

| Layer | Process | Role |
|---|---|---|
| Tray app | `ollama app.exe` | Supervisor. Reads the `OLLAMA_*` variables, spawns and restarts the server |
| Server | `ollama.exe` (child of the tray app) | Owns port 11434 and the VRAM allocation |

The **model** is a third thing again — loaded and unloaded inside the running
server, without restarting either layer.

### Load the model

```bash
curl -s http://localhost:11434/api/generate -d '{"model":"qwen3:8b-q8_0"}'
```

`{"response":"","done":true,"done_reason":"load"}` confirms it. ~7.3 s cold.

Preloading is never strictly required — any request loads the model implicitly
and pays the same cost on the first call. It is worth doing before measuring
throughput, so the first request's `load_duration` does not distort the numbers.

Interactive use, which also loads implicitly:

```bash
ollama run qwen3:8b-q8_0
```

`/bye` exits the chat. It does **not** unload the model — with `KEEP_ALIVE=-1`
the weights stay resident.

### Unload the model, keep the server up

Necessary because `KEEP_ALIVE=-1` otherwise holds ~12.7 GiB of VRAM forever —
required before starting the vLLM server, for instance:

```bash
ollama stop qwen3:8b-q8_0
```

Verified: 0.12 s, and `nvidia-smi` VRAM drops **14379 MiB → 1150 MiB**. The
server keeps listening on 11434 and reloads on the next request.

Equivalent via the API, using the per-request `keep_alive` override:

```bash
curl -s http://localhost:11434/api/chat -d '{"model":"qwen3:8b-q8_0","keep_alive":0}' > /dev/null && ollama ps
```

An empty `ollama ps` table confirms release either way.

### Shut the server down

Tray icon → **Quit Ollama** is the reliable path; it stops the tray app and its
server child together.

From the shell:

```bash
taskkill /F /IM "ollama app.exe" /IM ollama.exe 2>/dev/null; sleep 2; tasklist /FI "IMAGENAME eq ollama.exe"
```

Kill `ollama app.exe` **first**, or the supervisor may respawn the server. On
`Access is denied`, use the tray — see the note in Step 3.

### Start the server

```bash
"$LOCALAPPDATA/Programs/Ollama/ollama app.exe" &
```

Or launch **Ollama** from the Start menu. **Prefer the tray app over
`ollama serve`** — the tray reads the persisted `OLLAMA_*` variables and
supervises the server, which is what the whole Step 2 configuration depends on.

A bare `ollama serve` that loses the port race to an existing server leaves a
harmless but pointless idle process; check for strays with the `tasklist`
command above.

### Stop it launching at login

The tray app autostarts with Windows. Disable via **Task Manager → Startup apps
→ Ollama → Disable**, or in the Ollama tray settings if the build exposes it.

---

## Useful operational commands

**List what is installed vs loaded:**

```bash
ollama list && echo "---" && ollama ps
```

**Tail the server log:**

```bash
tail -f "$LOCALAPPDATA/Ollama/server.log"
```

---

## Footprint

| Item | Size |
|---|---|
| `~/.ollama/models` (weights on disk) | 8.3 GiB |
| Model resident, per `/api/ps` `size_vram` | 12.70 GiB |
| `nvidia-smi` VRAM in use, model loaded and idle | 14395 MiB / 16303 MiB |

---

## Failure-mode quick reference

| Symptom | Cause | Fix |
|---|---|---|
| `ollama: command not found` in Git Bash | Shell predates install; PATH not refreshed | Open a fresh Git Bash, or `export PATH="$PATH:$LOCALAPPDATA/Programs/Ollama"` |
| `server.log` shows `CONTEXT_LENGTH:0`, `NUM_PARALLEL:1` | Step 3 skipped — server started before `setx` | Restart Ollama (Step 3), then re-verify (Step 3b) |
| `PROCESSOR` shows `48%/52% CPU/GPU` | `NUM_PARALLEL × CONTEXT_LENGTH` exceeds VRAM | `setx OLLAMA_NUM_PARALLEL 2`, redo Step 3 |
| `taskkill` / `Stop-Process` → `Access is denied` | Non-interactive or agent-driven shell | Tray icon → Quit Ollama, relaunch from Start menu |
| `/api/ps` returns `{"models":[]}` mid-session | `KEEP_ALIVE` still at the 5m default | `setx OLLAMA_KEEP_ALIVE "-1"`, redo Step 3 |
| `ollama ps` errors with connection refused | No server running — not merely an unloaded model | Start the tray app, not `ollama serve` |
| `ollama ps` empty but server responds | Model unloaded; normal after a reboot or `ollama stop` | Load it, or just send a request |
| Server reappears after being killed | Tray app respawned it | Kill `ollama app.exe` first, or use tray → Quit Ollama |
| vLLM refuses to boot on VRAM | Ollama still holds ~12.7 GiB | `ollama stop qwen3:8b-q8_0` |
| Throughput fields missing from response | Using `/v1/chat/completions` | Use `/api/chat` |
| `content` empty but `eval_count` high | Thinking mode consumed the token budget | Send `think:false`, or read `message.thinking` |
| `Out-File: Could not find a part of the path 'C:\dev\null'` | Bash redirect pasted into PowerShell | `2>$null` in PowerShell, `2>/dev/null` in Git Bash |
| `GET /metrics` → 404 | Ollama exposes no Prometheus endpoint | Expected — not a fault |

### Git Bash path mangling

MSYS rewrites arguments that look like POSIX paths, so a leading `/F` can be
mangled into a Windows path. Typed interactively `taskkill /F /IM ...` works;
inside scripts or when it misbehaves, double the slashes:

```bash
taskkill //F //IM "ollama app.exe"
```

The same applies to `tasklist //FI "IMAGENAME eq ollama.exe"`.

---

## Restarting after a reboot

Nothing needs reinstalling, and unlike the vLLM setup there is no venv to
activate. The tray app is registered to start with Windows and reads the
persisted `HKCU\Environment` variables at launch, so a fresh boot comes up fully
configured.

Confirm rather than assume, in one command:

```bash
ollama ps; grep -oE 'OLLAMA_(CONTEXT_LENGTH|NUM_PARALLEL|KEEP_ALIVE|FLASH_ATTENTION|KV_CACHE_TYPE):[^ ]*' "$LOCALAPPDATA/Ollama/server.log" | tail -6
```

The model itself is **not** preloaded — `ollama ps` is empty until the first
request, at which point the ~12.7 GiB allocation happens (~7.3 s). `KEEP_ALIVE=-1`
keeps it resident from then on. To warm it deliberately, use the empty-prompt
load from [Starting and stopping](#load-the-model).

---

## Running alongside the vLLM setup

Both can be installed at once — different ports (11434 vs 8000), no shared
dependencies, and Ollama's native Windows install does not touch WSL2.

They **cannot both hold a model in VRAM**. Ollama at 12.70 GiB plus vLLM's
`--gpu-memory-utilization 0.88` (~14 GiB) far exceeds 16303 MiB, and vLLM
reserves its slice at startup and refuses to boot if it does not fit. Unload
Ollama first with `ollama stop qwen3:8b-q8_0` before starting `vllm serve` —
that returns VRAM to 1150 MiB without shutting the Ollama server down.
