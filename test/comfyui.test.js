import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ComfyUIProvider,
  parseComfyHistory,
  parseComfyQueue,
  parseComfySystemStats,
  summarizeComfyJobs,
} from '../src/providers/comfyui.js';
import { renderTui } from '../src/tui.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GiB = 1024 ** 3;

const SYSTEM_STATS = JSON.stringify({
  system: {
    os: 'nt',
    ram_total: 64 * GiB,
    ram_free: 40 * GiB,
    comfyui_version: '0.3.40',
    python_version: '3.12.9 (tags/v3.12.9) [MSC v.1942 64 bit (AMD64)]',
    pytorch_version: '2.7.0+cu128',
    embedded_python: true,
    argv: ['main.py'],
  },
  devices: [
    {
      name: 'cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync',
      type: 'cuda',
      index: 0,
      vram_total: 24 * GiB,
      vram_free: 18 * GiB,
      torch_vram_total: 8 * GiB,
      torch_vram_free: 2 * GiB,
    },
  ],
});

function job(id, number, { status = 'success', start, end, cached = [], images = 1, nodes = 3, error, interrupted } = {}) {
  const messages = [];
  if (start != null) messages.push(['execution_start', { prompt_id: id, timestamp: start }]);
  if (cached.length) messages.push(['execution_cached', { nodes: cached, prompt_id: id, timestamp: start }]);
  if (interrupted) {
    messages.push(['execution_interrupted', { prompt_id: id, node_id: '3', node_type: 'KSampler', executed: [], timestamp: end }]);
  } else if (error) {
    messages.push([
      'execution_error',
      { prompt_id: id, node_id: '3', node_type: error.nodeType, exception_message: error.message, timestamp: end },
    ]);
  } else if (end != null) {
    messages.push(['execution_success', { prompt_id: id, timestamp: end }]);
  }
  const graph = {};
  for (let i = 1; i <= nodes; i++) graph[String(i)] = { class_type: 'Node', inputs: {} };
  return {
    prompt: [number, id, graph, {}, ['9']],
    outputs: images ? { 9: { images: Array.from({ length: images }, (_, i) => ({ filename: `img_${i}.png`, type: 'output' })) } } : {},
    status: { status_str: status, completed: status === 'success', messages },
  };
}

function mockFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = Object.keys(routes).find((path) => String(url).includes(path));
    if (!key) return { ok: false, status: 404, text: async () => '' };
    let r = routes[key];
    if (typeof r === 'function') r = r();
    if (typeof r === 'number') return { ok: false, status: r, text: async () => '' };
    return { ok: true, status: 200, text: async () => r };
  };
  return () => {
    globalThis.fetch = original;
  };
}

test('parses ComfyUI system stats', () => {
  const s = parseComfySystemStats(SYSTEM_STATS);
  assert.equal(s.version, '0.3.40');
  assert.equal(s.python, '3.12.9');
  assert.equal(s.pytorch, '2.7.0+cu128');
  assert.equal(s.ramTotal, 64 * GiB);
  assert.equal(s.devices.length, 1);
  assert.equal(s.devices[0].type, 'cuda');
  assert.equal(s.devices[0].vramFree, 18 * GiB);
  assert.equal(s.devices[0].torchVramTotal, 8 * GiB);
  assert.equal(parseComfySystemStats('not json'), null);
  assert.equal(parseComfySystemStats('[]'), null);
});

test('parses ComfyUI queue', () => {
  const q = parseComfyQueue(
    JSON.stringify({ queue_running: [[5, 'p5', {}, {}, []]], queue_pending: [[6, 'p6', {}, {}, []], [7, 'p7', {}, {}, []]] })
  );
  assert.deepEqual(q, { running: [{ number: 5, promptId: 'p5' }], pending: 2 });
  assert.deepEqual(parseComfyQueue('{}'), { running: [], pending: 0 });
  assert.equal(parseComfyQueue('nope'), null);
});

test('parses ComfyUI history with success, error, interrupted and cached jobs', () => {
  const T = 1750000000000;
  const history = {
    b: job('b', 2, { status: 'error', start: T + 2000, end: T + 2500, error: { nodeType: 'KSampler', message: 'CUDA out of memory' }, images: 0 }),
    a: job('a', 1, { start: T + 1000, end: T + 4000, cached: ['1', '2'], images: 2 }),
    c: job('c', 3, { status: 'error', start: T + 5000, end: T + 5100, interrupted: true, images: 0 }),
    d: { prompt: [4, 'd', { 1: {} }, {}, []], outputs: {}, status: { status_str: 'success', completed: true } },
  };
  const jobs = parseComfyHistory(JSON.stringify(history));
  assert.deepEqual(jobs.map((j) => j.promptId), ['a', 'b', 'c', 'd']);
  const [a, b, c, d] = jobs;
  assert.equal(a.status, 'success');
  assert.equal(a.durationMs, 3000);
  assert.equal(a.cachedNodes, 2);
  assert.equal(a.totalNodes, 3);
  assert.equal(a.outputImages, 2);
  assert.equal(b.status, 'error');
  assert.deepEqual(b.error, { nodeType: 'KSampler', message: 'CUDA out of memory' });
  assert.equal(c.status, 'interrupted');
  assert.equal(d.status, 'success');
  assert.equal(d.durationMs, null);
  assert.equal(d.totalNodes, 1);

  const summary = summarizeComfyJobs(jobs);
  assert.equal(summary.last.promptId, 'd');
  assert.equal(summary.avgDurationMs, Math.round((3000 + 500 + 100) / 3));
  assert.equal(summary.errors, 1);
  assert.equal(summary.interrupted, 1);
  assert.equal(parseComfyHistory('bad'), null);
});

test('reports an unreachable ComfyUI server', async () => {
  const restore = mockFetch({});
  try {
    const v = await new ComfyUIProvider('http://c').poll();
    assert.equal(v.ok, false);
    assert.equal(v.error, 'HTTP 404');
  } finally {
    restore();
  }
});

test('keeps ComfyUI reachable when /history fails', async () => {
  const restore = mockFetch({
    '/system_stats': SYSTEM_STATS,
    '/queue': '{"queue_running":[],"queue_pending":[]}',
    '/history': 500,
  });
  try {
    const v = await new ComfyUIProvider('http://c').poll();
    assert.equal(v.ok, true);
    assert.equal(v.gateway.kind, 'comfyui');
    assert.equal(v.gateway.historyError, 'HTTP 500');
    assert.equal(v.gateway.jobs, null);
    assert.equal(v.gateway.queue.running, 0);
  } finally {
    restore();
  }
});

test('counts ComfyUI jobs once and ignores jobs finished before monitor start', async () => {
  const provider = new ComfyUIProvider('http://c');
  const t0 = provider.monitorStartedAt;
  let history = { old: job('old', 1, { start: t0 - 5000, end: t0 - 1000 }) };
  const restore = mockFetch({
    '/system_stats': SYSTEM_STATS,
    '/queue': '{"queue_running":[],"queue_pending":[]}',
    '/history': () => JSON.stringify(history),
  });
  try {
    let v = await provider.poll();
    assert.equal(v.requestCountTotal, 0);
    assert.equal(v.gateway.jobs.completed, 0);

    history = {
      ...history,
      n1: job('n1', 2, { start: t0 + 10, end: t0 + 2010 }),
      n2: job('n2', 3, { status: 'error', start: t0 + 3000, end: t0 + 3500, error: { nodeType: 'VAEDecode', message: 'boom' } }),
    };
    v = await provider.poll();
    assert.equal(v.requestCountTotal, 2);
    v = await provider.poll();
    assert.equal(v.requestCountTotal, 2);
    assert.equal(v.gateway.jobs.errors, 1);
    assert.equal(v.gateway.jobs.last.promptId, 'n2');
    assert.equal(v.lastRequest.outcome, 'error');
    assert.equal(v.lastRequest.runtimeMs, 500);
    assert.equal(v.lastRequest.decodeRate, undefined);
  } finally {
    restore();
  }
});

test('tracks elapsed time of the running ComfyUI job', async () => {
  const provider = new ComfyUIProvider('http://c');
  const restore = mockFetch({
    '/system_stats': SYSTEM_STATS,
    '/queue': '{"queue_running":[[1,"p1",{},{},[]]],"queue_pending":[[2,"p2",{},{},[]]]}',
    '/history': '{}',
  });
  try {
    let v = await provider.poll();
    assert.equal(v.gateway.queue.busy, true);
    assert.equal(v.gateway.queue.pending, 1);
    provider.runningSeenAt.set('p1', Date.now() - 5000);
    v = await provider.poll();
    assert.ok(v.gateway.queue.activeElapsedMs >= 5000);
  } finally {
    restore();
  }
});

test('renders ComfyUI boxes in the TUI', () => {
  const provider = { label: 'ComfyUI', host: 'http://127.0.0.1:8188' };
  const system = parseComfySystemStats(SYSTEM_STATS);
  const last = parseComfyHistory(
    JSON.stringify({ e: job('e', 1, { status: 'error', start: 1750000000000, end: 1750000001500, error: { nodeType: 'KSampler', message: 'OOM' } }) })
  )[0];
  const output = renderTui(
    provider,
    null,
    {
      ok: true,
      models: [],
      gateway: {
        kind: 'comfyui',
        ready: true,
        failing: [],
        system,
        devices: system.devices,
        queue: { running: 1, pending: 2, busy: true, activeElapsedMs: 4000 },
        jobs: { last, avgDurationMs: 1500, window: 1, completed: 1, errors: 1, interrupted: 0 },
        queueError: null,
        historyError: null,
      },
    },
    { gpuUtil: [], memBW: [], decodeRate: [], requestDecodeRate: [] },
    {
      gb: (n) => (n == null ? '—' : `${(n / GiB).toFixed(1)} GB`),
      pct: (n) => (n == null ? '—' : `${n}%`),
      duration: (ms) => `${Math.round(ms / 1000)}s`,
      interval: 2000,
    }
  );
  assert.match(output, /ComfyUI/);
  assert.match(output, /Jobs/);
  assert.match(output, /pending/);
  assert.match(output, /KSampler/);
  assert.match(output, /1\.5s/);
  assert.doesNotMatch(output, /Gateway/);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function runMonitor(host) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['src/index.js', '--platform', 'comfyui', '--comfyui-host', host, '--interval', '10', '--once', '--no-keep-awake'],
      { cwd: repo, env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('monitors ComfyUI system stats, queue and history end to end', async () => {
  const now = Date.now() + 60000;
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const responses = {
      '/system_stats': SYSTEM_STATS,
      '/queue': JSON.stringify({ queue_running: [], queue_pending: [[3, 'p3', {}, {}, []]] }),
      '/history': JSON.stringify({ p1: job('p1', 1, { start: now, end: now + 2500, cached: ['1'], images: 4 }) }),
    };
    const body = responses[path];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(body ?? '');
  });
  const port = await listen(server);
  try {
    const { code, stdout, stderr } = await runMonitor(`127.0.0.1:${port}`);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /ComfyUI \(http:\/\/127\.0\.0\.1:\d+\)/);
    assert.match(stdout, /version 0\.3\.40  python 3\.12\.9  pytorch 2\.7\.0\+cu128/);
    assert.match(stdout, /RAM 24\.0 GB\/64\.0 GB/);
    assert.match(stdout, /device 0 cuda:0 NVIDIA GeForce RTX 4090 .* \(cuda\)  VRAM 6\.0 GB\/24\.0 GB  torch 6\.0 GB\/8\.0 GB/);
    assert.match(stdout, /queue  running 0  pending 1/);
    assert.match(stdout, /jobs completed  1 since monitor start  errors 0  interrupted 0/);
    assert.match(stdout, /last job  success  2\.5s  cached 1\/3 nodes  images 4/);
    assert.match(stdout, /avg duration  2\.5s  \(last 1 in history\)/);
  } finally {
    await close(server);
  }
});
