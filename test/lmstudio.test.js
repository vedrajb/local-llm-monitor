import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
      [
        'src/index.js',
        '--platform',
        'lmstudio',
        '--lmstudio-host',
        host,
        '--interval',
        '10',
        '--once',
        '--no-keep-awake',
      ],
      {
        cwd: repo,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('monitors LM Studio loaded model metadata and log-stream wait status', async () => {
  const server = createServer((req, res) => {
    if (req.url !== '/api/v1/models') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        models: [
          {
            type: 'llm',
            publisher: 'lmstudio-community',
            key: 'qwen/qwen3-8b',
            display_name: 'Qwen3 8B',
            architecture: 'qwen3',
            quantization: { name: 'Q4_K_M', bits_per_weight: 4 },
            size_bytes: 5030000000,
            params_string: '8B',
            loaded_instances: [
              {
                id: 'qwen/qwen3-8b',
                config: {
                  context_length: 32768,
                  eval_batch_size: 512,
                  flash_attention: true,
                  offload_kv_cache_to_gpu: true,
                },
              },
            ],
            max_context_length: 131072,
            format: 'GGUF',
            capabilities: { vision: false, trained_for_tool_use: true },
          },
        ],
      })
    );
  });
  const port = await listen(server);

  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /LM Studio/);
    assert.match(result.stdout, /model qwen\/qwen3-8b/);
    assert.match(result.stdout, /8B Q4_K_M GGUF\s+4\.7 GB loaded/);
    assert.match(result.stdout, /context 32768\/131072 trained/);
    assert.match(
      result.stdout,
      /throughput unavailable \((?:waiting for a completed request from lms log stream|lms log stream unavailable)/
    );
  } finally {
    await close(server);
  }
});
