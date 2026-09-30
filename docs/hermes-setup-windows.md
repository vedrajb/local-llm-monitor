# Install Hermes Agent on native Windows

This guide explains how to install Hermes Agent from Nous Research on Windows
and point it at a model provider or a local LLM server.

Hermes Agent is not an inference engine. It is an agent that talks to a model
provider (Nous Portal, OpenRouter, Anthropic, and others) or to a local
OpenAI-compatible server such as Ollama or LM Studio. Commands below follow the
[official documentation](https://hermes-agent.nousresearch.com/docs/); confirm
them there if a release changes them.

## 1. Requirements

- Windows 10 or 11 with PowerShell or Windows Terminal.
- No administrator rights are needed.
- Git for Windows and Python 3.14 are provisioned by the installer if missing.
- An API key or Nous Portal login, or a running local model server.

## 2. Install Hermes

Command-line install:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

The installer clones the repository, sets up Python, creates launchers in
`%LOCALAPPDATA%\hermes\bin`, adds that folder to the User `PATH`, and then runs
the interactive setup.

A desktop app is also available: download the `.appinstaller` file from the
[Hermes website](https://hermes-agent.nousresearch.com/) and open it with
Windows App Installer.

Open a new terminal window after the install, then confirm the command works:

```powershell
hermes --version
```

## 3. Configure a provider

```powershell
hermes setup --portal
```

`--portal` signs in to Nous Portal with one OAuth and enables the bundled web
search, image generation, TTS, and browser tools. For the full wizard, or to
change the provider later:

```powershell
hermes setup
hermes model
```

## 4. Use a local model server

In the `Select provider` list choose **Custom endpoint (enter URL manually)**.
Do not choose **Ollama Cloud**, which is the hosted ollama.com service.

Enter the base URL of a server from this repository, any non-empty API key
(local servers ignore it), and the model name exactly as that server lists it:

| Server | Base URL |
| --- | --- |
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| llama.cpp `llama-server` | `http://localhost:8080/v1` |
| vLLM | `http://localhost:8000/v1` |

Start the model server first. See the matching host setup guide for each
server: [ollama-setup-windows.md](ollama-setup-windows.md),
[lm-studio-setup-windows.md](lm-studio-setup-windows.md),
[llamacpp-setup-windows.md](llamacpp-setup-windows.md), and
[vllm-setup-windows-wsl2.md](vllm-setup-windows-wsl2.md).

Agent-style tool use needs a model with reliable tool calling and a large
context window. Ollama's default context is often 4k and truncates agent
prompts, so raise it. This repository's `start-ollama.bat` sets
`OLLAMA_CONTEXT_LENGTH=32768`; confirm it with `ollama ps`. Hermes refuses to
start with a model whose context window is below 64,000 tokens, so at 32768 a
local Ollama model is rejected and Hermes should use a hosted provider instead.
Raising the context to 64k or more needs more VRAM for the KV cache.

## 5. Run

```powershell
hermes chat
hermes --tui
hermes gateway
```

`hermes chat` is interactive chat, `hermes --tui` is the terminal UI, and
`hermes gateway` runs the messaging gateway. Configure messaging platforms with
`hermes gateway setup` and tools with `hermes tools`.

## Monitor Hermes with this repository

The monitor reads Hermes's API server, which is off by default. Enable it with
a key and restart the gateway:

```powershell
hermes config set API_SERVER_ENABLED true
hermes config set API_SERVER_KEY <long-random-secret>
hermes gateway restart
```

Confirm it answers at `http://127.0.0.1:8642/health`, then run:

```powershell
npm run hermes
```

The monitor reads `API_SERVER_KEY` from `%LOCALAPPDATA%\hermes\.env`, so no
flag is needed. Per-turn stats come from `%LOCALAPPDATA%\hermes\state.db`,
opened read-only. See [metrics.md](metrics.md#hermes-agent) for what each value
means and why Hermes has no tokens-per-second figure.

If the model context is set in Hermes's `config.yaml` (for example
`context_length` under a `custom_providers` model entry), that value overrides
what the server reports and must also be at least 64,000.

## Update

```powershell
hermes update
```

## Troubleshooting

### `hermes` is not found

Open a new terminal. Existing terminals do not see the updated `PATH`. Confirm
`%LOCALAPPDATA%\hermes\bin` is on the User `PATH`.

### Diagnose problems

```powershell
hermes doctor
hermes config check
```

If the config is lost after an update, run `hermes config migrate`.

### An API key is missing

```powershell
hermes model
hermes config set OPENROUTER_API_KEY <your_key>
```

### Characters show as `?`

Make sure the `HERMES_DISABLE_WINDOWS_UTF8` environment variable is not set.

### Editor for `Ctrl-X Ctrl-E`

It defaults to Notepad. Set `EDITOR=code --wait` to use VS Code.

## Known limits on native Windows

- The Matrix encrypted messaging adapter is unavailable.
- On ARM64, some optional SDKs such as `mem0` are excluded.

## Official references

- [Hermes Agent documentation](https://hermes-agent.nousresearch.com/docs/)
- [Windows (Native) guide](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)
- [NousResearch/hermes-agent on GitHub](https://github.com/nousresearch/hermes-agent)
