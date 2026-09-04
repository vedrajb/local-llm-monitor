# Install Qwen3 8B in LM Studio

This guide explains how to download and run Qwen3 8B locally in LM Studio on Windows.

Qwen3 8B is downloaded through LM Studio. You do not need a separate Python or CUDA installation for the basic setup.

## 1. Install LM Studio

1. Visit the official [LM Studio download page](https://lmstudio.ai/download).
2. Download the Windows installer.
3. Run the installer and launch LM Studio.

## 2. Check available storage and memory

The Qwen3 8B model listing reports a minimum system-memory requirement of approximately 5 GB. Leave additional memory available for LM Studio, the context window, and Windows itself.

Have at least 8 GB of free disk space available for the model and related files.

## 3. Open the model downloader

1. Open the **Discover** tab in LM Studio.
2. Alternatively, press **Ctrl + 2** on Windows.

LM Studio's Discover tab searches for and downloads supported models from Hugging Face. In newer LM Studio interfaces, the same feature may appear under **Settings → Local Models → Explore**.

## 4. Search for Qwen3 8B

Search for the exact model identifier:

```text
qwen/qwen3-8b
```

Select the model named **qwen3-8b**. Do not select **Qwen3-VL-8B** unless you specifically need image or video understanding; Qwen3-VL is a different vision-language model.

The regular Qwen3 8B model is listed on [LM Studio's model page](https://lmstudio.ai/models/qwen/qwen3-8b).

## 5. Choose a model format and quantization

For Windows, select the **GGUF** version.

Recommended options for the `Qwen3-8B-GGUF` model are:

| Quantization | Approximate size | Recommendation |
| --- | ---: | --- |
| `Q4_K_M` | 5.03 GB | Best starting choice for most computers |
| `Q6_K` | 6.73 GB | Better quality if you have more memory |
| `Q8_0` | 8.71 GB | Highest quality among these options, but requires more memory |
| `Q3_K_L` | 4.43 GB | Fallback for computers with limited memory |

Start with **Q4_K_M**. Quantization reduces model size and memory usage, with some possible reduction in output quality. LM Studio recommends a 4-bit option or higher when the computer can support it.

The current GGUF file sizes are available on the [Qwen3-8B-GGUF Hugging Face page](https://huggingface.co/lmstudio-community/Qwen3-8B-GGUF).

## 6. Download the model

1. Click **Download** next to the selected quantization.
2. Choose a model directory if LM Studio asks where to store it.
3. Wait for the download to complete.

The download may take several minutes depending on your internet connection.

## 7. Load Qwen3 8B

1. Open the **Chat** tab.
2. Click the model selector or **Load Model** button.
3. Select the downloaded Qwen3 8B model.
4. Click **Load**.

Keep the default load settings initially. If LM Studio offers GPU offloading, use **Auto** or the maximum GPU offload that fits in your available GPU memory.

## 8. Set the context size to 32,768 tokens

Set the context size while loading the model:

1. If Qwen3 8B is already loaded, unload it.
2. Select Qwen3 8B and click **Load** or the **gear/settings** icon.
3. Expand **Advanced** or **Load Configuration**.
4. Set **Context Length** or **Context Size** to:

   ```text
   32768
   ```

   Some LM Studio versions display this as **32k**.

5. Keep GPU offloading on **Auto**, then click **Load**.
6. Start a new chat.

Context length is a load-time setting and includes the conversation prompt and generated response. Larger values require more memory. See [LM Studio's context and load-parameter documentation](https://lmstudio.ai/blog/lmstudio-v0.3.27).

### Optional command-line method

If the GUI does not show the setting, open PowerShell after launching LM Studio and run:

```powershell
lms ls
lms load "<model-key-from-lms-ls>" --context-length 32768
```

Replace `<model-key-from-lms-ls>` with the model key returned by `lms ls`. See the [official `lms load` documentation](https://lmstudio.ai/docs/cli/local-models/load).

## 9. Test the model

Send a simple prompt such as:

```text
Explain how photosynthesis works in simple terms.
```

If the model responds, the installation is complete.

## Use LM Studio with the local monitor

The monitor reads LM Studio's native API. Start the API server before launching
the monitor:

1. Open the **Developer** tab in LM Studio.
2. Turn on the server toggle.
3. Keep the default server address, `http://localhost:1234`, unless you have
   configured another port.
4. From the repository directory, run:

   ```powershell
   npm run lmstudio
   ```

For a single plain-text snapshot, run:

```powershell
npm run once:lmstudio
```

The monitor starts two `lms log stream` processes: one captures completed-request
token counts and decode speed, and the server stream observes request boundaries
from any LM Studio API client. Start the monitor before sending a request; the
CLI streams do not replay requests that finished before the monitor started.
While a chat or completion request is in progress, the monitor shows
`busy yes (server log inferred)`.

LM Studio's current native API uses `GET /api/v1/models` to list models and
loaded instances. See the [LM Studio API quickstart](https://lmstudio.ai/docs/developer/rest/quickstart).

## Thinking mode

Qwen3 supports both reasoning and non-reasoning modes:

- Use the **Think** toggle in the LM Studio chat interface to enable or disable reasoning.
- Add `/no_think` to the end of a prompt when you want a faster, non-reasoning response.

Example:

```text
Give me three quick dinner ideas. /no_think
```

## Troubleshooting

### Out-of-memory error

- Reload the model using `Q3_K_L` or `Q4_K_M`.
- Reduce the context length to 4,096 or 8,192 tokens.
- Close other memory-intensive applications.
- Allow LM Studio to offload some layers to system RAM if GPU memory is insufficient.

### The model does not appear in the Chat tab

- Confirm that the download completed.
- Open the model-management area and refresh or re-index the model directory.
- Confirm that you downloaded the GGUF version into LM Studio's configured model folder.

### Responses are very slow

- Confirm that GPU offloading is enabled.
- Try the `Q4_K_M` version instead of a larger quantization.
- Reduce the context length.

## Official references

- [LM Studio: Get started](https://lmstudio.ai/docs/app/basics)
- [LM Studio: Download an LLM](https://lmstudio.ai/docs/app/basics/download-model)
- [LM Studio: Qwen3 8B model page](https://lmstudio.ai/models/qwen/qwen3-8b)
- [Qwen3 8B GGUF files and sizes](https://huggingface.co/lmstudio-community/Qwen3-8B-GGUF)
