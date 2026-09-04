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
        'lemonade',
        '--lemonade-host',
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

test('monitors Lemonade health, request stats, and system stats', async () => {
  const server = createServer((req, res) => {
    const responses = {
      '/api/v1/health': {
        status: 'ok',
        version: '10.4.0',
        model_loaded: 'Qwen3-8B-GGUF-Q8_0',
        all_models_loaded: [
          {
            model_name: 'Qwen3-8B-GGUF-Q8_0',
            checkpoint: 'unsloth/Qwen3-8B-GGUF:Q8_0',
            device: 'gpu',
            recipe: 'llamacpp',
            is_busy: true,
            is_streaming: true,
            recipe_options: { ctx_size: 32768, llamacpp_backend: 'cuda' },
          },
        ],
      },
      '/api/v1/models': {
        object: 'list',
        data: [
          {
            id: 'Qwen3-8B-GGUF-Q8_0',
            checkpoint: 'unsloth/Qwen3-8B-GGUF:Q8_0',
            recipe: 'llamacpp',
            size: 8.71,
            context_length: 32768,
            max_context_window: 40960,
            downloaded: true,
          },
        ],
      },
      '/api/v1/stats': {
        request_count_total: 1,
        tokens_per_second: 42.5,
        input_tokens: 128,
        output_tokens: 32,
        prompt_tokens: 128,
        cache_tokens: 96,
      },
      '/api/v1/system-stats': {
        cpu_percent: 23.4,
        memory_gb: 6.5,
        gpu_percent: 67.8,
        vram_gb: 4.2,
        npu_percent: 11.2,
      },
    };
    const body = responses[req.url];
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  const port = await listen(server);

  try {
    const result = await runMonitor(`http://127.0.0.1:${port}`);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /AMD Lemonade/);
    assert.match(result.stdout, /model Qwen3-8B-GGUF-Q8_0/);
    assert.match(result.stdout, /device gpu/);
    assert.match(result.stdout, /context 32768\/40960 trained/);
    assert.match(result.stdout, /request state  busy yes  streaming yes/);
    assert.match(result.stdout, /requests completed  1/);
    assert.match(result.stdout, /prefix reuse 43%/);
    assert.match(result.stdout, /last request  input 128 tok  decode 42\.5 tok\/s \(32 tok\)/);
    assert.match(result.stdout, /CPU 23%  RAM 6\.5 GB used  GPU 68%  VRAM 4\.2 GB used  NPU 11%/);
  } finally {
    await close(server);
  }
});
