import { fetchText } from '../http.js';
import { LMSTUDIO_HEADERS } from '../config.js';
import { startLmStudioLogStream, startLmStudioServerLogStream } from '../lmstudio-log.js';

// LM Studio's native v1 models endpoint lists downloaded models and exposes
// each loaded instance's context and other load configuration. The lms model
// log stream supplies completed-request timing, while the server log stream
// supplies request-start and request-complete events without the monitor
// becoming the client that generated the request. Activity is therefore
// explicitly marked as log-inferred rather than a native server-side counter.
export class LmStudioProvider {
  constructor(host) {
    this.host = host;
    this.label = 'LM Studio';
    this.api = `${host}/api/v1`;
    this.lastRequest = null;
    this.requestCountTotal = 0;
    this.activeRequests = 0;
    this.logError = null;
    this.serverLogError = null;
    this.stopLogStream = startLmStudioLogStream(
      (event) => {
        if (event.kind === 'complete') {
          this.lastRequest = {
            prefillRate: null,
            decodeRate: event.decodeRate,
            promptTokens: event.promptTokens,
            genTokens: event.genTokens,
          };
          this.requestCountTotal += 1;
        }
      },
      (error) => {
        this.logError = error?.message || String(error);
      }
    );
    this.stopServerLogStream = startLmStudioServerLogStream(
      (event) => {
        if (event.kind === 'start') {
          this.activeRequests += 1;
          return;
        }
        if (event.kind === 'complete') {
          this.activeRequests = Math.max(0, this.activeRequests - 1);
        }
      },
      (error) => {
        this.serverLogError = error?.message || String(error);
      }
    );
    process.once('exit', this.stopLogStream);
    process.once('exit', this.stopServerLogStream);
  }

  num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  modelInfo(model, instance) {
    const config = instance.config && typeof instance.config === 'object' ? instance.config : {};
    const quantization =
      model.quantization && typeof model.quantization === 'object' ? model.quantization : {};
    return {
      id: instance.id || model.key || model.display_name || '(unnamed)',
      size: this.num(model.size_bytes),
      params: typeof model.params_string === 'string' ? model.params_string : null,
      quant: typeof quantization.name === 'string' ? quantization.name : null,
      format: typeof model.format === 'string' ? model.format : null,
      context: this.num(config.context_length),
      contextTrain: this.num(model.max_context_length),
    };
  }

  async poll() {
    const modelsRes = await fetchText(`${this.api}/models`, 3000, LMSTUDIO_HEADERS);
    const result = {
      ok: modelsRes.ok,
      error: modelsRes.error,
      models: [],
      loaded: [],
      lastRequest: this.lastRequest,
      requestCountTotal: this.requestCountTotal,
      busy: this.serverLogError ? null : this.activeRequests > 0,
      activitySource: this.serverLogError ? 'server log unavailable' : 'server log inferred',
    };
    if (!modelsRes.ok) return result;

    let data;
    try {
      data = JSON.parse(modelsRes.text);
    } catch {
      return { ...result, ok: false, error: 'bad JSON from /api/v1/models' };
    }

    const catalog = Array.isArray(data?.models)
      ? data.models.filter((m) => m && typeof m === 'object')
      : Array.isArray(data?.data)
        ? data.data.filter((m) => m && typeof m === 'object')
        : [];
    const llms = catalog.filter((m) => m.type == null || m.type === 'llm');
    result.models = llms.map((m) => ({ id: m.key || m.display_name || '(unnamed)', root: m.display_name }));

    for (const model of llms) {
      const instances = Array.isArray(model.loaded_instances)
        ? model.loaded_instances.filter((instance) => instance && typeof instance === 'object')
        : [];
      for (const instance of instances) result.loaded.push(this.modelInfo(model, instance));
    }

    result.lastRequest = this.lastRequest;
    result.requestCountTotal = this.requestCountTotal;
    result.busy = this.serverLogError ? null : this.activeRequests > 0;
    result.activitySource = this.serverLogError ? 'server log unavailable' : 'server log inferred';
    if (!result.lastRequest) {
      result.telemetryUnavailable = this.logError
        ? `lms log stream unavailable; ${this.logError}`
        : 'waiting for a completed request from lms log stream';
    }
    return result;
  }
}
