import assert from 'node:assert/strict';
import test from 'node:test';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHermesEnvKey } from '../src/config.js';
import {
  HermesProvider,
  parseHermesHealth,
  parseHermesDetailed,
  parseHermesSessions,
  parseHermesTurns,
} from '../src/providers/hermes.js';
import { DatabaseSync } from 'node:sqlite';

test('parseHermesTurns pairs user and final assistant messages and counts tools', () => {
  const now = 1_790_000_000_000;
  const at = (s) => now / 1000 - s;
  const { turns, active } = parseHermesTurns(
    [
      { id: 1, sessionId: 'a', role: 'user', timestamp: at(100) },
      { id: 2, sessionId: 'a', role: 'assistant', timestamp: at(95), hasToolCalls: 1 },
      { id: 3, sessionId: 'a', role: 'tool', timestamp: at(94) },
      { id: 4, sessionId: 'a', role: 'assistant', timestamp: at(90), finishReason: 'stop', hasToolCalls: 0 },
      { id: 5, sessionId: 'a', role: 'user', timestamp: at(80) },
      { id: 6, sessionId: 'a', role: 'user', timestamp: at(70) },
      { id: 7, sessionId: 'a', role: 'assistant', timestamp: at(60), hasToolCalls: 0 },
      { id: 8, sessionId: 'b', role: 'user', timestamp: at(10) },
      { id: 9, sessionId: 'b', role: 'tool', timestamp: at(5) },
      { id: 10, sessionId: 'c', role: 'user', timestamp: at(3600) },
    ],
    now
  );
  assert.deepEqual(
    turns.map((t) => [t.key, t.runtimeMs, t.toolCalls, t.outcome]),
    [
      ['a:1', 10000, 1, 'stop'],
      ['a:5', 0, 0, 'no reply'],
      ['a:6', 10000, 0, 'incomplete'],
    ]
  );
  assert.deepEqual(active.map((t) => [t.key, t.toolCalls]), [['b:8', 1]]);
});

test('Hermes provider reads per-turn usage from state.db', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-db-'));
  const path = join(dir, 'state.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT, model TEXT, started_at REAL, ended_at REAL, input_tokens INT, output_tokens INT, api_call_count INT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, timestamp REAL, finish_reason TEXT, tool_calls TEXT, active INT);`);
  const t0 = Date.now() / 1000 + 1;
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, NULL, ?, ?, ?)').run('s', 'gpt', t0 - 200, 100, 10, 1);
  const restore = mockFetch({ '/health/detailed': 401, '/health': '{"status":"ok"}' });
  try {
    const p = new HermesProvider('http://h', undefined, path);
    await p.poll();
    const msg = db.prepare('INSERT INTO messages (session_id, role, timestamp, finish_reason, tool_calls, active) VALUES (?, ?, ?, ?, ?, 1)');
    msg.run('s', 'user', t0 + 1, null, null);
    let v = await p.poll();
    assert.equal(v.gateway.requests.busy, true);
    assert.equal(v.gateway.requests.source, 'state.db');
    msg.run('s', 'assistant', t0 + 2, null, '[{"id":"x"}]');
    msg.run('s', 'tool', t0 + 3, null, null);
    msg.run('s', 'assistant', t0 + 5, 'stop', null);
    db.prepare('UPDATE sessions SET input_tokens = 700, output_tokens = 90, api_call_count = 3').run();
    v = await p.poll();
    assert.equal(v.gateway.requests.busy, false);
    assert.equal(v.requestCountTotal, 1);
    assert.equal(v.lastRequest.model, 'gpt');
    assert.equal(v.lastRequest.promptTokens, 600);
    assert.equal(v.lastRequest.genTokens, 80);
    assert.equal(v.lastRequest.apiCalls, 2);
    assert.equal(v.lastRequest.toolCalls, 1);
    assert.equal(v.lastRequest.outcome, 'stop');
    assert.equal(v.lastRequest.decodeRate, null);
    assert.ok(Math.abs(v.lastRequest.runtimeMs - 4000) < 5);
    p.db?.close();
  } finally {
    restore();
    db.close();
  }
});

test('Hermes provider falls back to /api/sessions when state.db is unreadable', async () => {
  const restore = mockFetch({ '/health/detailed': 401, '/api/sessions': '{"data":[]}', '/health': '{"status":"ok"}' });
  try {
    const v = await new HermesProvider('http://h', undefined, join(tmpdir(), 'no-such-dir', 'state.db')).poll();
    assert.equal(v.gateway.requests.source, undefined);
    assert.match(v.gateway.requestsError, /^state\.db /);
  } finally {
    restore();
  }
});

function mockFetch(routes) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const key = Object.keys(routes).find((path) => String(url).includes(path));
    if (!key) return { ok: false, status: 404, text: async () => '' };
    const r = routes[key];
    if (typeof r === 'number') return { ok: false, status: r, text: async () => '' };
    return { ok: true, status: 200, text: async () => r };
  };
  return () => {
    globalThis.fetch = original;
  };
}

test('parseHermesHealth reads status and rejects non-JSON', () => {
  assert.deepEqual(parseHermesHealth('{"status":"ok"}'), { status: 'ok' });
  assert.equal(parseHermesHealth('nope'), null);
});

test('parseHermesDetailed collects unhealthy components and counts', () => {
  const d = parseHermesDetailed(
    JSON.stringify({
      status: 'degraded',
      gateway: { state: 'running' },
      database: { status: 'ok' },
      disk: { status: 'low' },
      active_runs: [{ id: 'a' }, { id: 'b' }],
      pending_processes: { count: 3 },
    })
  );
  assert.equal(d.status, 'degraded');
  assert.equal(d.gatewayState, 'running');
  assert.deepEqual(d.failing, ['disk']);
  assert.equal(d.activeRuns, 2);
  assert.equal(d.pendingProcesses, 3);
  assert.equal(d.delegations, null);
  assert.equal(parseHermesDetailed('[]'), null);
});

test('parseHermesDetailed reads the real nested readiness shape', () => {
  const d = parseHermesDetailed(
    JSON.stringify({
      status: 'ok',
      readiness: {
        status: 'ok',
        checks: {
          disk: { status: 'error', used_percent: 99 },
          model: { status: 'ok' },
          background_queues: { status: 'ok', active_api_runs: 2, process_completions: 1, active_delegations: 3 },
        },
      },
      gateway_state: 'running',
      platforms: { api_server: { metrics: { metrics_today: { requests: 4, tokens: 90, latency_p95_ms: 120 } } } },
    })
  );
  assert.deepEqual(d.failing, ['disk']);
  assert.equal(d.activeRuns, 2);
  assert.equal(d.pendingProcesses, 1);
  assert.equal(d.delegations, 3);
  assert.equal(d.gatewayState, 'running');
  assert.deepEqual(d.today, { requests: 4, tokens: 90, latencyP95Ms: 120 });
});

test('parseHermesSessions ignores stale open sessions and reads the data list', () => {
  const now = 1_790_000_000_000;
  const s = parseHermesSessions(
    JSON.stringify({
      object: 'list',
      data: [
        { id: 'stale', started_at: now / 1000 - 900, ended_at: null, last_active: now / 1000 - 600 },
        { id: 'live', started_at: now / 1000 - 30, ended_at: null, last_active: now / 1000 - 5 },
      ],
    }),
    now
  );
  assert.equal(s[0].active, false);
  assert.equal(s[1].active, true);
});

test('parseHermesSessions converts seconds to ms and flags active sessions', () => {
  const s = parseHermesSessions(
    JSON.stringify({
      sessions: [
        { id: 'a', model: 'm', started_at: 1000, ended_at: 1010, input_tokens: 5, output_tokens: 20, end_reason: 'interrupted' },
        { id: 'b', started_at: 2000, ended_at: null },
      ],
    })
  );
  assert.equal(s[0].startedAt, 1000000);
  assert.equal(s[0].endedAt, 1010000);
  assert.equal(s[0].active, false);
  assert.equal(s[0].aborted, true);
  assert.equal(s[1].active, true);
  assert.equal(parseHermesSessions('{"x":1}'), null);
});

test('Hermes provider reports health only when unauthenticated', async () => {
  const restore = mockFetch({ '/health/detailed': 401, '/api/sessions': 401, '/health': '{"status":"ok"}' });
  try {
    const v = await new HermesProvider('http://h').poll();
    assert.equal(v.ok, true);
    assert.equal(v.gateway.kind, 'hermes');
    assert.equal(v.gateway.ready, true);
    assert.equal(v.gateway.detailedError, 'HTTP 401');
    assert.equal(v.gateway.requestsError, 'HTTP 401');
    assert.equal(v.gateway.requests, null);
  } finally {
    restore();
  }
});

test('Hermes provider counts sessions finished after monitor start once', async () => {
  const now = Date.now() / 1000;
  const sessions = JSON.stringify({
    sessions: [
      { id: 'old', started_at: now - 500, ended_at: now - 400, end_reason: 'done' },
      { id: 'new', model: 'm', started_at: now + 1, ended_at: now + 11, input_tokens: 10, output_tokens: 100, end_reason: 'done' },
    ],
  });
  const restore = mockFetch({
    '/health/detailed': JSON.stringify({
      status: 'ok',
      readiness: { checks: { background_queues: { status: 'ok', active_api_runs: 1 } } },
    }),
    '/api/sessions': sessions,
    '/health': '{"status":"ok"}',
  });
  try {
    const p = new HermesProvider('http://h');
    await p.poll();
    const v = await p.poll();
    assert.equal(v.requestCountTotal, 1);
    assert.equal(v.gateway.requests.busy, true);
    assert.equal(v.gateway.requests.running, 1);
    assert.equal(v.lastRequest.genTokens, 100);
    assert.equal(v.lastRequest.model, 'm');
    assert.equal(v.lastRequest.decodeRate, null);
    assert.equal(v.gateway.requests.activeElapsedMs, null);
  } finally {
    restore();
  }
});

test('Hermes provider reports unreachable when /health fails', async () => {
  const restore = mockFetch({ '/health': 503 });
  try {
    const v = await new HermesProvider('http://h').poll();
    assert.equal(v.ok, false);
    assert.equal(v.error, 'HTTP 503');
  } finally {
    restore();
  }
});

test('readHermesEnvKey reads API_SERVER_KEY from an env file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-env-'));
  const file = join(dir, '.env');
  writeFileSync(file, '# c\r\nOTHER=1\r\nAPI_SERVER_KEY="abc123"\r\n');
  assert.equal(readHermesEnvKey(file), 'abc123');
  writeFileSync(file, 'API_SERVER_KEY=\n');
  assert.equal(readHermesEnvKey(file), null);
  assert.equal(readHermesEnvKey(join(dir, 'missing')), null);
});

