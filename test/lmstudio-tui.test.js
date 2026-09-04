import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTui } from '../src/tui.js';

const provider = { label: 'LM Studio', host: 'http://localhost:1234' };
const value = {
  ok: true,
  loaded: [
    {
      id: 'qwen/qwen3-8b',
      size: 5030000000,
      params: '8B',
      quant: 'Q4_K_M',
      format: 'GGUF',
      context: 32768,
      contextTrain: 131072,
    },
  ],
  models: [],
  telemetryUnavailable: 'waiting for a completed request from lms log stream',
};
const options = {
  gb: (n) => (n == null ? '—' : `${n} GB`),
  pct: (n) => (n == null ? '—' : `${n}%`),
  rate: (n) => (n == null ? '—' : `${n.toFixed(1)} tok/s`),
  interval: 2000,
};

test('renders LM Studio model configuration and log-stream wait status', () => {
  const output = renderTui(provider, null, value, { gpuUtil: [], memBW: [], decodeRate: [], requestDecodeRate: [] }, options);

  assert.match(output, /Q4_K_M/);
  assert.match(output, /GGUF/);
  assert.match(output, /context 32768\/131072/);
  assert.match(output, /throughput unavailable/);
  assert.match(output, /waiting for a completed request from lms log stream/);
});

test('keeps the newest GPU trend samples visible', () => {
  const output = renderTui(
    provider,
    [
      {
        index: 0,
        name: 'NVIDIA GeForce RTX 5080 Laptop GPU',
        gpuUtil: 0,
        memUtil: 0,
        memTotal: 16 * 1024 ** 3,
        memUsed: 12.5 * 1024 ** 3,
        temp: 47,
        power: 7,
      },
    ],
    value,
    {
      gpuUtil: [...Array(60).fill(100), ...Array(8).fill(0)],
      memBW: [],
      decodeRate: [],
      requestDecodeRate: [],
    },
    options
  );

  const gpuLine = output.split('\n').find((line) => line.includes('trend'));
  assert.match(gpuLine, /trend .*▁/);
});

test('renders an ongoing LM Studio request as server-log-inferred busy', () => {
  const output = renderTui(
    provider,
    null,
    { ...value, busy: true, activitySource: 'server log inferred' },
    { gpuUtil: [], memBW: [], decodeRate: [], requestDecodeRate: [] },
    options
  );

  assert.match(output, /busy yes/);
  assert.match(output, /server log inferred/);
});
