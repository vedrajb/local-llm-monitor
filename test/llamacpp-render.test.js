import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';

import { renderTui } from '../src/tui.js';

const provider = { label: 'llama.cpp', host: 'http://localhost:8080' };
const options = {
  gb: (n) => (n == null ? '—' : `${n} GB`),
  pct: (n) => (n == null ? '—' : `${n}%`),
  rate: (n) => (n == null ? '—' : `${n.toFixed(1)} tok/s`),
  interval: 2000,
};
const history = { gpuUtil: [], memBW: [], decodeRate: [], requestDecodeRate: [] };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const base = {
  ok: true,
  loaded: [{ id: 'm1', size: null, params: null, quant: null, context: 8192, contextTrain: null }],
  models: [{ id: 'm1' }],
  requestCountTotal: 2,
  requestCountSince: 'monitor start',
  lastRequest: { prefillRate: null, decodeRate: 20, promptTokens: 300, genTokens: 70, model: 'm1' },
  metricsDisabled: true,
};
const render = (v, p = provider) => strip(renderTui(p, null, v, history, options));

test('TUI shows the live line and lastRequest together', () => {
  const out = render({ ...base, decodeRate: 42, rateLive: true });
  assert.match(out, /last request/);
  assert.match(out, /live prefill/);
  assert.match(out, /42\.0 tok\/s/);
  assert.doesNotMatch(out, /Throughput\s+\(live\)/);
});

test('TUI shows the metrics-off note and metricsError beside lastRequest', () => {
  const off = render({ ...base, decodeRate: 42, rateLive: true });
  assert.match(off, /metrics endpoint off · prefill rate & cache hit unavailable/);
  assert.doesNotMatch(off, /restart llama-server/);
  const err = render({ ...base, metricsDisabled: undefined, metricsError: 'HTTP 404' });
  assert.match(err, /last request/);
  assert.match(err, /metrics endpoint error: HTTP 404 · prefill rate & cache hit unavailable/);
  assert.match(err, /Throughput\s+\(per request, from \/slots\)/);
});

test('TUI metrics-off with no request waits for the first one', () => {
  const out = render({ ...base, lastRequest: undefined, requestCountTotal: 0 });
  assert.match(out, /Throughput\s+\(per request, from \/slots\)/);
  assert.match(out, /waiting for first request…/);
  assert.match(out, /metrics endpoint off · prefill rate & cache hit unavailable/);
  assert.doesNotMatch(out, /restart llama-server|last completed request/);
  assert.match(out, /0\s+requests since monitor start \(from \/slots\)/);
  const err = render({ ...base, lastRequest: undefined, metricsDisabled: undefined, metricsError: 'timeout' });
  assert.match(err, /waiting for first request…/);
  assert.match(err, /metrics endpoint error: timeout/);
});

test('TUI metrics-off with a request shows it, the note and the /slots heading', () => {
  const out = render(base);
  assert.match(out, /Throughput\s+\(per request, from \/slots\)/);
  assert.match(out, /last request\s+input 300 tok/);
  assert.match(out, /decode 20\.0 tok\/s \(70 tok\)/);
  assert.doesNotMatch(out, /waiting for first request/);
  assert.match(out, /metrics endpoint off/);
});

test('TUI metrics-on llama.cpp rendering is unchanged', () => {
  const on = {
    ok: true,
    loaded: base.loaded,
    models: base.models,
    promptRate: 100,
    decodeRate: 30,
    running: 0,
    waiting: 0,
  };
  const out = render(on);
  assert.match(out, /Throughput\s+\(last completed request\)/);
  assert.match(out, /prefill\s+100\.0 tok\/s\s+decode\s+30\.0 tok\/s/);
  assert.doesNotMatch(out, /from \/slots|metrics endpoint|waiting for first request/);
});

test('TUI titles live-only throughput as live and a previous request neutrally', () => {
  const live = render({ ...base, lastRequest: undefined, decodeRate: 42, rateLive: true });
  assert.match(live, /Throughput\s+\(live\)/);
  const last = render({ ...base, decodeRate: undefined });
  assert.doesNotMatch(last, /\(live\)/);
  assert.match(last, /Throughput\s+\(per request, from \/slots\)/);
});

test('TUI labels the llama.cpp request count as since monitor start only', () => {
  assert.match(render(base), /2\s+requests since monitor start \(from \/slots\)/);
  const { requestCountSince, ...other } = base;
  const out = render(other, { label: 'AMD Lemonade', host: 'http://x' });
  assert.match(out, /2\s+requests/);
  assert.doesNotMatch(out, /since monitor start/);
});

// Plain renderer lives in the CLI entry point, so drive it against a fake server.
test('plain mode shows live line, lastRequest, note and since-monitor-start label', async () => {
  const frames = [
    [{ id: 0, id_task: 1, is_processing: false, n_ctx: 8192, n_prompt_tokens: 10, next_token: [{ n_decoded: 0 }] }],
    [{ id: 0, id_task: 2, is_processing: true, n_ctx: 8192, n_prompt_tokens: 10, next_token: [{ n_decoded: 5 }] }],
    [{ id: 0, id_task: 2, is_processing: true, n_ctx: 8192, n_prompt_tokens: 10, next_token: [{ n_decoded: 25 }] }],
    [{ id: 0, id_task: 2, is_processing: false, n_ctx: 8192, n_prompt_tokens: 10, next_token: [{ n_decoded: 30 }] }],
    [{ id: 0, id_task: 3, is_processing: true, n_ctx: 8192, n_prompt_tokens: 10, next_token: [{ n_decoded: 5 }] }],
  ];
  let hits = 0;
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.url === '/props') return send(200, { endpoint_metrics: false, total_slots: 1, model_alias: 'm1' });
    if (req.url === '/v1/models') return send(200, { data: [{ id: 'm1' }] });
    if (req.url === '/slots') {
      const frame = frames[Math.min(hits, frames.length - 1)];
      hits += 1;
      if (hits > frames.length) {
        // Keep the final request decoding so the live rate persists.
        frame[0].next_token[0].n_decoded += 10 * (hits - frames.length);
      }
      return send(200, frame);
    }
    return send(404, '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(
    process.execPath,
    ['src/index.js', '--platform', 'llamacpp', '--llamacpp-host', host, '--plain', '--interval', '250', '--no-keep-awake'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } }
  );
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const deadline = Date.now() + 15000;
  const ready = () => {
    const text = strip(out);
    const i = text.lastIndexOf('requests completed');
    const frame = i >= 0 ? text.slice(i) : '';
    return /last request/.test(frame) && /throughput \(live\)/.test(frame);
  };
  try {
    while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  } finally {
    child.kill();
    server.close();
  }
  const text = strip(out);
  const frame = text.slice(text.lastIndexOf('requests completed'));
  assert.match(frame, /requests completed\s+1 since monitor start \(from \/slots\)/);
  assert.match(frame, /last request/);
  assert.match(frame, /throughput \(live\)/);
  assert.match(frame, /metrics endpoint off · prefill rate & cache hit unavailable/);
  assert.doesNotMatch(frame, /--metrics/);
});
