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
// llama.cpp's llama-server (metric names verified against build b10453, see
// llamacpp-setup-windows.md) has a real Prometheus endpoint, but only when
// started with --metrics, so everything is read over HTTP with no log tailing.
// LM Studio's native v1 API exposes loaded model instances and their load
// configuration through /api/v1/models. Completed request timing is available
// through `lms log stream --json --stats`, which this provider observes without
// issuing an inference request of its own.
//
// Usage:  node src/index.js [--platform KEY] [--vllm-host URL] [--ollama-host URL]
//                           [--llamacpp-host URL] [--lmstudio-host URL]
//                           [--lmstudio-api-key KEY] [--lemonade-host URL]
//                           [--lemonade-api-key KEY] [--ollama-log PATH]
//                           [--openclaw-host URL] [--hermes-host URL]
//                           [--hermes-api-key KEY] [--comfyui-host URL]
//                           [--interval MS] [--once] [--no-keep-awake]

import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { renderTui } from './tui.js';
import { startKeepAwake, stopKeepAwake, isKeepAwakeActive } from './keep-awake.js';
import {
  disableLidAction,
  restoreLidAction,
  isLidActionDisabled,
  isLidActionSupported,
} from './lid-action.js';

import { VllmProvider } from './providers/vllm.js';
import { OllamaProvider } from './providers/ollama.js';
import { LlamaCppProvider } from './providers/llamacpp.js';
import { LemonadeProvider } from './providers/lemonade.js';
import { LmStudioProvider } from './providers/lmstudio.js';
import { OpenClawProvider } from './providers/openclaw.js';
import { HermesProvider } from './providers/hermes.js';
import { ComfyUIProvider } from './providers/comfyui.js';
import {
  VLLM_HOST,
  OLLAMA_HOST,
  LLAMACPP_HOST,
  LEMONADE_HOST,
  LMSTUDIO_HOST,
  OPENCLAW_HOST,
  HERMES_HOST,
  HERMES_HEADERS,
  HERMES_DB,
  COMFYUI_HOST,
  INTERVAL,
  ONCE,
  PLAIN,
  PLATFORM,
  KEEP_AWAKE,
} from './config.js';


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
function duration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
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


// ---- platform factory -------------------------------------------------
// Registry of supported platforms. Add new entries here as providers are
// implemented; the startup selector and factory are driven by this list.
const PLATFORMS = [
  { key: 'vllm', label: 'vLLM', host: VLLM_HOST, create: (host) => new VllmProvider(host) },
  { key: 'ollama', label: 'Ollama', host: OLLAMA_HOST, create: (host) => new OllamaProvider(host) },
  { key: 'llamacpp', label: 'llama.cpp', host: LLAMACPP_HOST, create: (host) => new LlamaCppProvider(host) },
  { key: 'lmstudio', label: 'LM Studio', host: LMSTUDIO_HOST, create: (host) => new LmStudioProvider(host) },
  { key: 'lemonade', label: 'AMD Lemonade', host: LEMONADE_HOST, create: (host) => new LemonadeProvider(host) },
  { key: 'openclaw', label: 'OpenClaw', host: OPENCLAW_HOST, create: (host) => new OpenClawProvider(host) },
  { key: 'hermes', label: 'Hermes Agent', host: HERMES_HOST, create: (host) => new HermesProvider(host, HERMES_HEADERS, HERMES_DB) },
  { key: 'comfyui', label: 'ComfyUI', host: COMFYUI_HOST, create: (host) => new ComfyUIProvider(host) },
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

function openclawSnapshot(oc) {
  const L = [];
  const loop = oc.eventLoop;
  L.push(
    `  state ${oc.ready ? 'ready' : 'not ready'}  uptime ${duration(oc.uptimeMs)}` +
      (loop ? `  event loop p99 ${loop.delayP99Ms ?? '—'} ms  util ${pct(loop.utilization != null ? loop.utilization * 100 : null)}` : '')
  );
  if (oc.failing.length) L.push(`  failing  ${oc.failing.join(', ')}`);
  if (loop?.degraded) L.push(`  event loop degraded${loop.reasons.length ? ` (${loop.reasons.join(', ')})` : ''}`);
  const s = oc.status;
  if (s) {
    L.push(
      `  version ${s.version ?? '—'}  pid ${s.pid ?? '—'}  RSS ${gb(s.rssBytes)}` +
        (s.connectLatencyMs != null ? `  connect ${s.connectLatencyMs} ms` : '')
    );
    L.push(
      `  tasks ${s.tasks.active ?? '—'} active (${s.tasks.queued ?? '—'} queued, ${s.tasks.running ?? '—'} running, ${s.tasks.failed ?? '—'} failed)` +
        `  sessions ${s.sessions ?? '—'}  channels ${s.channels ?? '—'}`
    );
    const degraded = [
      s.modelRuntimeDegraded ? 'model runtime' : null,
      s.degradedPlugins ? `${s.degradedPlugins} plugin(s)` : null,
    ].filter(Boolean);
    if (degraded.length) L.push(`  degraded  ${degraded.join(', ')}`);
  }
  if (oc.statusError) L.push(`  status unavailable (${oc.statusError})`);
  else if (!s) L.push('  status waiting for openclaw status --json');
  const q = oc.requests;
  if (q) {
    L.push(
      `  request state  busy ${q.busy ? 'yes' : 'no'}` +
        (q.busy ? ` (${q.running} running, ${duration(q.activeElapsedMs)} elapsed)` : '') +
        '  (sessions.list)'
    );
    L.push(`  requests completed  ${q.completed} since monitor start`);
    const r = q.lastRequest;
    if (r) {
      L.push(
        `  last request  ${r.model ?? '—'}  ${r.runtimeMs != null ? `${(r.runtimeMs / 1000).toFixed(1)}s` : '—'}` +
          `  input ${r.promptTokens ?? '—'} tok  output ${r.genTokens ?? '—'} tok  ${r.outcome ?? '—'}`
      );
    } else {
      L.push('  last request  no completed request in sessions');
    }
  }
  if (oc.requestsError) L.push(`  requests unavailable (${oc.requestsError})`);
  else if (!q) L.push('  requests waiting for sessions.list');
  return L;
}

function hermesSnapshot(h) {
  const L = [];
  L.push(`  state ${h.ready ? 'ready' : 'not ready'}  health ${h.health ?? '—'}`);
  const d = h.detailed;
  if (d) {
    L.push(
      `  gateway ${d.gatewayState ?? '—'}  status ${d.status ?? '—'}` +
        `  active runs ${d.activeRuns ?? '—'}  pending processes ${d.pendingProcesses ?? '—'}` +
        `  delegations ${d.delegations ?? '—'}`
    );
  }
  if (d?.today) {
    L.push(
      `  today  ${d.today.requests ?? '—'} requests  ${d.today.tokens ?? '—'} tokens` +
        `  p95 latency ${d.today.latencyP95Ms != null ? `${d.today.latencyP95Ms} ms` : '—'}`
    );
  }
  if (h.failing.length) L.push(`  failing  ${h.failing.join(', ')}`);
  if (h.detailedError) L.push(`  detail unavailable (${h.detailedError}; /health/detailed needs API_SERVER_KEY, see --hermes-api-key)`);
  const q = h.requests;
  if (q) {
    L.push(
      `  request state  busy ${q.busy ? 'yes' : 'no'}` +
        (q.busy ? ` (${q.running} running${q.activeElapsedMs != null ? `, ${duration(q.activeElapsedMs)} elapsed` : ''})` : '') +
        (q.source ? `  (${q.source})` : '')
    );
    if (q.completed != null) {
      L.push(`  ${q.source ? 'turns' : 'requests'} completed  ${q.completed} since monitor start`);
    }
    const r = q.lastRequest;
    if (r) {
      L.push(
        `  last ${q.source ? 'turn' : 'request'}  ${r.model ?? '—'}  ${r.runtimeMs != null ? `${(r.runtimeMs / 1000).toFixed(1)}s` : '—'}` +
          `  input ${r.promptTokens ?? '—'} tok  output ${r.genTokens ?? '—'} tok` +
          (q.source ? `  api calls ${r.apiCalls ?? '—'}  tool calls ${r.toolCalls ?? '—'}` : '') +
          `  ${r.outcome ?? '—'}`
      );
    } else if (q.completed != null) {
      L.push('  last request  no completed session');
    }
  }
  if (h.requestsError) L.push(`  sessions unavailable (${h.requestsError})`);
  return L;
}

function comfyuiSnapshot(c) {
  const L = [];
  const s = c.system;
  L.push(
    `  version ${s.version ?? '—'}  python ${s.python ?? '—'}  pytorch ${s.pytorch ?? '—'}` +
      `  RAM ${gb(s.ramTotal != null && s.ramFree != null ? s.ramTotal - s.ramFree : null)}/${gb(s.ramTotal)}`
  );
  for (const d of c.devices) {
    L.push(
      `  device ${d.index ?? '—'} ${d.name ?? '—'} (${d.type ?? '—'})` +
        `  VRAM ${gb(d.vramTotal != null && d.vramFree != null ? d.vramTotal - d.vramFree : null)}/${gb(d.vramTotal)}` +
        `  torch ${gb(d.torchVramTotal != null && d.torchVramFree != null ? d.torchVramTotal - d.torchVramFree : null)}/${gb(d.torchVramTotal)}`
    );
  }
  const q = c.queue;
  if (q) {
    L.push(
      `  queue  running ${q.running}  pending ${q.pending}` +
        (q.busy && q.activeElapsedMs != null ? `  (${duration(q.activeElapsedMs)} elapsed)` : '')
    );
  }
  if (c.queueError) L.push(`  queue unavailable (${c.queueError})`);
  const j = c.jobs;
  if (j) {
    L.push(`  jobs completed  ${j.completed} since monitor start  errors ${j.errors}  interrupted ${j.interrupted}`);
    const r = j.last;
    if (r) {
      L.push(
        `  last job  ${r.status ?? '—'}  ${r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}` +
          `  cached ${r.cachedNodes}/${r.totalNodes ?? '—'} nodes  images ${r.outputImages}`
      );
      if (r.error) L.push(`  last error  ${r.error.nodeType ?? '—'}: ${r.error.message ?? '—'}`);
    } else {
      L.push('  last job  no job in history');
    }
    L.push(
      `  avg duration  ${j.avgDurationMs != null ? `${(j.avgDurationMs / 1000).toFixed(1)}s` : '—'}  (last ${j.window} in history)`
    );
  }
  if (c.historyError) L.push(`  history unavailable (${c.historyError})`);
  return L;
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

  if (v.systemStats) {
    const s = v.systemStats;
    const memory = s.memoryGb == null ? '—' : `${s.memoryGb.toFixed(1)} GB`;
    const vram = s.vramGb == null ? '—' : `${s.vramGb.toFixed(1)} GB`;
    L.push('');
    L.push('Lemonade system-stats');
    L.push(
      `  CPU ${pct(s.cpuPercent)}  RAM ${memory} used` +
        `  GPU ${pct(s.gpuPercent)}  VRAM ${vram} used  NPU ${pct(s.npuPercent)}`
    );
  }

  L.push('');
  L.push(`${provider.label} (${provider.host})`);
  if (!v.ok) {
    L.push(`  server not reachable (${v.error})`);
  } else if (v.gateway?.kind === 'comfyui') {
    L.push(...comfyuiSnapshot(v.gateway));
  } else if (v.gateway) {
    L.push(...(v.gateway.kind === 'hermes' ? hermesSnapshot(v.gateway) : openclawSnapshot(v.gateway)));
  } else {
    if (v.loaded) {
      // Ollama- or llama.cpp-shaped result: one or more resident models, with
      // per-model detail in place of the aggregate counters vLLM reports.
      if (!v.loaded.length) L.push('  no model loaded');
      for (const mdl of v.loaded) {
        L.push(
          `  model ${mdl.id}` +
            (mdl.params ? `  ${mdl.params}` : '') +
            (mdl.quant ? ` ${mdl.quant}` : '') +
            (mdl.format ? ` ${mdl.format}` : '') +
            `  ${gb(mdl.size)} loaded` +
            (mdl.vram != null ? ` (${gb(mdl.vram)} VRAM)` : '')
        );
        // llama.cpp cannot report VRAM residency over HTTP, so the placement
        // field is absent there rather than shown as unknown.
        const detail = [
          mdl.device != null
            ? `device ${mdl.device}`
            : mdl.placement != null || mdl.vram != null
              ? `placement ${mdl.placement ?? '—'}`
              : null,
          mdl.context != null
            ? `context ${mdl.context}` + (mdl.contextTrain ? `/${mdl.contextTrain} trained` : '')
            : null,
          mdl.until ? `until ${mdl.until}` : null,
        ].filter(Boolean);
        if (detail.length) L.push('  ' + detail.join('  '));
      }
    } else if (v.models.length) {
      for (const mdl of v.models) {
        L.push(`  model ${mdl.id}${mdl.root && mdl.root !== mdl.id ? ` (${mdl.root})` : ''}`);
      }
    }
    if (v.loaded) {
      if (v.busy != null || v.streaming != null || v.activitySource) {
        const activity = [];
        if (v.busy != null) activity.push(`busy ${v.busy ? 'yes' : 'no'}`);
        if (v.streaming != null) activity.push(`streaming ${v.streaming ? 'yes' : 'no'}`);
        if (!activity.length) activity.push('busy —');
        if (v.activitySource) activity.push(`(${v.activitySource})`);
        L.push(`  request state  ${activity.join('  ')}`);
      }
      if (v.requestCountTotal != null) {
        L.push(`  requests completed  ${v.requestCountTotal}${v.requestCountSince ? ` since ${v.requestCountSince} (from /slots)` : ''}`);
      }
      if (v.running != null || v.waiting != null) {
        L.push(`  requests  ${v.running ?? '—'} processing  ${v.waiting ?? '—'} deferred`);
      }
      if (v.slots || v.kv) {
        L.push(
          `  slots  ${v.slots ? `${v.slots.busy}/${v.slots.total ?? '—'} busy` : '—'}` +
            (v.kv
              ? `  KV cache ${pct(v.kv.pct)} (${v.kv.used}/${v.kv.total} tok` +
                (v.peakTokens ? `, peak ${v.peakTokens}` : '') +
                ')'
              : '')
        );
      }
      if (v.cacheHit || v.promptCache) {
        L.push(
          `  prefix reuse ${v.cacheHit ? `${pct(v.cacheHit.pct)} ${v.cacheHit.scope ?? 'of last prompt'} (${v.cacheHit.cached}/${v.cacheHit.prompt} tok)` : '—'}` +
            (v.promptCache
              ? `  prompt cache ${v.promptCache.prompts} prompts ${v.promptCache.mib.toFixed(0)}/${v.promptCache.limitMib.toFixed(0)} MiB RAM`
              : '')
        );
      }
      if (v.lastRequest) {
        const r = v.lastRequest;
        const request = [];
        if (r.prefillRate != null) {
          request.push(`prefill ${rate(r.prefillRate)}` + (r.promptTokens != null ? ` (${r.promptTokens} tok)` : ''));
        } else if (r.promptTokens != null) {
          request.push(`input ${r.promptTokens} tok`);
        }
        if (r.decodeRate != null) {
          request.push(`decode ${rate(r.decodeRate)}` + (r.genTokens != null ? ` (${r.genTokens} tok)` : ''));
        } else if (r.genTokens != null) {
          request.push(`output ${r.genTokens} tok`);
        }
        L.push(`  last request  ${request.join('  ') || 'no telemetry'}`);
      }
      // llama.cpp: a live /slots rate is shown beside lastRequest (or the
      // metrics hint), since the metrics-on branch below only runs without it.
      const liveExtra =
        v.rateLive && v.decodeRate != null && (v.lastRequest || v.metricsDisabled || v.metricsError);
      if (liveExtra) {
        L.push(`  throughput (live)  prefill ${rate(v.promptRate)}  decode ${rate(v.decodeRate)}`);
      }
      const perRequest = (v.metricsDisabled || v.metricsError) && v.requestCountSince;
      if (perRequest) {
        if (!v.lastRequest && !liveExtra) {
          L.push('  throughput (per request, from /slots)  waiting for first request…');
        }
        L.push(
          `  ${v.metricsDisabled ? 'metrics endpoint off' : `metrics endpoint error: ${v.metricsError}`} · prefill rate & cache hit unavailable`
        );
      } else if (v.metricsDisabled) {
        L.push('  throughput unavailable (server started without --metrics)');
      } else if (v.lastRequest) {
        if (v.metricsError) L.push(`  throughput unavailable (/metrics ${v.metricsError})`);
      } else if (v.telemetryUnavailable) {
        L.push(`  throughput unavailable (${v.telemetryUnavailable})`);
      } else if (!liveExtra && (v.promptRate != null || v.decodeRate != null)) {
        // Live when differenced from /slots mid-generation; otherwise the
        // server's own average for the last request that completed.
        L.push(
          `  throughput (${v.rateLive ? 'live' : 'last completed'})` +
            `  prefill ${rate(v.promptRate)}  decode ${rate(v.decodeRate)}`
        );
      } else if (v.metricsError) {
        L.push(`  throughput unavailable (/metrics ${v.metricsError})`);
      } else if (v.logMissing) {
        L.push(`  throughput unavailable (no server.log at ${v.logMissing})`);
      } else {
        L.push('  last request  no completed request telemetry');
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
const history = { gpuUtil: [], memBW: [], decodeRate: [], requestDecodeRate: [] };
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

// ---- keep-awake toggle ------------------------------------------------
const KEEP_AWAKE_KEY = 'k';
let keepAwakeOn = false;
let keysBound = false;

// keepAwakeOn is the requested state; isKeepAwakeActive() is whether an
// inhibitor is really being held. Reporting the two separately means the footer
// cannot claim the machine is being held awake when the helper has died.
function setKeepAwake(on) {
  keepAwakeOn = on;
  if (on) startKeepAwake();
  else stopKeepAwake();
  return isKeepAwakeActive();
}

// ---- lid-close-action override toggle --------------------------------
// The override is a Windows power-policy edit with no equivalent elsewhere, so
// off Windows the key is not bound and the footer omits the segment entirely
// rather than offering a control that silently does nothing.
const LID_ACTION_KEY = 'l';
const LID_ACTION_SUPPORTED = isLidActionSupported();
let lidActionOn = LID_ACTION_SUPPORTED && isLidActionDisabled();
let lidActionPending = false;

// Each toggle needs an elevated shell (a UAC prompt), so it is asynchronous
// and can fail or be denied; lidActionOn is set from isLidActionDisabled()
// afterwards rather than assumed, so the footer never claims a state that
// was not actually reached.
async function setLidAction(on) {
  if (lidActionPending) return;
  lidActionPending = true;
  renderFrame();
  if (on) await disableLidAction();
  else await restoreLidAction();
  lidActionOn = isLidActionDisabled();
  lidActionPending = false;
  renderFrame();
}

// Raw mode is what turns a keypress into a readable byte without waiting for
// Enter, and it is unavailable in some terminals (MinTTY), so the shortcut is
// offered only where it can work — elsewhere the monitor behaves as before and
// the footer omits the key. In raw mode Ctrl-C stops raising SIGINT and arrives
// as data instead, so it is handled here to keep exiting to work.
function bindKeys() {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return false;
  try {
    stdin.setRawMode(true);
  } catch {
    return false;
  }
  stdin.resume();
  stdin.setEncoding('utf8');
  process.on('exit', () => {
    try {
      stdin.setRawMode(false);
    } catch {}
  });
  stdin.on('data', (chunk) => {
    for (const key of chunk) {
      if (key === '\x03') process.exit(0);
      else if (key.toLowerCase() === KEEP_AWAKE_KEY) {
        setKeepAwake(!keepAwakeOn);
        renderFrame();
      } else if (LID_ACTION_SUPPORTED && key.toLowerCase() === LID_ACTION_KEY) {
        setLidAction(!lidActionOn);
      }
    }
  });
  return true;
}

let lastSample = null;
let lastRequestCount = null;
function renderFrame() {
  if (!lastSample) return;
  const [gpus, v] = lastSample;
  paint(
    renderTui(provider, gpus, v, history, {
      gb,
      pct,
      rate,
      duration,
      interval: INTERVAL,
      keepAwake: {
        on: isKeepAwakeActive(),
        unavailable: keepAwakeOn && !isKeepAwakeActive(),
        key: keysBound ? KEEP_AWAKE_KEY : null,
      },
      lidAction: LID_ACTION_SUPPORTED
        ? {
            on: lidActionOn,
            pending: lidActionPending,
            key: keysBound ? LID_ACTION_KEY : null,
          }
        : null,
    })
  );
}

async function loop(provider) {
  const sampled = await collect(provider);
  const [gpus, v] = sampled;
  if (USE_TUI) {
    if (gpus && gpus.length) {
      track('gpuUtil', gpus[0].gpuUtil);
      track('memBW', gpus[0].memUtil);
    }
    if (v.requestCountTotal != null) {
      if (v.lastRequest?.decodeRate != null && v.requestCountTotal !== lastRequestCount) {
        track('requestDecodeRate', v.lastRequest.decodeRate);
      }
      lastRequestCount = v.requestCountTotal;
    }
    if (v.requestCountTotal == null || v.rateLive) {
      // Ollama's rate comes from the last logged request, llama.cpp's and vLLM's
      // from counters, so fall through rather than keying on the result shape.
      // A live /slots rate is tracked even when per-request counts are present.
      track('decodeRate', v.rateLive ? v.decodeRate : v.loaded ? (v.lastRequest?.decodeRate ?? v.decodeRate) : v.decodeRate);
    }
    lastSample = sampled;
    renderFrame();
  } else {
    paint(await snapshot(provider, sampled));
  }
}

// ---- startup ----------------------------------------------------------
const provider = createProvider(await selectPlatform());

if (ONCE) {
  // For a meaningful throughput reading we need two samples.
  await snapshot(provider);
  await Promise.all([
    new Promise((r) => setTimeout(r, Math.min(INTERVAL, 1500))),
    provider.statusPending,
    provider.sessionsPending,
  ]);
  process.stdout.write((await snapshot(provider)) + '\n');
  process.exit(0);
}

process.on('SIGINT', () => process.exit(0));
if (KEEP_AWAKE) setKeepAwake(true);
// Reflow immediately on resize instead of waiting for the next poll.
if (USE_TUI) {
  process.stdout.write('\x1b[2J');
  process.stdout.on('resize', () => {
    if (lastFrame) paint(lastFrame);
  });
  keysBound = bindKeys();
}
await loop(provider);
setInterval(() => loop(provider), INTERVAL);
