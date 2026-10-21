import assert from 'node:assert/strict';
import test from 'node:test';

import { LlamaCppProvider } from '../src/providers/llamacpp.js';

const slot = (id, task, processing, decoded, prompt = 100) => ({
  id,
  id_task: task,
  is_processing: processing,
  n_ctx: 8192,
  n_prompt_tokens: prompt,
  next_token: [{ n_decoded: decoded }],
});

const METRICS = [
  'llamacpp:prompt_tokens_seconds 0',
  'llamacpp:predicted_tokens_seconds 66.1',
  'llamacpp:requests_processing 0',
  'llamacpp:requests_deferred 0',
  'llamacpp:prompt_tokens_total 128',
  'llamacpp:prompt_tokens_cached_total 4992',
].join('\n');

// Drives poll() through a scripted sequence of /slots snapshots at fake times.
function harness({ metrics = false, metricsFails = false } = {}) {
  const routes = {
    '/props': JSON.stringify({ endpoint_metrics: metrics, total_slots: 2, model_alias: 'm1' }),
    '/v1/models': JSON.stringify({ data: [{ id: 'm1' }] }),
    '/slots': '[]',
  };
  if (metrics && !metricsFails) routes['/metrics'] = METRICS;
  const origFetch = globalThis.fetch;
  const origNow = Date.now;
  globalThis.fetch = async (url) => {
    const key = Object.keys(routes).find((path) => String(url).endsWith(path));
    if (!key) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => routes[key] };
  };
  const p = new LlamaCppProvider('http://x');
  return {
    routes,
    async poll(t, slots) {
      if (slots === null) delete routes['/slots'];
      else routes['/slots'] = JSON.stringify(slots);
      Date.now = () => t;
      return p.poll();
    },
    restore() {
      globalThis.fetch = origFetch;
      Date.now = origNow;
    },
  };
}

test('llama.cpp baseline idle slots are not counted as requests', async () => {
  const h = harness();
  try {
    const r1 = await h.poll(1000, [slot(0, 7, false, 50, 200)]);
    assert.equal(r1.requestCountTotal, 0);
    assert.equal(r1.lastRequest, undefined);
    const r2 = await h.poll(2000, [slot(0, 7, false, 50, 200)]);
    assert.equal(r2.requestCountTotal, 0);
    assert.equal(r2.lastRequest, undefined);
  } finally {
    h.restore();
  }
});

test('llama.cpp busy to idle yields lastRequest and it persists', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 10, 300)]);
    await h.poll(4000, [slot(0, 2, true, 50, 300)]);
    const done = await h.poll(5000, [slot(0, 2, false, 70, 300)]);
    assert.equal(done.requestCountTotal, 1);
    assert.deepEqual(done.lastRequest, {
      model: 'm1',
      runtimeMs: 3000,
      promptTokens: 300,
      genTokens: 70,
      outcome: 'done',
      endedAt: 5000,
      prefillRate: null,
      decodeRate: 20,
    });
    const later = await h.poll(6000, [slot(0, 2, false, 70, 300)]);
    assert.equal(later.requestCountTotal, 1);
    assert.equal(later.lastRequest.genTokens, 70);
  } finally {
    h.restore();
  }
});

test('llama.cpp id_task change counts the finished task', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 0, 50)]);
    await h.poll(3000, [slot(0, 2, true, 30, 50)]);
    await h.poll(3500, [slot(0, 2, true, 45, 50)]);
    const r = await h.poll(4000, [slot(0, 3, true, 5, 80)]);
    assert.equal(r.requestCountTotal, 1);
    assert.equal(r.lastRequest.genTokens, 45);
    assert.equal(r.lastRequest.promptTokens, 50);
    assert.equal(r.lastRequest.decodeRate, 30);
    assert.equal(r.lastRequest.runtimeMs, 2000);
    const r2 = await h.poll(5000, [slot(0, 3, false, 25, 80)]);
    assert.equal(r2.requestCountTotal, 2);
    assert.equal(r2.lastRequest.genTokens, 25);
  } finally {
    h.restore();
  }
});

test('llama.cpp counts a short request seen only idle', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 10)]);
    const r = await h.poll(2000, [slot(0, 2, false, 12, 40)]);
    assert.equal(r.requestCountTotal, 1);
    assert.equal(r.lastRequest.genTokens, 12);
    assert.equal(r.lastRequest.promptTokens, 40);
    assert.equal(r.lastRequest.runtimeMs, null);
    assert.equal(r.lastRequest.decodeRate, null);
    const again = await h.poll(3000, [slot(0, 2, false, 12, 40)]);
    assert.equal(again.requestCountTotal, 1);
  } finally {
    h.restore();
  }
});

test('llama.cpp tracks multiple slots independently', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0), slot(1, 2, false, 0)]);
    await h.poll(2000, [slot(0, 3, true, 0), slot(1, 4, true, 0)]);
    const r1 = await h.poll(3000, [slot(0, 3, false, 10), slot(1, 4, true, 20)]);
    assert.equal(r1.requestCountTotal, 1);
    assert.equal(r1.lastRequest.genTokens, 10);
    const r2 = await h.poll(4000, [slot(0, 3, false, 10), slot(1, 4, false, 40)]);
    assert.equal(r2.requestCountTotal, 2);
    assert.equal(r2.lastRequest.genTokens, 40);
  } finally {
    h.restore();
  }
});

test('llama.cpp yields request metrics with --metrics disabled', async () => {
  const h = harness({ metrics: false });
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 0)]);
    const r = await h.poll(3000, [slot(0, 2, false, 20)]);
    assert.equal(r.metricsDisabled, true);
    assert.equal(r.requestCountTotal, 1);
    assert.equal(r.lastRequest.genTokens, 20);
    assert.equal(r.requestCountSince, 'monitor start');
  } finally {
    h.restore();
  }
});

test('llama.cpp metrics-enabled gauges are unchanged by request tracking', async () => {
  const h = harness({ metrics: true });
  try {
    const r0 = await h.poll(1000, [slot(0, 1, false, 0)]);
    assert.equal(r0.decodeRate, 66.1);
    assert.equal(r0.rateLive, undefined);
    assert.equal(r0.cacheHit.cached, 4992);
    await h.poll(2000, [slot(0, 2, true, 0)]);
    const live = await h.poll(3000, [slot(0, 2, true, 40)]);
    assert.equal(live.decodeRate, 40);
    assert.equal(live.rateLive, true);
    const done = await h.poll(4000, [slot(0, 2, false, 60)]);
    assert.equal(done.decodeRate, 66.1);
    assert.equal(done.promptRate, 0);
    assert.equal(done.rateLive, undefined);
    assert.equal(done.cacheHit.pct, (4992 / (4992 + 128)) * 100);
    assert.equal(done.requestCountTotal, undefined);
    assert.equal(done.lastRequest, undefined);
    assert.equal(r0.requestCountTotal, undefined);
    assert.equal(r0.lastRequest, undefined);
  } finally {
    h.restore();
  }
});

test('llama.cpp yields request metrics when /metrics fetch fails', async () => {
  const h = harness({ metrics: true, metricsFails: true });
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 0)]);
    const r = await h.poll(3000, [slot(0, 2, false, 20)]);
    assert.equal(r.metricsDisabled, undefined);
    assert.ok(r.metricsError);
    assert.equal(r.requestCountTotal, 1);
    assert.equal(r.lastRequest.genTokens, 20);
  } finally {
    h.restore();
  }
});

test('llama.cpp finishes on an idle slot with id_task -1 or null', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0), slot(1, 2, false, 0)]);
    await h.poll(2000, [slot(0, 3, true, 10, 60), slot(1, 4, true, 10, 70)]);
    await h.poll(3000, [slot(0, 3, true, 30, 60), slot(1, 4, true, 30, 70)]);
    const r = await h.poll(4000, [slot(0, -1, false, 50, 60), slot(1, null, false, 5, 70)]);
    assert.equal(r.requestCountTotal, 2);
    // Slot 1's idle count went backwards, so its last live count wins.
    assert.equal(r.lastRequest.genTokens, 30);
    const again = await h.poll(5000, [slot(0, -1, false, 50, 60), slot(1, null, false, 5, 70)]);
    assert.equal(again.requestCountTotal, 2);
  } finally {
    h.restore();
  }
});

test('llama.cpp uses idle n_decoded when it has not gone backwards', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 10, 60)]);
    const r = await h.poll(3000, [slot(0, null, false, 50, 60)]);
    assert.equal(r.requestCountTotal, 1);
    assert.equal(r.lastRequest.genTokens, 50);
  } finally {
    h.restore();
  }
});

test('llama.cpp drops a vanished slot without counting it', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0), slot(1, 2, false, 0)]);
    await h.poll(2000, [slot(0, 3, true, 10), slot(1, 4, true, 10)]);
    const r = await h.poll(3000, [slot(0, 3, true, 20)]);
    assert.equal(r.requestCountTotal, 0);
    // Slot 1 returns with the same task id: a fresh tracker, not a stale one.
    await h.poll(4000, [slot(0, 3, true, 30), slot(1, 4, true, 12)]);
    const done = await h.poll(5000, [slot(0, 3, true, 40), slot(1, 4, false, 20)]);
    assert.equal(done.requestCountTotal, 1);
    assert.equal(done.lastRequest.runtimeMs, 1000);
  } finally {
    h.restore();
  }
});

test('llama.cpp keys slots without an id by index', async () => {
  const h = harness();
  try {
    const noId = (task, processing, decoded) => ({ ...slot(0, task, processing, decoded), id: undefined });
    await h.poll(1000, [noId(1, false, 0), noId(2, false, 0)]);
    await h.poll(2000, [noId(3, true, 0), noId(4, true, 0)]);
    const r = await h.poll(3000, [noId(3, false, 10), noId(4, true, 5)]);
    assert.equal(r.requestCountTotal, 1);
  } finally {
    h.restore();
  }
});

test('llama.cpp /slots failing mid-request does not inflate runtime', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 10)]);
    await h.poll(3000, [slot(0, 2, true, 30)]);
    const failed = await h.poll(30000, null);
    assert.equal(failed.requestCountTotal, 0);
    const r = await h.poll(60000, [slot(0, 2, false, 50)]);
    assert.equal(r.requestCountTotal, 1);
    assert.equal(r.lastRequest.runtimeMs, 1000);
    assert.equal(r.lastRequest.genTokens, 50);
    assert.equal(r.lastRequest.endedAt, 60000);
  } finally {
    h.restore();
  }
});

test('llama.cpp short /slots gap still ends runtime at now', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 10)]);
    await h.poll(4000, null);
    const r = await h.poll(6000, [slot(0, 2, false, 50)]);
    assert.equal(r.lastRequest.runtimeMs, 4000);
  } finally {
    h.restore();
  }
});

test('llama.cpp /slots failing on the first poll defers the baseline', async () => {
  const h = harness();
  try {
    const r0 = await h.poll(1000, null);
    assert.equal(r0.requestCountTotal, undefined);
    const r1 = await h.poll(2000, [slot(0, 5, true, 10), slot(1, 6, false, 20)]);
    assert.equal(r1.requestCountTotal, 0);
    const r2 = await h.poll(3000, [slot(0, 5, false, 40), slot(1, 6, false, 20)]);
    assert.equal(r2.requestCountTotal, 0);
    assert.equal(r2.lastRequest, undefined);
    await h.poll(4000, [slot(0, 7, true, 10), slot(1, 6, false, 20)]);
    const r3 = await h.poll(5000, [slot(0, 7, false, 20), slot(1, 6, false, 20)]);
    assert.equal(r3.requestCountTotal, 1);
  } finally {
    h.restore();
  }
});

test('llama.cpp excludes a request already running on the first poll', async () => {
  const h = harness();
  try {
    const r0 = await h.poll(1000, [slot(0, 5, true, 10)]);
    assert.equal(r0.requestCountTotal, 0);
    const r1 = await h.poll(2000, [slot(0, 5, false, 30)]);
    assert.equal(r1.requestCountTotal, 0);
    assert.equal(r1.lastRequest, undefined);
    await h.poll(3000, [slot(0, 6, true, 5)]);
    const r2 = await h.poll(4000, [slot(0, 6, false, 15)]);
    assert.equal(r2.requestCountTotal, 1);
  } finally {
    h.restore();
  }
});

test('llama.cpp counts a reused task id after a server restart', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 5, true, 10)]);
    const r1 = await h.poll(3000, [slot(0, 5, false, 20)]);
    assert.equal(r1.requestCountTotal, 1);
    // Restart: the same id_task starts running again.
    await h.poll(4000, [slot(0, 5, true, 3)]);
    const r2 = await h.poll(5000, [slot(0, 5, false, 9)]);
    assert.equal(r2.requestCountTotal, 2);
    assert.equal(r2.lastRequest.genTokens, 9);
    assert.equal(r2.lastRequest.runtimeMs, 1000);
  } finally {
    h.restore();
  }
});

test('llama.cpp reports the model the request started on', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 10)]);
    h.routes['/v1/models'] = JSON.stringify({ data: [{ id: 'm2' }] });
    const r = await h.poll(3000, [slot(0, 2, false, 20)]);
    assert.equal(r.lastRequest.model, 'm1');
    const r2 = await h.poll(4000, [slot(0, 3, false, 5)]);
    assert.equal(r2.lastRequest.model, 'm2');
  } finally {
    h.restore();
  }
});

test('llama.cpp tolerates a missing n_decoded', async () => {
  const h = harness();
  try {
    const bare = (task, processing) => ({ id: 0, id_task: task, is_processing: processing, n_ctx: 8192, n_prompt_tokens: 30 });
    await h.poll(1000, [bare(1, false)]);
    await h.poll(2000, [bare(2, true)]);
    const r = await h.poll(3000, [bare(2, false)]);
    assert.equal(r.requestCountTotal, 1);
    assert.equal(r.lastRequest.genTokens, null);
    assert.equal(r.lastRequest.decodeRate, null);
    assert.equal(r.lastRequest.promptTokens, 30);
  } finally {
    h.restore();
  }
});

test('llama.cpp ignores blank and non-numeric n_decoded values', async () => {
  const h = harness();
  try {
    const odd = (v) => ({ ...slot(0, 2, true, 0), next_token: [{ n_decoded: v }] });
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [odd('')]);
    await h.poll(3000, [odd('  ')]);
    await h.poll(3500, [odd(true)]);
    await h.poll(3800, [odd(null)]);
    await h.poll(4000, [odd('25')]);
    const r = await h.poll(5000, [{ ...slot(0, 2, false, 0), next_token: [{ n_decoded: '40' }] }]);
    assert.equal(r.lastRequest.genTokens, 40);
  } finally {
    h.restore();
  }
});

test('llama.cpp decode rate excludes prefill time', async () => {
  const h = harness();
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    await h.poll(2000, [slot(0, 2, true, 0)]);
    await h.poll(8000, [slot(0, 2, true, 0)]);
    await h.poll(9000, [slot(0, 2, true, 10)]);
    await h.poll(11000, [slot(0, 2, true, 50)]);
    const r = await h.poll(12000, [slot(0, 2, false, 60)]);
    assert.equal(r.lastRequest.decodeRate, 20);
    assert.equal(r.lastRequest.runtimeMs, 10000);
  } finally {
    h.restore();
  }
});

test('llama.cpp keeps tracking while metrics toggle between ok and failing', async () => {
  const h = harness({ metrics: true });
  try {
    const metrics = h.routes['/metrics'];
    await h.poll(1000, [slot(0, 1, false, 0)]);
    const on = await h.poll(2000, [slot(0, 2, true, 10)]);
    assert.equal(on.requestCountTotal, undefined);
    delete h.routes['/metrics'];
    const off = await h.poll(3000, [slot(0, 2, false, 30)]);
    assert.ok(off.metricsError);
    assert.equal(off.requestCountTotal, 1);
    assert.equal(off.requestCountSince, 'monitor start');
    assert.equal(off.lastRequest.genTokens, 30);
    h.routes['/metrics'] = metrics;
    const back = await h.poll(4000, [slot(0, 2, false, 30)]);
    assert.equal(back.metricsError, undefined);
    assert.equal(back.requestCountTotal, undefined);
    assert.equal(back.lastRequest, undefined);
    assert.equal(back.decodeRate, 66.1);
    delete h.routes['/metrics'];
    const again = await h.poll(5000, [slot(0, 2, false, 30)]);
    assert.equal(again.requestCountTotal, 1);
  } finally {
    h.restore();
  }
});

test('llama.cpp poll() output with metrics on keeps the HEAD shape', async () => {
  const h = harness({ metrics: true });
  try {
    await h.poll(1000, [slot(0, 1, false, 0)]);
    const r = await h.poll(2000, [slot(0, 1, false, 0, 100), slot(1, 2, false, 0, 300)]);
    assert.deepEqual(r, {
      ok: true,
      error: undefined,
      models: [{ id: 'm1' }],
      loaded: [{ id: 'm1', size: null, context: null, contextTrain: null, params: null, quant: null }],
      slots: { busy: 0, total: 2 },
      kv: { used: 400, total: 16384, pct: (400 / 16384) * 100 },
      promptRate: 0,
      decodeRate: 66.1,
      running: 0,
      waiting: 0,
      promptTotal: 128,
      genTotal: undefined,
      peakTokens: undefined,
      cacheHit: { cached: 4992, prompt: 5120, pct: (4992 / 5120) * 100, scope: 'of all prompt tokens' },
    });
  } finally {
    h.restore();
  }
});
