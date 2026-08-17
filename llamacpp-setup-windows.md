# llama.cpp Setup on Windows 11 (native, prebuilt CUDA binaries)

Step-by-step for this machine. Written 2026-08-17.

**Status: not yet run on this box.** Unlike
[ollama-setup-windows.md](ollama-setup-windows.md) and
[vllm-setup-windows-wsl2.md](vllm-setup-windows-wsl2.md), the values here are not
read off a working install. Hardware, driver, and port facts below *were* read
off this system; the llama.cpp versions and filenames come from upstream release
`b10453`. Steps are marked where the outcome needs confirming.

All shell commands are **Git Bash** unless labelled PowerShell.

## Target configuration

| Component | Value |
|---|---|
| Host OS | Windows 11 Home 26200 |
| GPU | NVIDIA GeForce RTX 5080 Laptop, 16303 MiB (Blackwell, CC 12.0 / sm_120) |
| NVIDIA driver | 591.83, reports CUDA 13.1 |
| Host RAM / CPU | 32 GB LPDDR5X, 16 cores |
| llama.cpp build | `b10453`, prebuilt `win-cuda-13.3-x64` |
| Install path | `%USERPROFILE%\workspace\_ai\llamacpp` |
| Model cache | `%LOCALAPPDATA%\llama.cpp` — llama.cpp's default, not the install folder |
| Model | `Qwen/Qwen3-8B-GGUF:Q8_0` — same weight class as the Ollama setup |
| Endpoint | `http://127.0.0.1:8080` |

No admin rights, no CUDA toolkit, no WSL2, no build step. You download two zips
and unpack them into one folder.

**Port 8080 is free of the other two setups** — Ollama is on 11434, vLLM on
8000. All three can be installed at once; only one can hold the model in VRAM.

---

## Which build to download

The release ships ten Windows zips. For this GPU:

| Zip | Verdict |
|---|---|
| `llama-b10453-bin-win-cuda-13.3-x64.zip` | **Use this.** CUDA 13 line, covers sm_120 |
| `cudart-llama-bin-win-cuda-13.3-x64.zip` | **Also required.** The CUDA 13.3 runtime DLLs |
| `llama-b10453-bin-win-cuda-12.4-x64.zip` | Avoid — CUDA 12.4 predates Blackwell (sm_120 needs 12.8+). May JIT from PTX, may just fail |
| `llama-b10453-bin-win-vulkan-x64.zip` | Fallback if CUDA misbehaves. No cudart needed, slower |
| `llama-b10453-bin-win-cpu-x64.zip` | CPU only. Useful to prove a model file is good |
| `*-arm64`, `*-sycl`, `*-rocm-*`, `*-openvino-*`, `*-opencl-adreno-*` | Wrong hardware |

**The one thing to watch:** the driver reports CUDA **13.1**, and the build wants
**13.3**. CUDA minor-version compatibility inside major version 13 should make
this work — that is the designed behaviour, and it is why the cudart zip exists —
but it is the single most likely thing to break here. If step 4 fails with a
driver-version error, see [Failure modes](#failure-modes): either update the
NVIDIA driver or switch to the Vulkan zip.

You do **not** need the CUDA toolkit. The cudart zip is the redistributable
runtime, which is all the binaries link against.

---

## Step 1 — Free the VRAM

Ollama is currently holding the GPU (`nvidia-smi` shows its `llama-server.exe`
resident). Two llama.cpp servers will not both fit a Q8_0 8B model in 16 GB.

```bash
ollama stop qwen3:8b-q8_0
nvidia-smi --query-gpu=memory.used --format=csv
```

Expect `0 MiB` (or close to it). Ollama's own server process can stay up — it
releases VRAM on unload. To shut it down entirely, follow the *Shut the server
down* section of [ollama-setup-windows.md](ollama-setup-windows.md).

---

## Step 2 — Download and unpack

Pin the build number rather than tracking `latest`, so the folder name records
what you actually installed:

```bash
BUILD=b10453
DEST="$USERPROFILE/workspace/_ai/llamacpp"
BASE="https://github.com/ggml-org/llama.cpp/releases/download/$BUILD"

mkdir -p "$DEST" && cd "$DEST"
curl -L -o llama.zip  "$BASE/llama-$BUILD-bin-win-cuda-13.3-x64.zip"
curl -L -o cudart.zip "$BASE/cudart-llama-bin-win-cuda-13.3-x64.zip"
```

To check what the current build number is before setting `BUILD`:

```bash
curl -s https://api.github.com/repos/ggml-org/llama.cpp/releases/latest | grep '"tag_name"'
```

Unpack **both into the same directory** — the cudart DLLs must sit beside
`llama-server.exe` or it will not start. Windows 11 bundles `tar`, which handles
zips, so no `unzip` needed:

```bash
tar -xf llama.zip
tar -xf cudart.zip
rm llama.zip cudart.zip
ls
```

You should see `llama-server.exe`, `llama-cli.exe`, `llama-bench.exe`,
`ggml-cuda.dll`, and `cudart64_*.dll` / `cublas64_*.dll` from the second zip.

There is no installer and no winget package — the upstream build docs cover only
compiling from source, and the prebuilt zips are portable. Uninstalling is
deleting this folder and undoing step 3.

---

## Step 3 — Put it on PATH

**Required.** Every command from here on calls `llama-server` by name, not by
path. Set the permanent user-level entry first (PowerShell, no admin):

```powershell
$p = [Environment]::GetEnvironmentVariable('Path','User')
[Environment]::SetEnvironmentVariable('Path', "$p;$env:USERPROFILE\workspace\_ai\llamacpp", 'User')
```

That does **not** affect shells that are already open. Either restart Git Bash,
or add it to the current one:

```bash
export PATH="$USERPROFILE/workspace/_ai/llamacpp:$PATH"
```

Confirm it resolves before moving on:

```bash
which llama-server
```

Expect a path under `llamacpp`. If you get nothing, the export did not take —
`echo $PATH | tr ':' '\n' | grep llamacpp` to see what is actually there.

To undo the permanent entry later, edit *Environment Variables for your account*
in the Windows settings UI and remove the `llamacpp` line from `Path`.

---

## Step 4 — Confirm CUDA sees the GPU

Do this before downloading 8.9 GB of model. It is the step that catches a
driver/runtime mismatch:

```bash
llama-server --list-devices
```

**Confirm:** the output names `NVIDIA GeForce RTX 5080 Laptop GPU` with roughly
16303 MiB. If it lists only CPU, or errors about the CUDA driver, stop and go to
[Failure modes](#failure-modes) — a model will not fix it.

---

## Step 5 — Get the model

`llama-server` can pull GGUF straight from Hugging Face with `-hf`, so there is
no separate download step. The quant goes after a colon, and is optional
(default `Q4_K_M`):

```bash
llama-server -hf Qwen/Qwen3-8B-GGUF:Q8_0
```

That repo carries `Q4_K_M`, `Q5_0`, `Q5_K_M`, `Q6_K`, and `Q8_0` — verified
against the HF API on 2026-08-17. `Q8_0` is the match for the Ollama setup's
`qwen3:8b-q8_0`, ~8.9 GB on disk.

### Where the download lands

`-hf` does not put the GGUF in the install folder. On Windows it goes to the
per-user cache directory:

```
%LOCALAPPDATA%\llama.cpp\
```

That is `%LOCALAPPDATA%` with `llama.cpp` appended — read out of
`fs_get_cache_directory()` in `common/common.cpp`, not guessed. The directory is
created on first use, and files are named after the GGUF they came from. To see
what is actually cached:

```bash
ls -lh "$LOCALAPPDATA/llama.cpp/"
```

This matters for two reasons: the 8.7 GB does **not** live under
`%USERPROFILE%\workspace\_ai\llamacpp`, so wiping the install folder to upgrade
or uninstall leaves the weights behind; and re-running the same `-hf` is cheap
because it reuses the cache instead of re-downloading.

To put it somewhere else, set `LLAMA_CACHE` — it takes precedence over
`%LOCALAPPDATA%`:

```bash
export LLAMA_CACHE="$USERPROFILE/workspace/_ai/models"
```

Set it before the first `-hf` run, or you will download twice. Any GGUF you
already have on disk from elsewhere is used directly with `-m <path>` and never
touches the cache.

Note this is the original Qwen3 release with a 40K context, same as the Ollama
doc records — there is still no 8B `2507` build.

---

## Step 6 — Start the server

```bash
llama-server \
  -hf Qwen/Qwen3-8B-GGUF:Q8_0 \
  --alias qwen3-8b-q8 \
  --host 127.0.0.1 --port 8080 \
  -c 32768 \
  -ngl all \
  -fa on \
  --metrics
```

What each flag is doing, and why it is there:

| Flag | Reason |
|---|---|
| `--alias qwen3-8b-q8` | The name `/v1/models` reports. Without it the API shows a long file path |
| `--host 127.0.0.1` | Loopback only. This is already the default; stated so it is not accidentally changed |
| `--port 8080` | The default. Clear of Ollama (11434) and vLLM (8000) |
| `-c 32768` | Context. Default `0` means "whatever the model says" — 40960 here, which is too tight on 16 GB (see budget below) |
| `-ngl all` | Every layer on GPU. Default is now `auto`, so this is belt-and-braces — but `auto` deciding to leave layers on CPU is exactly the silent slowdown worth ruling out |
| `-fa on` | Flash attention. Default is `auto`; forcing `on` means you get an error instead of a quiet fallback if it is unavailable |
| `--metrics` | Exposes Prometheus metrics at `/metrics`. Off by default |

`--metrics` is worth calling out for this repo: it is a real Prometheus endpoint,
which is the thing [ollama-setup-windows.md](ollama-setup-windows.md) records
Ollama as lacking entirely. See [metrics.md](metrics.md).

Every flag also has an env var (`LLAMA_ARG_PORT`, `LLAMA_ARG_CTX_SIZE`,
`LLAMA_ARG_N_GPU_LAYERS`, `LLAMA_ARG_FLASH_ATTN`, `LLAMA_ARG_ENDPOINT_METRICS`,
`LLAMA_ARG_HF_REPO`, …). Command-line values win over the env var.

The server stays in the foreground and logs to the terminal. First run also
downloads the model, so give it time.

### Verified VRAM budget — estimate, needs confirming

For Qwen3-8B (36 layers, 8 KV heads, head_dim 128), f16 KV cache costs about
**144 KiB per token**:

| Context | KV cache | + Q8_0 weights (~8.3 GiB) | Verdict on 15.9 GiB |
|---|---|---|---|
| 16384 | ~2.3 GiB | ~10.6 GiB | Comfortable |
| 32768 | ~4.6 GiB | ~12.9 GiB | **Recommended.** ~1–1.5 GiB left for compute buffers |
| 40960 (model native) | ~5.6 GiB | ~13.9 GiB | Very tight — likely to spill |

These are arithmetic, not measured. Read the real numbers off the startup log
and `nvidia-smi` once it is running.

To go past 32K, quantize the KV cache — `-ctk q8_0 -ctv q8_0` roughly halves it.
Permitted types are `f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1`.

---

## Step 7 — Verify

From a second Git Bash window:

```bash
curl -s http://127.0.0.1:8080/health
```

`{"status":"ok"}` once loaded, HTTP 503 while still loading. No API key needed
for this one.

```bash
curl -s http://127.0.0.1:8080/props
```

Shows `model_path`, `chat_template`, and `total_slots` — the quickest way to
confirm which file actually got loaded.

A real generation, with thinking suppressed the same way the Ollama doc insists
on for measurement:

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-8b-q8",
    "messages": [{"role":"user","content":"Reply with the single word: ok"}],
    "chat_template_kwargs": {"enable_thinking": false},
    "max_tokens": 16
  }'
```

And confirm the layers really landed on GPU:

```bash
nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv
curl -s http://127.0.0.1:8080/metrics | head -30
```

There is also a **web UI at `http://127.0.0.1:8080`** — served at the base URL,
on by default, disabled with `--no-webui`. Handy for a sanity check, but do not
use it to judge throughput.

### Endpoints available

- OpenAI-style: `/v1/models`, `/v1/chat/completions`, `/v1/completions`,
  `/v1/embeddings`, `/v1/responses`
- Anthropic-style: `/v1/messages`, `/v1/messages/count_tokens`
- Native: `/completion`, `/tokenize`, `/detokenize`, `/embedding`, `/infill`,
  `/slots`
- Ops: `/health`, `/props`, `/metrics`

For monitoring, prefer `/metrics` and `/slots` over timing
`/v1/chat/completions` — same reasoning as the *Never use
`/v1/chat/completions` for monitoring* rule in
[ollama-setup-windows.md](ollama-setup-windows.md).

---

## Starting and stopping

There is no service and no background daemon — the process is the server. Close
the window or Ctrl-C to stop it; VRAM is released on exit.

A launcher worth keeping, `start-llamacpp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec llama-server \
  -hf Qwen/Qwen3-8B-GGUF:Q8_0 \
  --alias qwen3-8b-q8 \
  --host 127.0.0.1 --port 8080 \
  -c 32768 -ngl all -fa on --metrics
```

This relies on the permanent PATH entry from step 3, so it works from any
directory — no `cd` needed, and the model comes from the cache.

To stop it from another shell:

```bash
taskkill //IM llama-server.exe //F
```

The double slashes are required — see *Git Bash path mangling* in
[ollama-setup-windows.md](ollama-setup-windows.md). Note this also kills
Ollama's bundled `llama-server.exe`, since they share the image name. Target the
PID instead if Ollama is up:

```bash
tasklist //FI "IMAGENAME eq llama-server.exe"
taskkill //PID <pid> //F
```

### Benchmark instead of guessing

`llama-bench` ships in the same zip and is the right tool for
prompt-processing and token-generation numbers. It takes `-m`, not `-hf`, so
point it at the cached file — confirm the exact name first:

```bash
ls "$LOCALAPPDATA/llama.cpp/"
llama-bench -m "$LOCALAPPDATA/llama.cpp/Qwen3-8B-Q8_0.gguf" -ngl 99
```

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `llama-server: command not found` | PATH not set in this shell | Redo step 3 — the permanent entry does not reach already-open shells |
| `llama-server` exits immediately, no output | cudart DLLs missing | Both zips must unpack into the *same* folder |
| Error naming `cudart64_*.dll` / `cublas64_*.dll` | Same as above | Same as above |
| CUDA driver version insufficient | Driver 13.1 vs build 13.3 | Update the NVIDIA driver, or drop to the Vulkan zip |
| `--list-devices` shows CPU only | Wrong zip, or CUDA init failed | Confirm you took `cuda-13.3`, not `cpu` or `12.4` |
| Loads but is very slow | Layers on CPU | Check the startup log's offload line; force `-ngl all` |
| OOM at load, or on a long prompt | Context too large | `-c 16384`, or `-ctk q8_0 -ctv q8_0` |
| OOM with plenty of VRAM free per nvidia-smi | Ollama or vLLM still resident | `ollama stop <model>`, recheck `nvidia-smi` |
| `Address already in use` | Something on 8080 | `netstat -ano \| grep 8080`, or pick another `--port` |
| 503 from `/health` | Still loading | Wait; first run also downloads the model |
| Garbled or loopy chat output | Chat template not applied | `--jinja` is on by default — confirm via `/props` that `chat_template` is populated |

---

## Running alongside Ollama and vLLM

All three can be installed simultaneously. Ports do not collide: 8080
(llama.cpp), 11434 (Ollama), 8000 (vLLM in WSL2). What collides is **VRAM** —
16303 MiB will not hold two 8B Q8 models. Unload one before starting another:

```bash
ollama stop qwen3:8b-q8_0
nvidia-smi --query-gpu=memory.used --format=csv
```

llama.cpp has the lightest footprint of the three: one folder, no service, no
WSL2, no Python. `nvidia-smi` reports its process as `llama-server.exe` — the
same image name Ollama's bundled backend uses, so distinguish them by PID or by
full path, not by name.
