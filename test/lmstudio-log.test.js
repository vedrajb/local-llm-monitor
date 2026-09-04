import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLmStudioLogLine, parseLmStudioServerLogLine } from '../src/lmstudio-log.js';

test('parses LM Studio completed prediction statistics', () => {
  const line = JSON.stringify({
    timestamp: 1788506829239,
    data: {
      type: 'llm.prediction.output',
      modelIdentifier: 'qwen/qwen3-8b',
      stats: {
        tokensPerSecond: 62.4,
        timeToFirstTokenSec: 0.29,
        promptTokensCount: 25,
        predictedTokensCount: 4096,
        totalTokensCount: 4121,
      },
    },
  });

  assert.deepEqual(parseLmStudioLogLine(line), {
    kind: 'complete',
    decodeRate: 62.4,
    promptTokens: 25,
    genTokens: 4096,
  });
});

test('recognizes an LM Studio request start event', () => {
  assert.deepEqual(
    parseLmStudioLogLine(
      JSON.stringify({
        data: {
          type: 'llm.prediction.input',
          modelIdentifier: 'qwen/qwen3-8b',
          input: 'hello',
        },
      })
    ),
    { kind: 'start' }
  );
});

test('ignores LM Studio log banners and unrelated events', () => {
  assert.equal(parseLmStudioLogLine('Streaming logs from LM Studio'), null);
  assert.equal(
    parseLmStudioLogLine(
      JSON.stringify({ data: { type: 'llm.prediction.reasoning', content: 'thinking' } })
    ),
    null
  );
});

test('recognizes LM Studio server log request boundaries', () => {
  assert.deepEqual(
    parseLmStudioServerLogLine(
      JSON.stringify({
        data: {
          type: 'server.log',
          content: '[2026-09-04 16:03:02][DEBUG] Received request: POST to /v1/chat/completions with body {}',
        },
      })
    ),
    { kind: 'start', endpoint: '/v1/chat/completions' }
  );
  assert.deepEqual(
    parseLmStudioServerLogLine(
      JSON.stringify({
        data: {
          type: 'server.log',
          content: '[2026-09-04 16:03:34][INFO][qwen/qwen3-8b] Generated prediction: {}',
        },
      })
    ),
    { kind: 'complete' }
  );
});

test('does not treat model-list requests as inference activity', () => {
  assert.equal(
    parseLmStudioServerLogLine(
      JSON.stringify({
        data: {
          type: 'server.log',
          content: '[2026-09-04 16:03:03][DEBUG] Received request: GET to /api/v1/models',
        },
      })
    ),
    null
  );
});
