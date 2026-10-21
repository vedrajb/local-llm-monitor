import assert from 'node:assert/strict';
import test from 'node:test';

import { buildServerArgs, parseArgs, serverUrl } from '../scripts/llamacpp-serve.mjs';

const DEFAULTS = [
  '-hf', 'Qwen/Qwen3-8B-GGUF:Q8_0',
  '--alias', 'qwen3-8b-q8',
  '--host', '127.0.0.1',
  '--port', '8080',
  '-c', '32768',
  '-np', '1',
  '-ngl', 'all',
  '-fa', 'on',
];

test('buildServerArgs defaults mirror start-llamacpp.bat', () => {
  assert.deepEqual(buildServerArgs({}), [...DEFAULTS, '--metrics']);
});

test('buildServerArgs omits --metrics when disabled', () => {
  assert.deepEqual(buildServerArgs({}, { metrics: false }), DEFAULTS);
});

test('buildServerArgs applies env overrides', () => {
  const args = buildServerArgs({
    LLAMACPP_MODEL: 'org/m:Q4', LLAMACPP_ALIAS: 'a', LLAMACPP_BIND: '0.0.0.0',
    LLAMACPP_PORT: '9000', LLAMACPP_CTX: '4096', LLAMACPP_SLOTS: '2',
  });
  assert.deepEqual(args, [
    '-hf', 'org/m:Q4', '--alias', 'a', '--host', '0.0.0.0', '--port', '9000',
    '-c', '4096', '-np', '2', '-ngl', 'all', '-fa', 'on', '--metrics',
  ]);
});

test('parseArgs separates own flags from monitor passthrough', () => {
  assert.deepEqual(parseArgs([]), { metrics: true, withMonitor: false, monitorArgs: [] });
  assert.deepEqual(
    parseArgs(['--with-monitor', '--no-metrics', '--plain', '--interval', '2']),
    { metrics: false, withMonitor: true, monitorArgs: ['--plain', '--interval', '2'] },
  );
});

test('serverUrl uses defaults and env', () => {
  assert.equal(serverUrl({}), 'http://127.0.0.1:8080');
  assert.equal(serverUrl({ LLAMACPP_BIND: 'h', LLAMACPP_PORT: '1' }), 'http://h:1');
});
