# vLLM Setup on Windows 11 via WSL2 — Verified Steps

Working setup as built and confirmed on 2026-08-03. Every version, path, and
value below was read off the running system, not assumed.

## Target configuration

| Component | Value |
|---|---|
| Host OS | Windows 11 Home 26200 |
| GPU | NVIDIA GeForce RTX 5080 Laptop, 16303 MiB, `sm_120` / capability `(12, 0)` |
| NVIDIA driver | 591.83, reports CUDA 13.1 |
| Host RAM / CPU | 32 GB LPDDR5X (soldered), 16 cores |
| Guest | Ubuntu 24.04.4 LTS on WSL2, kernel `6.18.33.2-microsoft-standard-WSL2` |
| Python | 3.12.3 (system, via `uv venv`) |
| vLLM | 0.26.0 |
| PyTorch | 2.11.0+cu130 (CUDA 13.0) |
| Model | `Qwen/Qwen3-8B-FP8` — 8.79 GiB on disk, 8.8 GiB in VRAM |

**vLLM has no native Windows build.** Its dependency set is Linux-only
(Triton, NCCL, uvloop). WSL2 is the supported path, not a workaround.

---

## Step 1 — Install WSL2 and Ubuntu 24.04

In an **Administrator** PowerShell:

```powershell
wsl --install -d Ubuntu-24.04
```

Reboot if prompted, then set a UNIX username and password. Update the kernel —
pinned memory and UVA behaviour depend on kernel version:

```powershell
wsl --update
```

Confirm you are on WSL **2**, not 1:

```powershell
wsl -l -v
```

Expect `Ubuntu-24.04    Running    2`. The distro name matters for later
`wsl -d` commands — plain `Ubuntu` is a different name and will fail with
`WSL_E_DISTRO_NOT_FOUND`.

## Step 2 — Verify GPU passthrough

On Windows:

```powershell
nvidia-smi
```

Read the **CUDA Version** in the top-right (13.1 here). This is a *driver
ceiling* — the newest CUDA runtime the driver can host. It does **not** mean a
CUDA toolkit is installed, and none is needed: the PyTorch wheels bundle their
own runtime.

Then inside WSL:

```bash
/usr/lib/wsl/lib/nvidia-smi
```

The GPU must appear here too. WSL projects `libcuda.so.1` and
`libnvidia-ml.so.1` into `/usr/lib/wsl/lib` from the Windows driver.

**Do not install an NVIDIA driver inside Ubuntu.** It would shadow the
projected WSL libraries and break passthrough.

## Step 3 — Size the WSL VM

Create `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
memory=20GB
swap=8GB
processors=12
```

Sizing rationale on a 32 GB / 16-core machine: leave ~12 GB and 4 cores for
Windows. Do not set `memory=32GB` — that hands WSL every byte of physical RAM.

Apply it:

```powershell
wsl --shutdown
```

Reopen the Ubuntu terminal. Verify with `free -g` inside WSL.

> RAM is **not** the constraint for inference. vLLM reserves its
> `--gpu-memory-utilization` slice of VRAM at startup and either fits or
> refuses to boot — it never spills to host RAM. RAM only affects checkpoint
> load staging.

## Step 4 — Install the build toolchain

Both packages are required. Neither ships in the minimal Ubuntu WSL image.

```bash
sudo apt update && sudo apt install -y build-essential python3.12-dev
```

Why both: Triton compiles a CUDA helper (`cuda_utils.c`) from C **at runtime**
on first model compile. It needs `gcc` (from `build-essential`) *and* CPython
headers at `/usr/include/python3.12/Python.h` (from `python3.12-dev`). The
`uv`-managed venv does not supply these — Triton's compile targets the system
include path.

Verify:

```bash
gcc --version && ls /usr/include/python3.12/Python.h
```

## Step 5 — Install uv and create the venv

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
```

```bash
uv venv --python 3.12 --seed ~/vllm-env && source ~/vllm-env/bin/activate
```

`uv` is used over plain `pip` because it resolves CUDA-variant torch wheels
correctly from the `--torch-backend` flag in the next step.

## Step 6 — Install vLLM against CUDA 13

```bash
uv pip install vllm --torch-backend=cu130
```

**`cu130` is mandatory, not a preference.** vLLM 0.26.0 ships a prebuilt
extension (`vllm._C_stable_libtorch`) linked against CUDA 13. Installing
`cu129` produces:

```
ImportError: libcudart.so.13: cannot open shared object file
```

The library exists at `site-packages/nvidia/cu13/lib/libcudart.so.13`, but a
cu129 torch never adds that directory to the loader path. Patching
`LD_LIBRARY_PATH` masks the symptom — mixed cu12/cu13 in one process resurfaces
as obscure mid-inference crashes rather than a clean startup error. Install the
matching wheel instead.

If you already installed the wrong variant:

```bash
uv pip install --reinstall-package torch --reinstall-package torchvision --reinstall-package torchaudio torch torchvision torchaudio --torch-backend=cu130
```

Verify:

```bash
python -c "import vllm, torch; print(vllm.__version__, torch.__version__, torch.version.cuda, torch.cuda.get_device_capability())"
```

Expected: `0.26.0 2.11.0+cu130 13.0 (12, 0)`. The `(12, 0)` confirms Blackwell
`sm_120` is visible — this requires CUDA 12.8+ kernels, which cu130 satisfies.

## Step 7 — Set the required environment variables

Both are mandatory on this setup. Omitting either reproduces a hard startup
failure.

```bash
echo 'export VLLM_USE_V2_MODEL_RUNNER=0' >> ~/.bashrc
echo 'export VLLM_USE_FLASHINFER_SAMPLER=0' >> ~/.bashrc
echo 'export HF_HOME=~/.cache/huggingface' >> ~/.bashrc
source ~/.bashrc
```

### `VLLM_USE_V2_MODEL_RUNNER=0`

Without it:

```
RuntimeError: UVA is not available
```

vLLM 0.26.0 defaults to the V2 GPU model runner, which allocates a `UvaBuffer`
unconditionally. That requires pinned memory, and WSL2 disables pinned memory
by default even on a capable kernel — gated behind `VLLM_WSL2_ENABLE_PIN_MEMORY`
in `vllm/platforms/cuda.py::is_pin_memory_available`. The V1 runner has no UVA
code path at all.

The alternative fix is `VLLM_WSL2_ENABLE_PIN_MEMORY=1`, which keeps the V2
runner. **This setup deliberately uses V1 instead**, per an explicit decision.
Do not set both — leave `VLLM_WSL2_ENABLE_PIN_MEMORY` unset.

Tradeoff accepted: V1 does unpinned synchronous staging copies per decode step,
and V1 is the legacy branch that may eventually be deprecated.

### `VLLM_USE_FLASHINFER_SAMPLER=0`

Without it:

```
RuntimeError: Could not find nvcc and default cuda_home='/usr/local/cuda' doesn't exist
```

FlashInfer's top-k/top-p sampler is **JIT-compiled from CUDA source on first
use** and needs a real `nvcc` plus `ninja`, neither of which is present. Note
that the earlier log line `Using FlashInfer for top-p & top-k sampling.` only
means the compute-capability check passed; sm_120 is supported and the *build*
is what fails, lazily, at the first sample.

Disabling it falls back to vLLM's PyTorch-native path, which compiles nothing.
The performance cost is negligible here: the kernel only fuses a top-k/top-p
filter and multinomial draw over a 151k-token vocab — microseconds, against
~30 ms of attention and GEMM per step. It is a high-concurrency serving
optimization; a single-user local server cannot measure it.

The alternative — `export CUDA_HOME=~/vllm-env/lib/python3.12/site-packages/nvidia/cu13`
plus `sudo apt install -y ninja-build`, using the nvcc already bundled in the
venv — does work. It is **not** recommended: it costs a multi-minute CUDA
compile on first boot and adds another mixed-toolchain surface of exactly the
kind that caused the Step 6 failure.

## Step 8 — Start the server

```bash
vllm serve Qwen/Qwen3-8B-FP8 --host 0.0.0.0 --port 8000 --gpu-memory-utilization 0.88 --max-model-len 16384 --served-model-name local-llm
```

First run downloads 8.79 GiB (~6 min) and compiles; later runs load from cache.

Flag notes:

- `--host 0.0.0.0` — required to reach the server from Windows. The default
  `127.0.0.1` binds WSL-only.
- `--gpu-memory-utilization 0.88` — 0.88 × 16303 MiB. Leaves headroom for the
  Windows desktop compositor, which also holds VRAM on a laptop GPU.
- `--served-model-name local-llm` — the `model` string clients send, decoupling
  callers from the HF repo id.
- FP8 is correct here: weights are stored FP8 while activations compute in
  bf16. `dtype=torch.bfloat16, quantization=fp8` in the startup banner is not a
  contradiction.

## Step 9 — Confirm startup

Look for these, in order:

```
FlashInfer top-p/top-k sampling disabled via VLLM_USE_FLASHINFER_SAMPLER=0
Selected CutlassFp8BlockScaledMMKernel for Fp8LinearMethod
Using FLASH_ATTN attention backend
Model loading took 8.8 GiB memory and ~4.3 seconds
torch.compile took ~22 s in total
GPU KV cache size: ... tokens
Maximum concurrency for 16384 tokens per request: ...x
Capturing CUDA graphs (...): 100%
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
```

Absence of a `Using V2 Model Runner` line confirms the V1 override held.

Check `Maximum concurrency` — below 1.0x means 16384 tokens will not fit in a
single request and `--max-model-len` must be reduced.

CUDA graph capture (51 batch sizes, ~1–2 min) runs on **every** startup; unlike
`torch.compile` it is not cached to disk. Add `--enforce-eager` to skip it, at
roughly 20–30% decode cost at batch size 1 where kernel launch overhead
dominates.

### Benign warning — ignore

```
Module vllm.third_party.deep_gemm was found but failed to import
AssertionError  (at _find_cuda_home)
```

An optional MoE-oriented GEMM library wanting a full CUDA toolkit. Qwen3-8B is
dense, not MoE, and vLLM already selected the Cutlass FP8 kernel.

## Step 10 — Test from WSL

Second Ubuntu terminal, server left running:

```bash
curl -s http://localhost:8000/v1/models | python3 -m json.tool
```

Expect `"id": "local-llm"` with `"root": "Qwen/Qwen3-8B-FP8"`.

```bash
curl -s http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"local-llm","messages":[{"role":"user","content":"Say hello in exactly five words."}],"max_tokens":50}' | python3 -m json.tool
```

The `usage` block carries `prompt_tokens` and `completion_tokens`.

## Step 11 — Reach it from Windows

WSL2 forwards localhost automatically; no port proxy needed. From PowerShell:

```powershell
curl http://localhost:8000/v1/models
```

If this hangs but the same call works inside WSL, the problem is WSL localhost
forwarding, not vLLM. `wsl --shutdown` and restart, or set
`networkingMode=mirrored` in `.wslconfig`.

## Step 12 — Point a client at it

```bash
pip install openai
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="not-needed")

resp = client.chat.completions.create(
    model="local-llm",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

`api_key` is required by the SDK and ignored by vLLM unless the server was
started with `--api-key`.

---

## Restarting after a reboot

Nothing needs reinstalling. The venv, the model cache, and the `~/.bashrc`
exports all survive a restart. Only the **virtualenv activation** does not,
because activation is per-shell state.

Symptom in a fresh terminal:

```
$ vllm serve Qwen/Qwen3-8B-FP8 ...
vllm: command not found
```

This means `~/vllm-env/bin` is not on `PATH` — not that anything is damaged.
Confirm the install is intact rather than assuming breakage:

```bash
ls -la ~/vllm-env/bin/vllm && echo "VIRTUAL_ENV=${VIRTUAL_ENV:-unset}" && env | grep -E "VLLM_|HF_HOME"
```

A healthy post-restart state shows the launcher present, `VIRTUAL_ENV=unset`,
and all three exports still set. Fix:

```bash
cd ~ && source ~/vllm-env/bin/activate
```

The prompt shows `(vllm-env)` once active. Then run the Step 8 serve command
unchanged.

### Always `cd ~` first

Do not launch from `/mnt/c/...`. That path is the Windows filesystem bridge and
is slow for the file I/O vLLM does at startup. The weights
(`~/.cache/huggingface`) and compile cache (`~/.cache/vllm`) live in the Linux
home regardless of the launch directory, so there is nothing to gain by running
from the Windows side.

### Skipping activation

Activation is a convenience, not a requirement — the venv's Python is baked into
the launcher's shebang, so the full path works directly:

```bash
~/vllm-env/bin/vllm serve Qwen/Qwen3-8B-FP8 --host 0.0.0.0 --port 8000 --gpu-memory-utilization 0.88 --max-model-len 16384 --served-model-name local-llm
```

### One-command restart

```bash
echo "alias vllm-up='cd ~ && source ~/vllm-env/bin/activate && vllm serve Qwen/Qwen3-8B-FP8 --host 0.0.0.0 --port 8000 --gpu-memory-utilization 0.88 --max-model-len 16384 --served-model-name local-llm'" >> ~/.bashrc && source ~/.bashrc
```

Then `vllm-up` after any reboot.

Prefer this over appending `source ~/vllm-env/bin/activate` to `~/.bashrc`.
Auto-activating in every shell means any later `pip install` silently lands in
the vLLM venv, which is how environments get polluted. An alias keeps
activation explicit.

### Expected on the first post-restart boot

Weights load from cache — no re-download. CUDA graph capture still runs (~1–2
min); it is never cached to disk.

---

## Verified `/metrics` mapping

```bash
curl -s http://localhost:8000/metrics | grep -v "^#" | grep vllm
```

Metric names below were read from the live server on 2026-08-03. vLLM renames
metrics between releases — re-grep rather than trusting any table.

| Purpose | Metric |
|---|---|
| Prefill throughput | `vllm:prompt_tokens_total` (counter — rate = delta/interval) |
| Decode throughput | `vllm:generation_tokens_total` (counter) |
| Per-token latency / ETA | `vllm:request_time_per_output_token_seconds` and `vllm:inter_token_latency_seconds` (histograms) |
| Time to first token | `vllm:time_to_first_token_seconds` |
| Queue vs running | `vllm:num_requests_running`, `vllm:num_requests_waiting`, `vllm:num_requests_waiting_by_reason` |
| Queue delay | `vllm:request_queue_time_seconds` |
| KV cache occupancy | `vllm:kv_cache_usage_perc` |
| Prefix cache efficiency | `vllm:prefix_cache_queries_total`, `vllm:prefix_cache_hits_total` |
| Preemption (cache pressure) | `vllm:num_preemptions_total` |
| Prefill/decode split | `vllm:request_prefill_time_seconds`, `vllm:request_decode_time_seconds` |

### Caveats for VRAM-residency monitoring

`vllm:kv_cache_usage_perc` is occupancy **within vLLM's preallocated block
pool**. It is not a VRAM residency signal — it does not mean what Ollama's
`/api/ps` model-size figures mean.

vLLM never spills. It reserves its VRAM slice at startup and either fits or
refuses to boot. So of the five residency states in
[local-llm-monitoring-summary.md](local-llm-monitoring-summary.md), a vLLM
adapter only ever reports `gpu_resident` or fails to start —
`hybrid_cpu_gpu` and `dynamic_paging` are unreachable, and the page-fault and
pagefile inputs read flat zeros.

---

## Disk and VRAM footprint

| Item | Size |
|---|---|
| `~/.cache/huggingface` (weights) | 8.9 GB |
| `~/.cache/vllm` (torch.compile cache) | 91 MB |
| VRAM in use, model loaded and idle | 13940 MiB / 16303 MiB |

---

## Failure-mode quick reference

| Error | Cause | Fix |
|---|---|---|
| `WSL_E_DISTRO_NOT_FOUND` | Distro is `Ubuntu-24.04`, not `Ubuntu` | Use the exact name from `wsl -l -v` |
| `ImportError: libcudart.so.13` | torch installed as cu129 | Reinstall with `--torch-backend=cu130` (Step 6) |
| `RuntimeError: UVA is not available` | V2 runner + WSL2 pinned memory off | `VLLM_USE_V2_MODEL_RUNNER=0` (Step 7) |
| `Failed to find C compiler` | No gcc | `apt install build-essential` (Step 4) |
| `fatal error: Python.h: No such file` | No CPython headers | `apt install python3.12-dev` (Step 4) |
| `Could not find nvcc` at first sample | FlashInfer sampler JIT | `VLLM_USE_FLASHINFER_SAMPLER=0` (Step 7) |
| `deep_gemm` import AssertionError | Optional MoE lib, no toolkit | Ignore — dense model |

The four compile/runtime failures above surface **sequentially**, each masking
the next. Applying Steps 4 and 7 up front avoids all of them.

---

## Final `~/.bashrc` state

The vLLM-related tail is exactly three lines:

```bash
export HF_HOME=~/.cache/huggingface
export VLLM_USE_V2_MODEL_RUNNER=0
export VLLM_USE_FLASHINFER_SAMPLER=0
```

Confirmed in an interactive shell:

```bash
env | grep -E "VLLM_|HF_HOME|LD_LIBRARY_PATH"
```

Two debugging artifacts were present and have been removed:

- A duplicate `export VLLM_USE_V2_MODEL_RUNNER=0`.
- `export LD_LIBRARY_PATH=~/vllm-env/lib/python3.12/site-packages/nvidia/cu13/lib:$LD_LIBRARY_PATH`,
  left over from diagnosing the cu129 mismatch in Step 6. Verified redundant
  before removal: with `LD_LIBRARY_PATH` unset, `import vllm` still returns
  `0.26.0 2.11.0+cu130 13.0 (12, 0)`, because cu130 torch resolves
  `libcudart.so.13` through its own bundled RPATH.

Do **not** re-add the `LD_LIBRARY_PATH` line on a fresh setup. It would mask a
genuine cu12/cu13 mismatch — letting a wrong-variant install appear to work
before failing obscurely mid-inference, instead of failing cleanly at import.

### Non-interactive shells

Ubuntu's default `.bashrc` returns early when not interactive, so these exports
do **not** apply under cron, systemd units, or `bash -c`. That is fine for
`vllm serve` launched from a terminal, but a service unit must set both
`VLLM_USE_V2_MODEL_RUNNER=0` and `VLLM_USE_FLASHINFER_SAMPLER=0` explicitly in
its own `Environment=` directives — otherwise startup fails with the UVA error
from Step 7.
