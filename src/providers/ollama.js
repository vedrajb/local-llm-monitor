import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchText } from '../http.js';
import { OLLAMA_LOG } from '../config.js';

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

export class OllamaProvider {
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
