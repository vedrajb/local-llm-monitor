# Install OpenClaw on native Windows

This guide explains how to install OpenClaw, a self-hosted personal AI assistant
gateway, on Windows and point it at a model provider or a local LLM server.

OpenClaw is not an inference engine. It is a gateway that talks to a model
provider (Anthropic, OpenAI, and others) or to a local OpenAI-compatible server
such as Ollama or LM Studio. Command names and config keys below were written
from memory and have not been checked against the current release; confirm them
at [docs.openclaw.ai](https://docs.openclaw.ai) before relying on them.

## 1. Requirements

- Windows 11 with PowerShell.
- Node.js 22 or newer.
- An API key for a model provider, or a running local model server.

Check Node:

```powershell
node -v
```

If Node is missing or older than 22, install it and reopen PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

The project recommends WSL2 (Ubuntu) over native Windows because native Windows
is less tested. This guide covers native Windows.

## 2. Install OpenClaw

Use either the npm package or the installer script:

```powershell
npm install -g openclaw@latest
```

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

Confirm the command is on `PATH`:

```powershell
openclaw --version
```

If the command is not found, add the folder printed by `npm config get prefix`
to `PATH` and open a new terminal.

## 3. Run the onboarding wizard

```powershell
openclaw onboard --install-daemon
```

The wizard configures the model provider and API key, the workspace, optional
chat channels, and the background gateway service.

## 4. Verify the install

```powershell
openclaw doctor
openclaw gateway status
openclaw dashboard
```

By default the gateway and dashboard listen on `http://127.0.0.1:18789`.

## 5. Use a local model server

During onboarding, or in `~/.openclaw/openclaw.json`, select a custom
OpenAI-compatible provider and use the base URL of a server from this
repository:

| Server | Base URL |
| --- | --- |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |
| vLLM | `http://localhost:8000/v1` |

Start the model server first, and use the model name exactly as that server
lists it. See the matching host setup guide for each server:
[ollama-setup-windows.md](ollama-setup-windows.md),
[lm-studio-setup-windows.md](lm-studio-setup-windows.md),
[llamacpp-setup-windows.md](llamacpp-setup-windows.md), and
[vllm-setup-windows-wsl2.md](vllm-setup-windows-wsl2.md).

Agent-style tool use needs a model with reliable tool calling and a large
context window. Small models may respond poorly.

## Tailscale exposure

The gateway binds to loopback by default. `gateway.tailscale.mode` controls
whether it is published through Tailscale:

| Mode | Who can reach it |
| --- | --- |
| `off` | Only this machine (default). |
| `serve` | Devices on your tailnet, over HTTPS. |
| `funnel` | The public internet. Requires password auth. |

Requirements: Tailscale installed and logged in on the host, plus HTTPS and
MagicDNS enabled for the tailnet. For `funnel`, the tailnet policy must allow
the funnel attribute.

```json
{
  "gateway": {
    "bind": "loopback",
    "tailscale": { "mode": "serve" }
  }
}
```

Restart the gateway after changing this, then run `openclaw gateway status` to
see the URL. Prefer `serve`; avoid `funnel` unless public access is required.

## Update

```powershell
npm install -g openclaw@latest
```

Then restart the gateway.

## Security

OpenClaw can run shell commands, read and write files, and use connected
accounts.

- Keep the gateway bound to loopback unless remote access is needed.
- Leave DM pairing and allowlist settings enabled.
- Review community skills before installing them.

## Troubleshooting

### Script execution is blocked

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### Daemon install fails

Open PowerShell as Administrator and retry, or skip `--install-daemon` and start
the gateway manually:

```powershell
openclaw gateway
```

### A native module fails to build during npm install

Install the Visual Studio Build Tools with the C++ workload, or use WSL2.

### The dashboard does not open

Run `openclaw gateway status` to confirm the gateway is running and to see the
port in use.

## Official references

- [OpenClaw documentation](https://docs.openclaw.ai)
