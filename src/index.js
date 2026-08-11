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
// Ollama (verified against 0.32.5) has no Prometheus endpoint, and its HTTP
// token counters are returned only to the caller that made the request, so
// they are invisible to a passive observer. /api/ps still gives model
// placement (size_vram vs size), the GPU/CPU spill signal vLLM cannot report,
// and Ollama's bundled llama-server logs per-request timings and slot activity
// to server.log by default, which is where throughput comes from here.
//
// Usage:  node src/index.js [--platform KEY] [--vllm-host URL] [--ollama-host URL]
//                           [--ollama-log PATH] [--interval MS] [--once]

import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { renderTui } from './tui.js';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const VLLM_HOST = opt('--vllm-host', process.env.VLLM_HOST || 'http://localhost:8000').replace(/\/$/, '');
// OLLAMA_HOST is conventionally set without a scheme (e.g. "127.0.0.1:11434"),
// which fetch() rejects, so add one when it is missing.
const OLLAMA_HOST = opt('--ollama-host', process.env.OLLAMA_HOST || 'http://localhost:11434')
  .replace(/^(?!https?:\/\/)/i, 'http://')
  .replace(/\/$/, '');
const OLLAMA_LOG = opt('--ollama-log', process.env.OLLAMA_LOG || null);
const INTERVAL = parseInt(opt('--interval', '2000'), 10);
const ONCE = args.includes('--once');
const PLAIN = args.includes('--plain');
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

// ---- Ollama provider --------------------------------------------------
// Ollama's bundled llama-server writes per-request timings and slot activity to
// server.log at default verbosity, so tailing it yields the real throughput of
// every client — unlike the HTTP API, which reports counters only to whoever
// made the request. Linux service installs log to journald instead of a file,
// in which case throughput is simply reported as unavailable.
function ollamaLogPath() {
  if (OLLAMA_LOG) return OLLAMA_LOG;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(local, 'Ollama', 'server.log');
  }
  if (process.platform === 'darwin') return join(homedir(), '.ollama', 'logs', 'server.log');
  return join(homedir(), '.ollama', 'logs', 'server.log');
}

// Read at most the last `maxBytes` of the log; the file grows without bound and
// only the newest lines matter at a 2s poll interval.
async function tailFile(path, maxBytes = 256 * 1024) {
  let fh;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    fh = await open(path, 'r');
    const len = Math.min(info.size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, Math.max(0, info.size - len));
    const text = buf.toString('utf8');
    // A truncated read starts mid-line; drop that fragment so it cannot be
    // parsed as a partial record.
    return info.size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

class OllamaProvider {
  constructor(host) {
    this.host = host;
    this.label = 'Ollama';
    this.logPath = ollamaLogPath();
    // The slot count only appears in the startup banner, which scrolls out of
    // the tail window on a long-running server, so remember it once seen.
    this.slotTotal = null;
    // Ollama rotates server.log, which drops the recent history out of view;
    // hold the last reading so throughput does not blank out mid-session.
    this.lastRequest = null;
    this.slots = null;
    this.kv = null;
    this.cacheHit = null;
    this.promptCache = null;
    // Printed only on "new prompt", so remember it for the KV total.
    this.ctxPerSlot = null;
  }

  // llama.cpp prints one print_timing block per finished request:
  //   slot print_timing: id 0 | task 9530 | prompt eval time = ... (687.14 tokens per second)
  //   slot print_timing: id 0 | task 9530 |        eval time = ... ( 65.88 tokens per second)
  // Whitespace around the field names varies, so match loosely and keep the
  // last (most recent) block in the tail. Note "prompt eval" counts only the
  // tokens actually evaluated: a prefix-cache hit leaves 1 token here, so the
  // rate is reported alongside its token count rather than on its own.
  parseTimings(text) {
    const re =
      /slot\s+print_timing:\s+id\s+(\d+)\s+\|\s+task\s+(\d+)\s+\|\s+(prompt eval|eval)\s+time\s+=\s+([\d.]+)\s+ms\s+\/\s+(\d+)\s+tokens[^)]*?([\d.]+)\s+tokens per second/g;
    const tasks = new Map();
    for (const m of text.matchAll(re)) {
      const task = m[2];
      const entry = tasks.get(task) || { slot: Number(m[1]), task };
      if (m[3] === 'prompt eval') {
        entry.prefillRate = parseFloat(m[6]);
        entry.promptTokens = Number(m[5]);
      } else {
        entry.decodeRate = parseFloat(m[6]);
        entry.genTokens = Number(m[5]);
      }
      tasks.set(task, entry);
    }
    const all = [...tasks.values()];
    return all.length ? all[all.length - 1] : null;
  }

  // Slots go busy on "launch_slot_ ... processing task". A client that
  // disconnects mid-generation never produces a matching "release", so the
  // per-request "print_timing" block — which llama.cpp emits for every task
  // that ran, abandoned or not — is what frees a slot here. "all slots are
  // idle" is an explicit reset that supersedes both.
  parseSlots(text) {
    const np = [...text.matchAll(/-np\s+(\d+)/g)].pop();
    if (np) this.slotTotal = Number(np[1]);
    const events =
      /slot\s+launch_slot_:\s+id\s+(\d+)\s+\|\s+task\s+(\d+)\s+\|\s+processing task|slot\s+(?:release|print_timing):\s+id\s+(\d+)\s+\|\s+task\s+(\d+)\s+\||srv\s+update_slots:\s+all slots are idle/g;
    const busy = new Set();
    let saw = false;
    for (const m of text.matchAll(events)) {
      saw = true;
      if (m[1] != null) busy.add(m[2]);
      else if (m[3] != null) busy.delete(m[4]);
      else busy.clear();
    }
    // Fall back to the highest slot id ever seen when the banner is gone.
    const seen = [...text.matchAll(/slot\s+\S+:\s+id\s+(\d+)\s+\|/g)].map((m) => Number(m[1]));
    const total = this.slotTotal ?? (seen.length ? Math.max(...seen) + 1 : null);
    return saw ? { busy: busy.size, total } : null;
  }

  // KV occupancy: each slot holds up to n_ctx_slot tokens, and a slot's current
  // token count is printed on "new prompt" and again on "release". Summing the
  // latest figure per slot against slots * n_ctx_slot gives the occupancy of
  // the KV pool, which is the closest analogue to vLLM's kv_cache_usage_perc.
  parseKvUsage(text) {
    const ev =
      /slot\s+operator\(\):\s+id\s+(\d+)\s+\|\s+task\s+\d+\s+\|\s+new prompt,\s+n_ctx_slot\s+=\s+(\d+)[^\n]*?task\.n_tokens\s+=\s+(\d+)|slot\s+release:\s+id\s+(\d+)\s+\|\s+task\s+\d+\s+\|\s+stop processing:\s+n_tokens\s+=\s+(\d+)/g;
    const occ = new Map();
    for (const m of text.matchAll(ev)) {
      if (m[1] != null) {
        this.ctxPerSlot = Number(m[2]);
        occ.set(m[1], Number(m[3]));
      } else {
        occ.set(m[4], Number(m[5]));
      }
    }
    if (!occ.size || this.ctxPerSlot == null) return null;
    const slots = this.slotTotal ?? occ.size;
    const total = this.ctxPerSlot * slots;
    const used = [...occ.values()].reduce((a, b) => a + b, 0);
    return total > 0 ? { used, total, pct: (used / total) * 100 } : null;
  }

  // Prefix reuse: llama.cpp reports how much of each prompt it recovered from
  // cache ("cached n_tokens") against the prompt length ("task.n_tokens"),
  // which is the per-request equivalent of vLLM's prefix cache hit rate.
  parseCacheHit(text) {
    const re =
      /slot\s+operator\(\):\s+id\s+\d+\s+\|\s+task\s+(\d+)\s+\|\s+new prompt[^\n]*?task\.n_tokens\s+=\s+(\d+)[\s\S]{0,400}?cached n_tokens\s+=\s+(\d+)/g;
    const all = [...text.matchAll(re)];
    if (!all.length) return null;
    const m = all[all.length - 1];
    const prompt = Number(m[2]);
    const cached = Number(m[3]);
    return prompt > 0 ? { prompt, cached, pct: (cached / prompt) * 100 } : null;
  }

  // The prompt cache is a host-RAM store of idle slots' prompts, sized by
  // --cache-ram; it is not the KV pool, so it is reported separately.
  parsePromptCache(text) {
    const m = [
      ...text.matchAll(
        /cache state:\s+(\d+)\s+prompts,\s+([\d.]+)\s+MiB\s+\(limits:\s+([\d.]+)\s+MiB/g
      ),
    ].pop();
    if (!m) return null;
    return { prompts: Number(m[1]), mib: parseFloat(m[2]), limitMib: parseFloat(m[3]) };
  }

  // Ollama reports loaded model bytes (size) and the portion resident in VRAM
  // (size_vram); the ratio is what `ollama ps` prints as its PROCESSOR column.
  placement(size, vram) {
    if (!Number.isFinite(size) || !Number.isFinite(vram) || size <= 0) return null;
    if (vram <= 0) return '100% CPU';
    if (vram >= size) return '100% GPU';
    const cpu = Math.round(((size - vram) / size) * 100);
    return `${cpu}%/${100 - cpu}% CPU/GPU`;
  }

  // A keep-alive of -1 pins the model and reports a date centuries out, so
  // anything beyond a year reads as "forever" instead of an absurd timestamp.
  expiry(expiresAt) {
    const t = Date.parse(expiresAt);
    if (Number.isNaN(t)) return null;
    const days = (t - Date.now()) / 86400000;
    if (days > 365) return 'forever';
    if (days < 0) return 'expired';
    return new Date(t).toLocaleTimeString();
  }

  async poll() {
    const [psRes, logText] = await Promise.all([
      fetchText(`${this.host}/api/ps`),
      tailFile(this.logPath),
    ]);
    const result = { ok: psRes.ok, error: psRes.error, models: [] };
    if (logText == null) {
      result.logMissing = this.logPath;
    } else {
      this.lastRequest = this.parseTimings(logText) ?? this.lastRequest;
      this.slots = this.parseSlots(logText) ?? this.slots;
      this.kv = this.parseKvUsage(logText) ?? this.kv;
      this.cacheHit = this.parseCacheHit(logText) ?? this.cacheHit;
      this.promptCache = this.parsePromptCache(logText) ?? this.promptCache;
      result.lastRequest = this.lastRequest;
      result.slots = this.slots;
      // Reported per token pool, not as vLLM's single kvUsage percentage.
      result.kv = this.kv;
      result.cacheHit = this.cacheHit;
      result.promptCache = this.promptCache;
    }
    if (!psRes.ok) return result;

    let data;
    try {
      data = JSON.parse(psRes.text);
    } catch {
      return { ...result, ok: false, error: 'bad JSON from /api/ps' };
    }

    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const entries = Array.isArray(data.models) ? data.models.filter((m) => m && typeof m === 'object') : [];
    result.loaded = entries.map((m) => {
      const size = num(m.size);
      const vram = num(m.size_vram);
      return {
        id: m.name || m.model || '(unnamed)',
        size,
        vram,
        placement: this.placement(size, vram),
        context: num(m.context_length),
        quant: m.details && m.details.quantization_level,
        params: m.details && m.details.parameter_size,
        until: this.expiry(m.expires_at),
      };
    });
    result.models = result.loaded.map((m) => ({ id: m.id }));
    return result;
  }
}

// ---- platform factory -------------------------------------------------
// Registry of supported platforms. Add new entries here as providers are
// implemented; the startup selector and factory are driven by this list.
const PLATFORMS = [
  { key: 'vllm', label: 'vLLM', host: VLLM_HOST, create: (host) => new VllmProvider(host) },
  { key: 'ollama', label: 'Ollama', host: OLLAMA_HOST, create: (host) => new OllamaProvider(host) },
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
function collect(provider) {
  return Promise.all([nvidiaSmi(), provider.poll()]);
}

async function snapshot(provider, sampled) {
  const [gpus, v] = sampled || (await collect(provider));
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
    if (v.loaded) {
      // Ollama-shaped result: report placement instead of counters it lacks.
      if (!v.loaded.length) L.push('  no model loaded');
      for (const mdl of v.loaded) {
        L.push(
          `  model ${mdl.id}` +
            (mdl.params ? `  ${mdl.params}` : '') +
            (mdl.quant ? ` ${mdl.quant}` : '') +
            `  ${gb(mdl.size)} loaded (${gb(mdl.vram)} VRAM)`
        );
        L.push(
          `  placement ${mdl.placement ?? '—'}` +
            (mdl.context != null ? `  context ${mdl.context}` : '') +
            (mdl.until ? `  until ${mdl.until}` : '')
        );
      }
    } else if (v.models.length) {
      for (const mdl of v.models) {
        L.push(`  model ${mdl.id}${mdl.root && mdl.root !== mdl.id ? ` (${mdl.root})` : ''}`);
      }
    }
    if (v.loaded) {
      if (v.slots || v.kv) {
        L.push(
          `  slots  ${v.slots ? `${v.slots.busy}/${v.slots.total ?? '—'} busy` : '—'}` +
            (v.kv ? `  KV cache ${pct(v.kv.pct)} (${v.kv.used}/${v.kv.total} tok)` : '')
        );
      }
      if (v.cacheHit || v.promptCache) {
        L.push(
          `  prefix reuse ${v.cacheHit ? `${pct(v.cacheHit.pct)} of last prompt (${v.cacheHit.cached}/${v.cacheHit.prompt} tok)` : '—'}` +
            (v.promptCache
              ? `  prompt cache ${v.promptCache.prompts} prompts ${v.promptCache.mib.toFixed(0)}/${v.promptCache.limitMib.toFixed(0)} MiB RAM`
              : '')
        );
      }
      if (v.lastRequest) {
        const r = v.lastRequest;
        L.push(
          `  last request  prefill ${rate(r.prefillRate)}` +
            (r.promptTokens != null ? ` (${r.promptTokens} tok)` : '') +
            `  decode ${rate(r.decodeRate)}` +
            (r.genTokens != null ? ` (${r.genTokens} tok)` : '')
        );
      } else if (v.logMissing) {
        L.push(`  throughput unavailable (no server.log at ${v.logMissing})`);
      } else {
        L.push('  last request  no completed request in recent log');
      }
    } else {
      L.push(
        `  requests  running ${v.running ?? '—'}  waiting ${v.waiting ?? '—'}` +
          `  KV cache ${pct(v.kvUsage)}  prefix cache hit ${pct(v.cacheHitRate)}`
      );
      L.push(
        `  throughput  input ${rate(v.promptRate)}  output ${rate(v.decodeRate)}`
      );
    }
  }
  L.push('');
  return L.join('\n');
}

// The TUI needs a TTY for its width and colours; anything else (a pipe, a
// redirect, NO_COLOR, --plain, --once) falls back to the plain renderer.
const USE_TUI =
  !PLAIN && !ONCE && !!process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';

// Bounded so a long-running session cannot grow without limit.
const HISTORY_MAX = 60;
const history = { gpuUtil: [], memBW: [], decodeRate: [] };
function track(key, value) {
  if (value == null || Number.isNaN(value)) return;
  const arr = history[key];
  arr.push(value);
  if (arr.length > HISTORY_MAX) arr.shift();
}

let lastFrame = '';
function paint(text) {
  lastFrame = text;
  if (!USE_TUI) return process.stdout.write('\x1b[2J\x1b[H' + text + '\n');
  // Home the cursor and clear each line as it is rewritten, then clear whatever
  // is left below: no full-screen erase, so the redraw does not flash.
  const body = text.split('\n').join('\x1b[K\n');
  process.stdout.write('\x1b[H' + body + '\x1b[K\x1b[J');
}

async function loop(provider) {
  const sampled = await collect(provider);
  const [gpus, v] = sampled;
  if (USE_TUI) {
    if (gpus && gpus.length) {
      track('gpuUtil', gpus[0].gpuUtil);
      track('memBW', gpus[0].memUtil);
    }
    track('decodeRate', v.loaded ? v.lastRequest?.decodeRate : v.decodeRate);
    paint(renderTui(provider, gpus, v, history, { gb, pct, rate, interval: INTERVAL }));
  } else {
    paint(await snapshot(provider, sampled));
  }
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
// Reflow immediately on resize instead of waiting for the next poll.
if (USE_TUI) {
  process.stdout.write('\x1b[2J');
  process.stdout.on('resize', () => {
    if (lastFrame) paint(lastFrame);
  });
}
await loop(provider);
setInterval(() => loop(provider), INTERVAL);
