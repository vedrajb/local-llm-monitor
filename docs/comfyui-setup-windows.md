# Run ComfyUI on Windows for monitoring

This guide covers getting ComfyUI running on Windows so that the monitor can
read its HTTP API. ComfyUI is a node-based image generation server. The
monitor reads only the standard REST endpoints (`/system_stats`, `/queue` and
`/history`), which need no key or plugin. Confirm the commands below against
the [official ComfyUI repository](https://github.com/comfyanonymous/ComfyUI)
if a release changes them.

## 1. Requirements

- Windows 10 or 11.
- An NVIDIA GPU with a current driver for the CUDA build. AMD and Intel GPUs
  work through their own PyTorch builds. `nvidia-smi` is unavailable on them,
  and ComfyUI's `/system_stats` is then the monitor's only VRAM figure.
- At least one checkpoint in `ComfyUI\models\checkpoints`.

## 2. Install ComfyUI

Choose one of these:

- **Portable build:** download the Windows portable archive from the
  ComfyUI releases page, extract it, and run `run_nvidia_gpu.bat` (or
  `run_cpu.bat`).
- **ComfyUI Desktop:** install the desktop app from comfy.org. It runs its
  server on port **8000** by default rather than 8188. You can check the port in
  the app's settings.
- **Manual install:** clone the repository, install PyTorch for your GPU and
  then `pip install -r requirements.txt`, and start it with `python main.py`.

## 3. Check the API

The server listens on `http://127.0.0.1:8188` by default. From PowerShell:

```powershell
irm http://127.0.0.1:8188/system_stats
irm http://127.0.0.1:8188/queue
irm "http://127.0.0.1:8188/history?max_items=5"
```

If the first command returns `system` and `devices`, the monitor can read it.

## 4. Run the monitor

```powershell
npm run comfyui
# or a single snapshot
npm run once:comfyui
# for a non-default port (for example ComfyUI Desktop)
node src/index.js --platform comfyui --comfyui-host 127.0.0.1:8000
```

`COMFYUI_HOST` works the same way as `--comfyui-host`. If you leave out
`http://`, it is added for you.

## 5. Monitoring another machine

ComfyUI binds to localhost by default. To allow connections from another
machine, start it with `--listen` (for example `python main.py --listen
0.0.0.0 --port 8188`). Then point `--comfyui-host` at that machine.
ComfyUI has no authentication of its own, so expose it only on a trusted
network or behind a tunnel such as Tailscale.

## 6. What to expect

An idle server shows an empty queue and whatever is already in the history.
Jobs count towards "completed since monitor start" only once they finish after
the monitor started. To see the queue and job figures change, queue a workflow
from the ComfyUI web page. [metrics.md](metrics.md#comfyui) explains each
figure.

There are no input/output token counts for ComfyUI, because the server does
not report them. If your workflow uses LLM custom nodes, run a second monitor
against the model server they call (for example `--platform ollama`).
