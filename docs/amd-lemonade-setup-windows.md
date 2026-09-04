# AMD Lemonade Setup on Windows — Qwen3-8B-GGUF-Q8_0

Step-by-step guide for hosting `Qwen3-8B-GGUF-Q8_0` with Lemonade Server on
Windows 11.
Written 2026-09-03.

## Target configuration

| Component | Value |
|---|---|
| Host OS | Windows 11, native installation |
| Host topology | Intel iGPU drives the display; NVIDIA RTX 5080 Laptop GPU handles inference |
| Lemonade recipe | `llamacpp` |
| Lemonade backend | `cuda` — use `vulkan` only as a fallback |
| Model | `Qwen3-8B-GGUF-Q8_0` |
| Quantization | Q8_0, approximately 8.71 GB |
| Initial context | 32,768 tokens |
| Server | `http://127.0.0.1:13305` |
| OpenAI-compatible base URL | `http://127.0.0.1:13305/api/v1` |

This guide has not yet been executed on this machine. The hardware values are
based on the earlier topology check; re-run the validation commands below if the
driver, BIOS graphics mode, or installed model runtimes have changed.

## Important: choose CUDA, not ROCm

Lemonade is an AMD project, but it supports NVIDIA GPUs through its bundled
CUDA llama.cpp backend. The current Lemonade backend guide lists NVIDIA
Blackwell GPUs as supported and recommends CUDA before Vulkan for NVIDIA
hardware. ROCm and the Ryzen AI NPU backends are not the right paths for this
Intel/NVIDIA laptop.

The Intel iGPU can continue driving Windows and the laptop display while the
RTX 5080 performs inference. Do not switch the laptop to a dGPU-only graphics
mode just for Lemonade.

## Prerequisites

Before starting:

- Windows 11 22H2 or newer.
- A current NVIDIA driver. `nvidia-smi` must work from PowerShell.
- At least 12 GB of free disk space for the Q8_0 model, plus working space for
  downloads and caches.
- The RTX 5080 should have free VRAM. Unload any model currently held by
  Ollama, vLLM, or another local inference server.
- An internet connection for the installer, backend, and model download.

You do not need to install the system-wide CUDA Toolkit. Lemonade downloads the
backend with the runtime libraries it needs.

## Step 1 — Install Lemonade Server

1. Open the official [Lemonade installation page](https://lemonade-server.ai/docs/guide/install/).
2. Download the current Windows MSI.
3. Run the MSI and keep the default per-user installation unless you have a
   specific reason to change it.
4. Finish the installation. Lemonade Server normally starts automatically and
   listens on port `13305`.

For a downloaded installer named `lemonade-server-minimal.msi`, an optional
PowerShell installation command is:

```powershell
msiexec /i .\lemonade-server-minimal.msi
```

Open a **new** PowerShell window after installation so the updated user PATH is
available.

## Step 2 — Verify the CLI and server

```powershell
lemonade --version
lemonade status --json
```

Confirm that:

- `lemonade --version` prints a version.
- `lemonade status --json` reports a reachable server on port `13305`.

If `lemonade` is not recognized, close PowerShell, open it again, and repeat the
commands. You can also open the web app directly at
`http://127.0.0.1:13305`.

## Step 3 — Validate the NVIDIA GPU and free VRAM

```powershell
nvidia-smi
nvidia-smi -L
nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,display_active --format=csv
```

On this laptop, the expected compute device is the NVIDIA RTX 5080 Laptop GPU.
The RTX may report no active display because the Intel iGPU owns the panel;
that does not prevent CUDA inference.

If Ollama has a model loaded, unload it before testing Lemonade:

```powershell
ollama ps
ollama stop <model-name>
```

If vLLM is running in WSL2, stop its server from the WSL terminal as well. The
processes may coexist, but their loaded models compete for the same VRAM.

## Step 4 — Install and select the CUDA backend

List the backend state first:

```powershell
lemonade backends
lemonade backends --all
```

Install the CUDA backend if it is not already installed:

```powershell
lemonade backends install llamacpp:cuda
```

Make CUDA the persistent llama.cpp backend:

```powershell
lemonade config set llamacpp.backend=cuda
lemonade config
```

The configuration should show the nested setting:

```text
llamacpp.backend = cuda
```

The backend can also be selected for one model load with
`--llamacpp cuda`, which is used again below. Keeping both the global setting
and the per-load setting explicit makes the intended backend easy to verify.

## Step 5 — Choose and download Qwen3-8B-GGUF-Q8_0

Use the explicit Q8_0 GGUF checkpoint and register it under the requested local
Lemonade model ID:

```powershell
lemonade list | Select-String Qwen3
lemonade pull unsloth/Qwen3-8B-GGUF:Q8_0 --alias Qwen3-8B-GGUF-Q8_0
lemonade list --downloaded | Select-String Qwen3-8B-GGUF-Q8_0
```

`unsloth/Qwen3-8B-GGUF:Q8_0` is the upstream Hugging Face checkpoint and
variant. `Qwen3-8B-GGUF-Q8_0` is the local model ID used by Lemonade after the
alias is registered.

## Step 6 — Load Qwen3-8B-GGUF-Q8_0 on the RTX 5080

Start with the requested 32K context. Q8_0 is approximately 8.71 GB, so reduce
the context if the model does not fit after other GPU workloads are unloaded.

```powershell
lemonade load Qwen3-8B-GGUF-Q8_0 --llamacpp cuda --ctx-size 32768 --save-options
```

To load the model and open the Lemonade web app in the browser instead:

```powershell
lemonade run Qwen3-8B-GGUF-Q8_0 --llamacpp cuda --ctx-size 32768 --save-options
```

`run` and `load` accept the same model options; `run` additionally opens the
web app. The Lemonade service remains the host process at port `13305`.

## Step 7 — Verify the model and backend

Check the Lemonade server and local model catalog:

```powershell
lemonade status --json
lemonade list --downloaded
```

Inspect the OpenAI-compatible model metadata:

```powershell
$models = Invoke-RestMethod "http://127.0.0.1:13305/api/v1/models"
$models.data |
    Where-Object id -eq "Qwen3-8B-GGUF-Q8_0" |
    Select-Object id,recipe,downloaded,size,context_length,recipe_options
```

Look for:

- Model ID `Qwen3-8B-GGUF-Q8_0`.
- Recipe `llamacpp`.
- `downloaded` set to `True`.
- A context length of `32768` after the saved load options are applied.
- `recipe_options` showing the CUDA backend when that field is returned by the
  installed Lemonade version.

Confirm that the RTX is actually being used:

```powershell
nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv
nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv
```

The exact process name varies by Lemonade release, but VRAM usage should rise
substantially after the model loads. `lemonade logs` opens the server logs in
the Lemonade UI; use it if the CUDA backend is not clear from the model
metadata.

## Step 8 — Test a completion from PowerShell

This sends a local OpenAI-compatible request and asks
`Qwen3-8B-GGUF-Q8_0` to suppress its reasoning trace for a short smoke test:

```powershell
$body = @{
    model = "Qwen3-8B-GGUF-Q8_0"
    messages = @(
        @{
            role = "user"
            content = "Reply with exactly: Lemonade is working."
        }
    )
    stream = $false
    max_tokens = 64
    chat_template_kwargs = @{
        enable_thinking = $false
    }
} | ConvertTo-Json -Depth 8

$response = Invoke-RestMethod `
    -Uri "http://127.0.0.1:13305/api/v1/chat/completions" `
    -Method Post `
    -ContentType "application/json" `
    -Body $body

$response.choices[0].message.content
```

Expected output contains:

```text
Lemonade is working.
```

`Qwen3-8B-GGUF-Q8_0` is a reasoning model. To see or change reasoning
interactively in the terminal, use:

```powershell
lemonade chat Qwen3-8B-GGUF-Q8_0
```

Inside the Lemonade chat REPL, `/think off` suppresses the thinking trace,
`/think on` enables it, and `/think default` removes the override.

## Step 9 — Connect an OpenAI-compatible application

Use these values in an application that supports a custom OpenAI-compatible
server:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:13305/api/v1` |
| API key | `lemonade` or any non-empty placeholder if the app requires one |
| Model | `Qwen3-8B-GGUF-Q8_0` |

For the OpenAI Python client:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:13305/api/v1",
    api_key="lemonade",
)

response = client.chat.completions.create(
    model="Qwen3-8B-GGUF-Q8_0",
    messages=[{"role": "user", "content": "Say hello."}],
)

print(response.choices[0].message.content)
```

Keep the server bound to loopback while testing. Do not expose it to the LAN
unless you deliberately configure Lemonade authentication and allowed origins.

## Step 10 — Monitor Lemonade

From the repository root, start the monitor in a second PowerShell window:

```powershell
node src/index.js --platform lemonade
```

Or use the package shortcut:

```powershell
npm run lemonade
```

The monitor defaults to `http://localhost:13305`. It reads the loaded model and
activity state from Lemonade, last-request performance from `/api/v1/stats`, and
CPU/RAM/GPU/VRAM/NPU telemetry from `/api/v1/system-stats`. On a system with
`LEMONADE_API_KEY` enabled, pass the key with `--lemonade-api-key` or set the
same-named environment variable before starting the monitor.

## Daily start, stop, and reload commands

The Lemonade service starts with Windows. The model itself can be loaded and
unloaded independently:

```powershell
# Load the saved Qwen3-8B-GGUF-Q8_0 configuration
lemonade load Qwen3-8B-GGUF-Q8_0

# Unload the model and release its VRAM
lemonade unload Qwen3-8B-GGUF-Q8_0

# Show the current server state
lemonade status --json
```

If the model was loaded with an old backend or context setting, reload it with
the explicit options:

```powershell
lemonade unload Qwen3-8B-GGUF-Q8_0
lemonade load Qwen3-8B-GGUF-Q8_0 --llamacpp cuda --ctx-size 32768 --save-options
```

Only one VRAM-heavy model should be loaded on this 16 GB GPU at a time. Lemonade
can coexist with Ollama and vLLM at different ports, but the loaded models still
compete for the same physical VRAM.

## Troubleshooting

### `lemonade` is not recognized

Close and reopen PowerShell so the per-user PATH update is visible. Confirm the
installation from Windows Installed apps if the command remains unavailable.

### CUDA backend is unavailable or rejected

Run:

```powershell
nvidia-smi
lemonade backends --all
lemonade config
```

Install the latest Lemonade MSI if `cuda` is not listed or
`llamacpp.backend=cuda` is rejected. The current release supports CUDA on
Windows for compatible NVIDIA GPUs. If CUDA still fails after the driver and
backend checks, use Vulkan as a fallback:

```powershell
lemonade config set llamacpp.backend=vulkan
lemonade unload Qwen3-8B-GGUF-Q8_0
lemonade load Qwen3-8B-GGUF-Q8_0 --llamacpp vulkan --ctx-size 8192 --save-options
```

Do not select `rocm` or a Ryzen AI NPU model for this Intel/NVIDIA system.

### CUDA out-of-memory during load

1. Unload Ollama and stop any vLLM model.
2. Start with the `Qwen3-8B-GGUF-Q8_0` model.
3. Reduce context to 8192:

```powershell
lemonade unload Qwen3-8B-GGUF-Q8_0
lemonade load Qwen3-8B-GGUF-Q8_0 --llamacpp cuda --ctx-size 8192 --save-options
```

4. Check `nvidia-smi` again before trying Q8_0 or a larger context.

### The model loads but CPU usage is high

Check `lemonade config`, `lemonade status --json`, and `lemonade logs`. Confirm
that the active recipe is `llamacpp`, the backend is `cuda`, and NVIDIA VRAM
increases after loading. A large context or another resident model can force a
smaller effective GPU allocation or prevent the model from loading.

### The API request returns 404

Use the current client base URL first:

```text
http://127.0.0.1:13305/api/v1
```

Some Lemonade API reference pages show the equivalent direct routes without the
`/api` prefix. If a specific older build returns 404, retry the endpoint with
`http://127.0.0.1:13305/v1/...` and check the installed version.

### The response spends the whole budget reasoning

Qwen3 enables thinking by default in many integrations. Include:

```json
"chat_template_kwargs": {"enable_thinking": false}
```

for a non-thinking request, or use `/think off` in `lemonade chat`.

## Official references

- [Install Lemonade](https://lemonade-server.ai/docs/guide/install/)
- [Lemonade CLI](https://lemonade-server.ai/docs/guide/cli/)
- [llama.cpp backend options](https://lemonade-server.ai/docs/guide/configuration/llamacpp/)
- [Lemonade Server model catalog](https://lemonade-server.ai/docs/models.html)
- [OpenAI-compatible API](https://lemonade-server.ai/docs/api/openai/)
- [Qwen3-8B model card](https://huggingface.co/Qwen/Qwen3-8B)
- [Qwen3-8B GGUF repository](https://huggingface.co/unsloth/Qwen3-8B-GGUF)
