# Local LLM Monitoring Summary

All four proposed metrics can be monitored, although some are direct measurements while others must be inferred. Monitoring is most reliable when the master app launches or proxies LLM requests; passive process monitoring provides less per-job detail.

## Metric Feasibility

| Metric | Feasibility | Approach |
|---|---|---|
| VRAM fit and spill | High, runtime-dependent | Combine runtime placement information with per-process VRAM and system RAM usage |
| GPU utilization vs. data starvation | Medium to high | Correlate GPU compute, memory bandwidth, PCIe traffic, CPU activity, and runtime queues |
| Throughput | High | Read native token counters and timing data from the runtime |
| ETA | Conditional | Estimate from remaining work and a smoothed processing rate |

## 1. VRAM Fit and Spill

Track model placement as a state:

- `gpu_resident`
- `hybrid_cpu_gpu`
- `cpu_resident`
- `dynamic_paging`
- `unknown`

Many runtimes deliberately split a model between GPU and system memory rather than unexpectedly spilling it. VRAM usage alone cannot determine residency because VRAM also contains the KV cache, compute buffers, and unrelated allocations.

Recommended inputs:

- Model bytes assigned to each GPU
- Per-process VRAM allocation
- Process working set and private RAM
- KV-cache placement
- Page faults and swap/pagefile activity
- PCIe transfer rate

Ollama exposes model size and VRAM-resident size through `GET /api/ps`, while `ollama ps` reports full GPU, full CPU, or mixed CPU/GPU placement. llama.cpp supports explicit CPU/GPU hybrid inference.

## 2. GPU Utilization vs. Data Starvation

This should be treated as a multi-signal classification rather than a single utilization percentage.

Suggested classifications:

- **Compute-bound:** High GPU compute or tensor-pipeline activity
- **GPU-memory-bound:** High VRAM bandwidth activity with lower tensor activity
- **CPU/GPU-transfer-bound:** Active request, intermittent GPU compute, and high PCIe traffic
- **CPU-bound:** Active request, low GPU activity, and high process CPU usage
- **Scheduler/queue-bound:** Requests are waiting while GPU capacity remains available
- **Idle:** No active runtime requests
- **Unknown:** Counters are unavailable or contradictory

Low GPU utilization does not automatically mean data starvation. Autoregressive decoding may underutilize the GPU because of a small batch or repeated short kernel launches.

NVIDIA metrics can be collected through NVML or DCGM. AMD provides comparable memory, utilization, and PCIe measurements through AMD SMI or ROCm SMI. Available counters depend on the GPU, driver, operating system, and permissions.

## 3. Throughput

Report separate rates for:

- Prompt or prefill throughput in input tokens/sec
- Decode throughput in output tokens/sec
- Aggregate server throughput across active requests

For Ollama:

```text
prompt_tokens_per_sec =
    prompt_eval_count / (prompt_eval_duration / 1,000,000,000)

decode_tokens_per_sec =
    eval_count / (eval_duration / 1,000,000,000)
```

Ollama returns these counts and durations from its generation API. llama.cpp provides response timings and an optional Prometheus metrics endpoint. vLLM exposes server metrics and optional per-request timing data.

Runtime-native token counters are preferable to repeatedly tokenizing partial streamed text.

## 4. ETA

ETA is reliable only when the remaining workload is known.

For prompt processing:

```text
ETA = remaining_prompt_tokens / smoothed_prompt_tokens_per_sec
```

For generation with a maximum output length:

```text
upper_bound_ETA =
    (max_output_tokens - generated_tokens)
    / smoothed_decode_tokens_per_sec
```

Use an exponentially weighted moving average instead of an instantaneous rate.

Open-ended chat generation has no known stopping point. In that situation, display:

- Current generation speed
- An upper-bound ETA based on `max_tokens`
- A predicted range based on historical completion lengths
- No ETA when confidence is too low

## Recommended Architecture

1. **Runtime adapters**
   - Ollama
   - llama.cpp
   - vLLM
   - Future local inference backends

2. **Hardware and OS collectors**
   - NVIDIA NVML or DCGM
   - AMD SMI or ROCm SMI
   - Process CPU and RAM usage
   - Page faults, disk I/O, and PCIe activity

3. **Correlation and estimation**
   - Associate runtime processes with GPUs and requests
   - Classify bottlenecks
   - Calculate throughput and ETA
   - Attach a confidence level and data source to inferred metrics

## Suggested MVP

For a Windows-first implementation, begin with **Ollama and NVIDIA NVML**. This combination provides enough information to monitor model placement, VRAM consumption, GPU utilization, token throughput, and a first-pass bottleneck classification.

## References

- [Ollama running-model API](https://docs.ollama.com/api/ps)
- [Ollama GPU placement](https://docs.ollama.com/faq)
- [Ollama usage metrics](https://docs.ollama.com/api/usage)
- [llama.cpp server metrics](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [vLLM production metrics](https://docs.vllm.ai/en/latest/usage/metrics/)
- [NVIDIA DCGM profiling metrics](https://docs.nvidia.com/datacenter/dcgm/latest/user-guide/feature-overview.html)
- [NVIDIA NVML](https://docs.nvidia.com/deploy/nvml-api/index.html)
- [AMD SMI monitoring](https://rocm.docs.amd.com/projects/amdsmi/en/latest/how-to/amdsmi-cli-tool.html)
