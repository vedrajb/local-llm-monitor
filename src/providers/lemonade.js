import { fetchText } from '../http.js';
import { LEMONADE_HEADERS } from '../config.js';

export class LemonadeProvider {
  constructor(host) {
    this.host = host;
    this.label = 'AMD Lemonade';
    this.api = `${host}/api/v1`;
  }

  num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  modelInfo(entry, catalogModel) {
    const checkpoint = entry.checkpoint || catalogModel?.checkpoint || null;
    const quantMatch = typeof checkpoint === 'string' ? checkpoint.match(/:([^:]+)$/) : null;
    const recipeOptions = entry.recipe_options || catalogModel?.recipe_options || {};
    const sizeGb = this.num(entry.size) ?? this.num(catalogModel?.size);
    const context = this.num(recipeOptions.ctx_size) ?? this.num(catalogModel?.context_length);
    return {
      id: entry.model_name || entry.id || '(unnamed)',
      size: sizeGb == null ? null : sizeGb * 1024 ** 3,
      params: entry.parameter_size || catalogModel?.parameter_size || null,
      quant: quantMatch ? quantMatch[1] : null,
      device: entry.device || null,
      recipe: entry.recipe || catalogModel?.recipe || null,
      context,
      contextTrain: this.num(catalogModel?.max_context_window),
      busy: typeof entry.is_busy === 'boolean' ? entry.is_busy : null,
      streaming: typeof entry.is_streaming === 'boolean' ? entry.is_streaming : null,
    };
  }

  async poll() {
    const [healthRes, modelsRes, statsRes, systemStatsRes] = await Promise.all([
      fetchText(`${this.api}/health`, 3000, LEMONADE_HEADERS),
      fetchText(`${this.api}/models`, 3000, LEMONADE_HEADERS),
      fetchText(`${this.api}/stats`, 3000, LEMONADE_HEADERS),
      fetchText(`${this.api}/system-stats`, 3000, LEMONADE_HEADERS),
    ]);

    const result = {
      ok: [healthRes, modelsRes, statsRes, systemStatsRes].some((r) => r.ok),
      error: healthRes.error || modelsRes.error || statsRes.error || systemStatsRes.error,
      models: [],
    };

    let health = null;
    if (healthRes.ok) {
      try {
        health = JSON.parse(healthRes.text);
      } catch {}
    }

    let catalog = [];
    if (modelsRes.ok) {
      try {
        const data = JSON.parse(modelsRes.text);
        catalog = Array.isArray(data.data)
          ? data.data.filter((m) => m && typeof m === 'object')
          : [];
      } catch {}
    }
    const catalogById = new Map(catalog.map((m) => [m.id, m]));
    result.models = catalog.map((m) => ({ id: m.id, root: m.checkpoint }));

    if (healthRes.ok) {
      const entries = Array.isArray(health?.all_models_loaded)
        ? health.all_models_loaded.filter((m) => m && typeof m === 'object')
        : health?.model_loaded
          ? [{ model_name: health.model_loaded }]
          : [];
      result.loaded = entries.map((m) => this.modelInfo(m, catalogById.get(m.model_name)));
      result.models = result.loaded.map((m) => ({ id: m.id }));
      result.busy = result.loaded.some((m) => m.busy === true);
      result.streaming = result.loaded.some((m) => m.streaming === true);
    }

    if (statsRes.ok) {
      try {
        const stats = JSON.parse(statsRes.text);
        const requestCountTotal = this.num(stats.request_count_total);
        const promptTokens = this.num(stats.prompt_tokens) ?? this.num(stats.input_tokens);
        const genTokens = this.num(stats.output_tokens);
        const decodeRate = this.num(stats.tokens_per_second);
        if (requestCountTotal != null) result.requestCountTotal = requestCountTotal;
        const hasRequest =
          (requestCountTotal != null && requestCountTotal > 0) ||
          [promptTokens, genTokens, decodeRate].some((n) => n != null && n > 0);
        if (hasRequest) {
          result.lastRequest = {
            prefillRate: null,
            decodeRate,
            promptTokens,
            genTokens,
          };
        }
        const cachedTokens = this.num(stats.cache_tokens);
        if (cachedTokens != null && promptTokens != null && promptTokens >= 0) {
          const totalPromptTokens = cachedTokens + promptTokens;
          if (totalPromptTokens > 0) {
            result.cacheHit = {
              cached: cachedTokens,
              prompt: totalPromptTokens,
              pct: (cachedTokens / totalPromptTokens) * 100,
            };
          }
        }
      } catch {}
    }

    if (systemStatsRes.ok) {
      try {
        const stats = JSON.parse(systemStatsRes.text);
        result.systemStats = {
          cpuPercent: this.num(stats.cpu_percent),
          memoryGb: this.num(stats.memory_gb),
          gpuPercent: this.num(stats.gpu_percent),
          vramGb: this.num(stats.vram_gb),
          npuPercent: this.num(stats.npu_percent),
        };
      } catch {}
    }

    return result;
  }
}
