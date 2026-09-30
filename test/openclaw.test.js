import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeOpenClawRequests } from '../src/providers/openclaw.js';

test('OpenClaw last request reports run time and tokens but no rate', () => {
  const r = summarizeOpenClawRequests(
    [
      { active: false, status: 'done', startedAt: 1000, endedAt: 5000, runtimeMs: null, inputTokens: 10, outputTokens: 400, model: 'm' },
      { active: false, status: 'done', startedAt: 0, endedAt: 900, runtimeMs: 900, inputTokens: 1, outputTokens: 2, model: 'old' },
    ],
    6000
  );
  assert.equal(r.busy, false);
  assert.equal(r.lastRequest.model, 'm');
  assert.equal(r.lastRequest.runtimeMs, 4000);
  assert.equal(r.lastRequest.genTokens, 400);
  assert.equal(r.lastRequest.decodeRate, null);
  assert.equal(r.lastRequest.prefillRate, null);
});
