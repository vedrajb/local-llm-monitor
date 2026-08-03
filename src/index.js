#!/usr/bin/env node
// Local LLM Monitor — vLLM edition.
// Zero dependencies. Polls a vLLM server's Prometheus /metrics + /v1/models
// and nvidia-smi, then prints a plain text snapshot on an interval.
//
// vLLM metric names verified against 0.26.0 (see vllm-setup-windows-wsl2.md).
// vLLM reserves its VRAM at startup and never spills, so model placement is
// always gpu_resident; spill/fit is read from nvidia-smi instead.
//
// Usage:  node src/index.js [--vllm-host URL] [--interval MS] [--once]

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const VLLM_HOST = opt('--vllm-host', process.env.VLLM_HOST || 'http://localhost:8000').replace(/\/$/, '');
const INTERVAL = parseInt(opt('--interval', '2000'), 10);
const ONCE = args.includes('--once');

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

// ---- vLLM Prometheus /metrics ----------------------------------------
// Minimal parser: returns a map of metricName -> summed value across labels.
// Good enough for a single-model server (one label set per metric).
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

// Remember previous counter values so we can turn them into rates.
let prev = null; // { t, prompt, generation }

// Exponentially weighted moving averages so the reported rate tracks vLLM's
// smoothed log figure instead of jumping around with each short poll window.
const EWMA_ALPHA = 0.3;
let promptEwma = null;
let decodeEwma = null;
function ewma(prevVal, sample) {
  if (sample == null || Number.isNaN(sample)) return prevVal;
  return prevVal == null ? sample : EWMA_ALPHA * sample + (1 - EWMA_ALPHA) * prevVal;
}

async function vllm() {
  const [metricsRes, modelsRes] = await Promise.all([
    fetchText(`${VLLM_HOST}/metrics`),
    fetchText(`${VLLM_HOST}/v1/models`),
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
  if (prev && promptTotal != null && genTotal != null) {
    const dt = (now - prev.t) / 1000;
    if (dt > 0) {
      const promptSample = Math.max(0, (promptTotal - prev.prompt) / dt);
      const decodeSample = Math.max(0, (genTotal - prev.generation) / dt);
      promptEwma = ewma(promptEwma, promptSample);
      decodeEwma = ewma(decodeEwma, decodeSample);
      result.promptRate = promptEwma;
      result.decodeRate = decodeEwma;
    }
  }
  prev = { t: now, prompt: promptTotal ?? 0, generation: genTotal ?? 0 };

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

// ---- render -----------------------------------------------------------
async function snapshot() {
  const [gpus, v] = await Promise.all([nvidiaSmi(), vllm()]);
  const L = [];
  L.push(`=== Local LLM Monitor (vLLM) === ${new Date().toLocaleTimeString()}`);

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
  L.push(`vLLM (${VLLM_HOST})`);
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

async function loop() {
  const text = await snapshot();
  process.stdout.write('\x1b[2J\x1b[H' + text + '\n');
}

if (ONCE) {
  // For a meaningful throughput reading we need two samples.
  await snapshot();
  await new Promise((r) => setTimeout(r, Math.min(INTERVAL, 1500)));
  process.stdout.write((await snapshot()) + '\n');
  process.exit(0);
}

process.on('SIGINT', () => process.exit(0));
await loop();
setInterval(loop, INTERVAL);
