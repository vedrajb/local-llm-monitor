import { fetchText } from '../http.js';

const HISTORY_LIMIT = 20;
const END_EVENTS = new Set(['execution_success', 'execution_error', 'execution_interrupted']);

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function epochMs(value) {
  const n = num(value);
  if (n == null) return null;
  return n < 1e12 ? Math.round(n * 1000) : n;
}

export function parseComfySystemStats(text) {
  const data = parseJson(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const s = data.system && typeof data.system === 'object' ? data.system : {};
  const devices = Array.isArray(data.devices) ? data.devices : [];
  return {
    os: s.os ?? null,
    version: s.comfyui_version ?? null,
    python: typeof s.python_version === 'string' ? s.python_version.split(' ')[0] : null,
    pytorch: s.pytorch_version ?? null,
    ramTotal: num(s.ram_total),
    ramFree: num(s.ram_free),
    devices: devices
      .filter((d) => d && typeof d === 'object')
      .map((d) => ({
        name: d.name ?? null,
        type: d.type ?? null,
        index: num(d.index),
        vramTotal: num(d.vram_total),
        vramFree: num(d.vram_free),
        torchVramTotal: num(d.torch_vram_total),
        torchVramFree: num(d.torch_vram_free),
      })),
  };
}

export function parseComfyQueue(text) {
  const data = parseJson(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const running = Array.isArray(data.queue_running) ? data.queue_running : [];
  const pending = Array.isArray(data.queue_pending) ? data.queue_pending : [];
  return {
    running: running
      .filter(Array.isArray)
      .map((item) => ({ number: num(item[0]), promptId: item[1] ?? null })),
    pending: pending.length,
  };
}

function parseJob(key, entry) {
  const prompt = Array.isArray(entry.prompt) ? entry.prompt : [];
  const status = entry.status && typeof entry.status === 'object' ? entry.status : {};
  const messages = Array.isArray(status.messages) ? status.messages : [];
  let startedAt = null;
  let endedAt = null;
  let endEvent = null;
  let cachedNodes = 0;
  let error = null;
  for (const m of messages) {
    if (!Array.isArray(m)) continue;
    const [event, info = {}] = m;
    const ts = epochMs(info?.timestamp);
    if (event === 'execution_start') startedAt = ts;
    else if (event === 'execution_cached' && Array.isArray(info?.nodes)) cachedNodes += info.nodes.length;
    if (END_EVENTS.has(event)) {
      endedAt = ts;
      endEvent = event;
    }
    if (event === 'execution_error') {
      error = { nodeType: info?.node_type ?? null, message: info?.exception_message ?? null };
    }
  }
  let outcome = null;
  if (endEvent === 'execution_interrupted') outcome = 'interrupted';
  else if (status.status_str === 'error' || endEvent === 'execution_error') outcome = 'error';
  else if (status.status_str === 'success' || endEvent === 'execution_success') outcome = 'success';
  else if (status.completed) outcome = 'success';
  const graph = prompt[2] && typeof prompt[2] === 'object' ? prompt[2] : null;
  let outputImages = 0;
  const outputs = entry.outputs && typeof entry.outputs === 'object' ? entry.outputs : {};
  for (const out of Object.values(outputs)) {
    if (out && Array.isArray(out.images)) outputImages += out.images.length;
  }
  return {
    promptId: prompt[1] ?? key,
    number: num(prompt[0]),
    status: outcome,
    completed: status.completed === true,
    startedAt,
    endedAt,
    durationMs: startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : null,
    cachedNodes,
    totalNodes: graph ? Object.keys(graph).length : null,
    outputImages,
    error,
  };
}

export function parseComfyHistory(text) {
  const data = parseJson(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return Object.entries(data)
    .filter(([, entry]) => entry && typeof entry === 'object')
    .map(([key, entry]) => parseJob(key, entry))
    .sort((a, b) => (a.number ?? -Infinity) - (b.number ?? -Infinity));
}

export function summarizeComfyJobs(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const durations = list.map((j) => j.durationMs).filter((d) => d != null);
  return {
    last: list.length ? list[list.length - 1] : null,
    avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    errors: list.filter((j) => j.status === 'error').length,
    interrupted: list.filter((j) => j.status === 'interrupted').length,
    count: list.length,
  };
}

export class ComfyUIProvider {
  constructor(host) {
    this.host = host;
    this.label = 'ComfyUI';
    this.monitorStartedAt = Date.now();
    this.countedJobs = new Set();
    this.baselineJobs = null;
    this.requestCountTotal = 0;
    this.errorCount = 0;
    this.interruptedCount = 0;
    this.runningSeenAt = new Map();
  }

  countJobs(jobs) {
    if (!this.baselineJobs) {
      this.baselineJobs = new Set(jobs.filter((j) => j.endedAt == null).map((j) => j.promptId));
    }
    for (const j of jobs) {
      if (this.countedJobs.has(j.promptId)) continue;
      const fresh = j.endedAt != null ? j.endedAt >= this.monitorStartedAt : !this.baselineJobs.has(j.promptId);
      if (!fresh) continue;
      this.countedJobs.add(j.promptId);
      this.requestCountTotal += 1;
      if (j.status === 'error') this.errorCount += 1;
      else if (j.status === 'interrupted') this.interruptedCount += 1;
    }
  }

  trackRunning(queue) {
    const now = Date.now();
    const ids = new Set(queue.running.map((r) => r.promptId));
    for (const id of [...this.runningSeenAt.keys()]) if (!ids.has(id)) this.runningSeenAt.delete(id);
    for (const id of ids) if (!this.runningSeenAt.has(id)) this.runningSeenAt.set(id, now);
    if (!ids.size) return null;
    return now - Math.min(...this.runningSeenAt.values());
  }

  async poll() {
    const statsRes = await fetchText(`${this.host}/system_stats`, 3000);
    if (!statsRes.ok) return { ok: false, error: statsRes.error, models: [] };
    const system = parseComfySystemStats(statsRes.text);
    if (!system) return { ok: false, error: 'bad JSON from /system_stats', models: [] };

    const [queueRes, historyRes] = await Promise.all([
      fetchText(`${this.host}/queue`, 3000),
      fetchText(`${this.host}/history?max_items=${HISTORY_LIMIT}`, 3000),
    ]);

    let queue = null;
    let queueError = null;
    if (!queueRes.ok) queueError = queueRes.error;
    else if (!(queue = parseComfyQueue(queueRes.text))) queueError = 'bad JSON from /queue';

    let jobs = null;
    let historyError = null;
    if (!historyRes.ok) historyError = historyRes.error;
    else if (!(jobs = parseComfyHistory(historyRes.text))) historyError = 'bad JSON from /history';

    const activeElapsedMs = queue ? this.trackRunning(queue) : null;
    if (jobs) {
      for (const j of jobs) this.runningSeenAt.delete(j.promptId);
      this.countJobs(jobs);
    }
    const summary = jobs ? summarizeComfyJobs(jobs.slice(-HISTORY_LIMIT)) : null;
    const last = summary?.last ?? null;

    return {
      ok: true,
      models: [],
      requestCountTotal: this.requestCountTotal,
      lastRequest: last
        ? { promptTokens: null, genTokens: null, runtimeMs: last.durationMs, outcome: last.status }
        : null,
      gateway: {
        kind: 'comfyui',
        ready: true,
        failing: [],
        system,
        devices: system.devices,
        queue: queue
          ? {
              running: queue.running.length,
              pending: queue.pending,
              busy: queue.running.length > 0,
              activeElapsedMs,
            }
          : null,
        jobs: summary
          ? {
              last,
              avgDurationMs: summary.avgDurationMs,
              window: summary.count,
              completed: this.requestCountTotal,
              errors: this.errorCount,
              interrupted: this.interruptedCount,
            }
          : null,
        queueError,
        historyError,
      },
    };
  }
}
