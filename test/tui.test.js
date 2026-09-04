import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTui } from '../src/tui.js';

const provider = { label: 'AMD Lemonade', host: 'http://localhost:13305' };
const model = {
  id: 'Qwen3-8B-GGUF-Q8_0',
  size: null,
  params: null,
  quant: 'Q8_0',
  device: 'gpu',
  context: 32768,
  contextTrain: 40960,
  busy: false,
  streaming: false,
};
const value = {
  ok: true,
  loaded: [model],
  models: [],
  requestCountTotal: 5,
  lastRequest: {
    prefillRate: null,
    decodeRate: 68.2,
    promptTokens: 1,
    genTokens: 4096,
  },
};
const options = {
  gb: (n) => (n == null ? '—' : `${n} GB`),
  pct: (n) => (n == null ? '—' : `${n}%`),
  rate: (n) => (n == null ? '—' : `${n.toFixed(1)} tok/s`),
  interval: 2000,
};

test('renders Lemonade decode history per completed request', () => {
  const output = renderTui(
    provider,
    null,
    value,
    { gpuUtil: [], memBW: [], decodeRate: [68.2, 68.2], requestDecodeRate: [61.4, 68.2] },
    options
  );

  assert.match(output, /decode per request/);
  assert.match(output, /on completion/);
  assert.doesNotMatch(output, /decode trend/);
});
