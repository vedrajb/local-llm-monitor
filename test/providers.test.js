import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePrometheus } from '../src/http.js';
import { VllmProvider } from '../src/providers/vllm.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { LlamaCppProvider } from '../src/providers/llamacpp.js';

function mockFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = Object.keys(routes).find((path) => String(url).endsWith(path));
    if (!key) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => routes[key] };
  };
  return () => {
    globalThis.fetch = original;
  };
}

test('parsePrometheus sums a metric across labels and skips comments', () => {
  const m = parsePrometheus(
    ['# HELP x', 'a{k="1"} 2', 'a{k="2"} 3.5', 'b 7', 'bad line'].join('\n')
  );
  assert.equal(m.get('a'), 5.5);
  assert.equal(m.get('b'), 7);
  assert.equal(m.size, 2);
});

test('vLLM reports queue, KV cache and prefix cache hit rate', async () => {
  const restore = mockFetch({
    '/metrics': [
      'vllm:num_requests_running{model_name="m"} 8',
      'vllm:num_requests_waiting{model_name="m"} 2',
      'vllm:kv_cache_usage_perc{model_name="m"} 0.16',
      'vllm:prefix_cache_hits_total{model_name="m"} 51',
      'vllm:prefix_cache_queries_total{model_name="m"} 100',
      'vllm:prompt_tokens_total{model_name="m"} 1000',
      'vllm:generation_tokens_total{model_name="m"} 500',
    ].join('\n'),
    '/v1/models': JSON.stringify({ data: [{ id: 'local-llm', root: 'Qwen/Qwen3-8B-FP8' }] }),
  });
  try {
    const result = await new VllmProvider('http://x').poll();
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, [{ id: 'local-llm', root: 'Qwen/Qwen3-8B-FP8' }]);
    assert.equal(result.running, 8);
    assert.equal(result.waiting, 2);
    assert.equal(result.kvUsage, 16);
    assert.equal(result.cacheHitRate, 51);
    assert.equal(result.promptRate, undefined);
  } finally {
    restore();
  }
});

test('vLLM smooths successive rate samples with an EWMA', () => {
  const p = new VllmProvider('http://x');
  assert.equal(p.ewma(null, 10), 10);
  assert.equal(p.ewma(10, 20), 0.3 * 20 + 0.7 * 10);
  assert.equal(p.ewma(10, NaN), 10);
});

test('vLLM reports an unreachable server', async () => {
  const restore = mockFetch({});
  try {
    const result = await new VllmProvider('http://x').poll();
    assert.equal(result.ok, false);
    assert.equal(result.error, 'HTTP 404');
  } finally {
    restore();
  }
});

test('Ollama parses the last completed request timings', () => {
  const p = new OllamaProvider('http://x');
  const log = [
    'slot print_timing: id 0 | task 9529 | prompt eval time = 10.00 ms / 5 tokens ( 2.00 ms per token, 500.00 tokens per second)',
    'slot print_timing: id 0 | task 9530 | prompt eval time = 33.47 ms / 23 tokens ( 1.46 ms per token, 687.14 tokens per second)',
    'slot print_timing: id 0 | task 9530 |        eval time = 1821.00 ms / 120 tokens ( 15.18 ms per token, 65.88 tokens per second)',
  ].join('\n');
  assert.deepEqual(p.parseTimings(log), {
    slot: 0,
    task: '9530',
    prefillRate: 687.14,
    promptTokens: 23,
    decodeRate: 65.88,
    genTokens: 120,
  });
  assert.equal(p.parseTimings('nothing relevant'), null);
});

test('Ollama frees a slot on print_timing and resets on all-idle', () => {
  const p = new OllamaProvider('http://x');
  const busy = [
    'slot launch_slot_: id 0 | task 1 | processing task',
    'slot launch_slot_: id 1 | task 2 | processing task',
    'slot print_timing: id 0 | task 1 | prompt eval time = 1.00 ms / 1 tokens ( 1.00 ms per token, 1000.00 tokens per second)',
  ].join('\n');
  assert.deepEqual(p.parseSlots(busy), { busy: 1, total: 2 });
  assert.deepEqual(p.parseSlots(`${busy}\nsrv  update_slots: all slots are idle`), {
    busy: 0,
    total: 2,
  });
  assert.equal(p.parseSlots('no slot events'), null);
});

test('Ollama remembers the slot count from the startup banner', () => {
  const p = new OllamaProvider('http://x');
  p.parseSlots('llama-server -c 65536 -np 4\nslot launch_slot_: id 0 | task 1 | processing task');
  assert.equal(p.parseSlots('slot launch_slot_: id 0 | task 2 | processing task').total, 4);
});

test('Ollama derives KV occupancy from new prompt and release events', () => {
  const p = new OllamaProvider('http://x');
  const log = [
    'slot operator(): id 0 | task 5 | new prompt, n_ctx_slot = 16384, n_keep = 0, task.n_tokens = 38',
    'slot release: id 0 | task 5 | stop processing: n_tokens = 158',
  ].join('\n');
  const kv = p.parseKvUsage(log);
  assert.equal(kv.used, 158);
  assert.equal(kv.total, 16384);
  assert.ok(Math.abs(kv.pct - (158 / 16384) * 100) < 1e-9);
  assert.equal(new OllamaProvider('http://x').parseKvUsage('nothing'), null);
});

test('Ollama derives prefix reuse and prompt cache from the log', () => {
  const p = new OllamaProvider('http://x');
  const log = [
    'slot operator(): id 0 | task 7 | new prompt, n_ctx_slot = 16384, n_keep = 0, task.n_tokens = 38',
    'slot update_slots: id 0 | task 7 | cached n_tokens = 37',
    'srv  update: cache state: 24 prompts, 1552.000 MiB (limits: 8192.000 MiB, 65536 tokens)',
  ].join('\n');
  const hit = p.parseCacheHit(log);
  assert.equal(hit.prompt, 38);
  assert.equal(hit.cached, 37);
  assert.ok(Math.abs(hit.pct - (37 / 38) * 100) < 1e-9);
  assert.deepEqual(p.parsePromptCache(log), { prompts: 24, mib: 1552, limitMib: 8192 });
  assert.equal(p.parsePromptCache('nothing'), null);
});

test('Ollama placement and keep-alive expiry', () => {
  const p = new OllamaProvider('http://x');
  assert.equal(p.placement(100, 100), '100% GPU');
  assert.equal(p.placement(100, 0), '100% CPU');
  assert.equal(p.placement(100, 60), '40%/60% CPU/GPU');
  assert.equal(p.placement(0, 0), null);
  assert.equal(p.placement(null, 5), null);
  assert.equal(p.expiry('2999-01-01T00:00:00Z'), 'forever');
  assert.equal(p.expiry('2000-01-01T00:00:00Z'), 'expired');
  assert.equal(p.expiry('not a date'), null);
});

test('Ollama reports loaded models from /api/ps', async () => {
  const restore = mockFetch({
    '/api/ps': JSON.stringify({
      models: [
        {
          name: 'qwen3:8b-q8_0',
          size: 12700000000,
          size_vram: 12700000000,
          context_length: 16384,
          expires_at: '2999-01-01T00:00:00Z',
          details: { quantization_level: 'Q8_0', parameter_size: '8.2B' },
        },
      ],
    }),
  });
  try {
    const p = new OllamaProvider('http://x');
    p.logPath = 'C:/definitely/not/a/real/server.log';
    const result = await p.poll();
    assert.equal(result.ok, true);
    assert.equal(result.logMissing, p.logPath);
    assert.equal(result.loaded[0].id, 'qwen3:8b-q8_0');
    assert.equal(result.loaded[0].placement, '100% GPU');
    assert.equal(result.loaded[0].quant, 'Q8_0');
    assert.equal(result.loaded[0].params, '8.2B');
    assert.equal(result.loaded[0].context, 16384);
    assert.equal(result.loaded[0].until, 'forever');
  } finally {
    restore();
  }
});

test('llama.cpp formats parameter counts', () => {
  const p = new LlamaCppProvider('http://x');
  assert.equal(p.paramSize(8.2e9), '8.2B');
  assert.equal(p.paramSize(1.5e12), '1.5T');
  assert.equal(p.paramSize(350e6), '350M');
  assert.equal(p.paramSize(0), null);
  assert.equal(p.paramSize(NaN), null);
});

test('llama.cpp sums KV occupancy across slots', () => {
  const p = new LlamaCppProvider('http://x');
  const kv = p.kvFromSlots([
    { n_ctx: 8192, n_prompt_tokens: 1000 },
    { n_ctx: 8192, n_prompt_tokens: 2000 },
  ]);
  assert.deepEqual(kv, { used: 3000, total: 16384, pct: (3000 / 16384) * 100 });
  assert.equal(p.kvFromSlots([]), null);
});

test('llama.cpp differences n_decoded within one task into a live rate', () => {
  const p = new LlamaCppProvider('http://x');
  const slot = (decoded, task = 1, processing = true) => ({
    id: 0,
    id_task: task,
    is_processing: processing,
    next_token: [{ n_decoded: decoded }],
  });
  assert.equal(p.liveDecodeRate([slot(10)], 1000), null);
  assert.equal(p.liveDecodeRate([slot(40)], 2000), 30);
  assert.equal(p.liveDecodeRate([slot(5, 2)], 3000), null);
  assert.equal(p.liveDecodeRate([slot(50, 2, false)], 4000), null);
});

test('llama.cpp reports slots, KV cache, prefix reuse and throughput', async () => {
  const restore = mockFetch({
    '/props': JSON.stringify({ endpoint_metrics: true, total_slots: 1, model_alias: 'qwen3-8b-q8' }),
    '/v1/models': JSON.stringify({
      data: [
        {
          id: 'qwen3-8b-q8',
          meta: { size: 8100000000, n_params: 8.2e9, ftype: 'Q8_0', n_ctx: 32768, n_ctx_train: 40960 },
        },
      ],
    }),
    '/slots': JSON.stringify([{ id: 0, n_ctx: 32768, n_prompt_tokens: 5120, is_processing: false }]),
    '/metrics': [
      'llamacpp:prompt_tokens_seconds 0',
      'llamacpp:predicted_tokens_seconds 66.1',
      'llamacpp:requests_processing 0',
      'llamacpp:requests_deferred 0',
      'llamacpp:prompt_tokens_total 128',
      'llamacpp:prompt_tokens_cached_total 4992',
      'llamacpp:n_tokens_max 5184',
    ].join('\n'),
  });
  try {
    const result = await new LlamaCppProvider('http://x').poll();
    assert.equal(result.ok, true);
    assert.deepEqual(result.loaded[0], {
      id: 'qwen3-8b-q8',
      size: 8100000000,
      context: 32768,
      contextTrain: 40960,
      params: '8.2B',
      quant: 'Q8_0',
    });
    assert.deepEqual(result.slots, { busy: 0, total: 1 });
    assert.equal(result.kv.used, 5120);
    assert.equal(result.decodeRate, 66.1);
    assert.equal(result.rateLive, undefined);
    assert.equal(result.peakTokens, 5184);
    assert.equal(result.cacheHit.cached, 4992);
    assert.equal(result.cacheHit.prompt, 5120);
    assert.equal(result.cacheHit.scope, 'of all prompt tokens');
  } finally {
    restore();
  }
});

test('llama.cpp flags disabled metrics instead of failing', async () => {
  const restore = mockFetch({
    '/props': JSON.stringify({ endpoint_metrics: false, model_alias: 'm' }),
  });
  try {
    const result = await new LlamaCppProvider('http://x').poll();
    assert.equal(result.ok, true);
    assert.equal(result.metricsDisabled, true);
  } finally {
    restore();
  }
});
