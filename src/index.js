#!/usr/bin/env node
// Local LLM Monitor.
// Zero dependencies. Polls a supported LLM hosting platform's metrics and
// nvidia-smi, then prints a plain text snapshot on an interval.
//
// Platform metrics are retrieved through a pluggable provider chosen at
// startup (factory pattern). vLLM metric names verified against 0.26.0
// (see vllm-setup-windows-wsl2.md). vLLM reserves its VRAM at startup and
// never spills, so model placement is always gpu_resident; spill/fit is read
// from nvidia-smi instead.
//
// Usage:  node src/index.js [--platform KEY] [--vllm-host URL] [--interval MS] [--once]

import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const VLLM_HOST = opt('--vllm-host', process.env.VLLM_HOST || 'http://localhost:8000').replace(/\/$/, '');
const INTERVAL = parseInt(opt('--interval', '2000'), 10);
const ONCE = args.includes('--once');
const PLATFORM = opt('--platform', process.env.LLM_PLATFORM || null);

// ---- helpers ----------------------------------------------------------
function gb(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  return (bytes / 1024 ** 3).toFixed(1) + ' GB';
}
function pct(n) {
  return n == null || Number.isNaN(n) ? '—' : Math.round(n) + '%';
}
function rate(n) {
  return n == null || Number.isNaN(n) ? '—' : n.toFixed(1) + ' tok/s';
}

// ---- nvidia-smi -------------------------------------------------------
function nvidiaSmi() {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(
        'nvidia-smi',
        [
          '--query-gpu=index,name,utilization.gpu,utilization.memory,memory.total,memory.used,temperature.gpu,power.draw',
          '--format=csv,noheader,nounits',
        ],
        { windowsHide: true }
      );
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve(null);
    }, 4000);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const gpus = [];
      for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const c = line.split(',').map((x) => x.trim());
        const num = (v) => {
          const n = parseFloat(v);
          return Number.isNaN(n) ? null : n;
        };
        gpus.push({
          index: num(c[0]),
          name: c[1],
          gpuUtil: num(c[2]),
          memUtil: num(c[3]),
          memTotal: num(c[4]) * 1024 ** 2,
          memUsed: num(c[5]) * 1024 ** 2,
          temp: num(c[6]),
          power: num(c[7]),
        });
      }
      resolve(gpus);
    });
  });
}

// ---- shared HTTP helper ----------------------------------------------
async function fetchText(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  }
}

// ---- vLLM provider ----------------------------------------------------
// Minimal Prometheus parser: returns a map of metricName -> summed value
// across labels. Good enough for a single-model server (one label set per
// metric).
function parsePrometheus(text) {
  const m = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    // name{labels} value   OR   name value
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const rawName = line.slice(0, sp);
    const val = parseFloat(line.slice(sp + 1));
    if (Number.isNaN(val)) continue;
    const brace = rawName.indexOf('{');
    const name = brace >= 0 ? rawName.slice(0, brace) : rawName;
    m.set(name, (m.get(name) || 0) + val);
  }
  return m;
}

class VllmProvider {
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

// ---- platform factory -------------------------------------------------
// Registry of supported platforms. Add new entries here as providers are
// implemented; the startup selector and factory are driven by this list.
const PLATFORMS = [
  { key: 'vllm', label: 'vLLM', host: VLLM_HOST, create: (host) => new VllmProvider(host) },
];

function createProvider(key) {
  const entry = PLATFORMS.find((p) => p.key === key);
  if (!entry) return null;
  return entry.create(entry.host);
}

// Prompt the user to pick a platform. Non-interactive contexts (no TTY, or a
// preselected --platform) skip the prompt.
async function selectPlatform() {
  if (PLATFORM) {
    const entry = PLATFORMS.find((p) => p.key === PLATFORM.toLowerCase());
    if (!entry) {
      process.stderr.write(
        `Unknown platform "${PLATFORM}". Available: ${PLATFORMS.map((p) => p.key).join(', ')}\n`
      );
      process.exit(1);
    }
    return entry.key;
  }
  // Only one option or no interactive terminal: pick the first platform.
  if (PLATFORMS.length === 1 || !stdin.isTTY || ONCE) return PLATFORMS[0].key;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('Select LLM hosting platform:\n');
    PLATFORMS.forEach((p, i) => stdout.write(`  ${i + 1}) ${p.label}\n`));
    while (true) {
      const answer = (await rl.question(`Choose [1-${PLATFORMS.length}] (default 1): `)).trim();
      if (answer === '') return PLATFORMS[0].key;
      const idx = parseInt(answer, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= PLATFORMS.length) return PLATFORMS[idx - 1].key;
      const byKey = PLATFORMS.find((p) => p.key === answer.toLowerCase());
      if (byKey) return byKey.key;
      stdout.write('Invalid choice.\n');
    }
  } finally {
    rl.close();
  }
}

// ---- render -----------------------------------------------------------
async function snapshot(provider) {
  const [gpus, v] = await Promise.all([nvidiaSmi(), provider.poll()]);
  const L = [];
  L.push(`=== Local LLM Monitor (${provider.label}) === ${new Date().toLocaleTimeString()}`);

  L.push('');
  L.push('GPU (nvidia-smi)');
  if (!gpus) {
    L.push('  nvidia-smi not available');
  } else {
    for (const g of gpus) {
      L.push(
        `  GPU${g.index} ${g.name}` +
          `  util ${pct(g.gpuUtil)}  memBW ${pct(g.memUtil)}` +
          `  VRAM ${gb(g.memUsed)}/${gb(g.memTotal)}` +
          (g.temp != null ? `  ${g.temp}°C` : '') +
          (g.power != null ? `  ${Math.round(g.power)}W` : '')
      );
    }
  }

  L.push('');
  L.push(`${provider.label} (${provider.host})`);
  if (!v.ok) {
    L.push(`  server not reachable (${v.error})`);
  } else {
    if (v.models.length) {
      for (const mdl of v.models) {
        L.push(`  model ${mdl.id}${mdl.root && mdl.root !== mdl.id ? ` (${mdl.root})` : ''}`);
      }
    }
    L.push(
      `  requests  running ${v.running ?? '—'}  waiting ${v.waiting ?? '—'}` +
        `  KV cache ${pct(v.kvUsage)}  prefix cache hit ${pct(v.cacheHitRate)}`
    );
    L.push(
      `  throughput  input ${rate(v.promptRate)}  output ${rate(v.decodeRate)}`
    );
  }
  L.push('');
  return L.join('\n');
}

async function loop(provider) {
  const text = await snapshot(provider);
  process.stdout.write('\x1b[2J\x1b[H' + text + '\n');
}

// ---- startup ----------------------------------------------------------
const provider = createProvider(await selectPlatform());

if (ONCE) {
  // For a meaningful throughput reading we need two samples.
  await snapshot(provider);
  await new Promise((r) => setTimeout(r, Math.min(INTERVAL, 1500)));
  process.stdout.write((await snapshot(provider)) + '\n');
  process.exit(0);
}

process.on('SIGINT', () => process.exit(0));
await loop(provider);
setInterval(() => loop(provider), INTERVAL);
