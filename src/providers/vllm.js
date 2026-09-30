import { fetchText, parsePrometheus } from '../http.js';

export class VllmProvider {
  constructor(host) {
    this.host = host;
    this.label = 'vLLM';
    // Remember previous counter values so we can turn them into rates.
    this.prev = null; // { t, prompt, generation }
    // Exponentially weighted moving averages so the reported rate tracks
    // vLLM's smoothed log figure instead of jumping around with each short
    // poll window.
    this.EWMA_ALPHA = 0.3;
    this.promptEwma = null;
    this.decodeEwma = null;
  }

  ewma(prevVal, sample) {
    if (sample == null || Number.isNaN(sample)) return prevVal;
    return prevVal == null ? sample : this.EWMA_ALPHA * sample + (1 - this.EWMA_ALPHA) * prevVal;
  }

  async poll() {
    const [metricsRes, modelsRes] = await Promise.all([
      fetchText(`${this.host}/metrics`),
      fetchText(`${this.host}/v1/models`),
    ]);

    const result = { ok: metricsRes.ok, error: metricsRes.error, models: [] };

    if (modelsRes.ok) {
      try {
        const data = JSON.parse(modelsRes.text);
        result.models = (data.data || []).map((m) => ({ id: m.id, root: m.root }));
      } catch {}
    }

    if (!metricsRes.ok) return result;

    const m = parsePrometheus(metricsRes.text);
    const now = Date.now();
    const promptTotal = m.get('vllm:prompt_tokens_total');
    const genTotal = m.get('vllm:generation_tokens_total');

    // Rate = delta / elapsed seconds.
    if (this.prev && promptTotal != null && genTotal != null) {
      const dt = (now - this.prev.t) / 1000;
      if (dt > 0) {
        const promptSample = Math.max(0, (promptTotal - this.prev.prompt) / dt);
        const decodeSample = Math.max(0, (genTotal - this.prev.generation) / dt);
        this.promptEwma = this.ewma(this.promptEwma, promptSample);
        this.decodeEwma = this.ewma(this.decodeEwma, decodeSample);
        result.promptRate = this.promptEwma;
        result.decodeRate = this.decodeEwma;
      }
    }
    this.prev = { t: now, prompt: promptTotal ?? 0, generation: genTotal ?? 0 };

    result.running = m.get('vllm:num_requests_running');
    result.waiting = m.get('vllm:num_requests_waiting');
    // KV cache usage is reported as a fraction (0..1) in recent vLLM.
    const kv = m.get('vllm:kv_cache_usage_perc') ?? m.get('vllm:gpu_cache_usage_perc');
    result.kvUsage = kv != null ? kv * 100 : null;
    // Prefix cache hit rate = hits / queries (cumulative counters).
    const cacheHits = m.get('vllm:prefix_cache_hits_total');
    const cacheQueries = m.get('vllm:prefix_cache_queries_total');
    result.cacheHitRate =
      cacheQueries != null && cacheQueries > 0 && cacheHits != null
        ? (cacheHits / cacheQueries) * 100
        : null;
    result.promptTotal = promptTotal;
    result.genTotal = genTotal;
    return result;
  }
}
