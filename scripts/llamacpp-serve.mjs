// Starts llama-server (mirrors start-llamacpp.bat); --with-monitor also runs the TUI monitor.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildServerArgs(env = {}, { metrics = true } = {}) {
  const args = [
    '-hf', env.LLAMACPP_MODEL || 'Qwen/Qwen3-8B-GGUF:Q8_0',
    '--alias', env.LLAMACPP_ALIAS || 'qwen3-8b-q8',
    '--host', env.LLAMACPP_BIND || '127.0.0.1',
    '--port', String(env.LLAMACPP_PORT || '8080'),
    '-c', String(env.LLAMACPP_CTX || '32768'),
    '-np', String(env.LLAMACPP_SLOTS || '1'),
    '-ngl', 'all',
    '-fa', 'on',
  ];
  if (metrics) args.push('--metrics');
  return args;
}

export function parseArgs(argv) {
  const opts = { metrics: true, withMonitor: false, monitorArgs: [] };
  for (const arg of argv) {
    if (arg === '--no-metrics') opts.metrics = false;
    else if (arg === '--with-monitor') opts.withMonitor = true;
    else opts.monitorArgs.push(arg);
  }
  return opts;
}

export function serverUrl(env = {}) {
  return `http://${env.LLAMACPP_BIND || '127.0.0.1'}:${env.LLAMACPP_PORT || '8080'}`;
}

function notOnPath() {
  console.error([
    '',
    '  llama-server is not on PATH.',
    '  Add %USERPROFILE%\workspace\_ai\llamacpp to Path, then reopen this window.',
    '  See llamacpp-setup-windows.md, step 3.',
    '',
  ].join('\n'));
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

async function waitForProps(url, server, timeoutMs, state) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited || state.missing) return false;
    try {
      const res = await fetch(`${url}/props`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function runServeOnly(args) {
  const child = spawn('llama-server', args, { stdio: 'inherit' });
  child.on('error', (err) => {
    if (err.code === 'ENOENT') { notOnPath(); process.exit(1); }
    console.error(err.message);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => killTree(child));
}

async function runWithMonitor(args, opts, env) {
  const logDir = resolve(repo, '.temp');
  mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, 'llama-server.log');
  const logFd = openSync(logPath, 'w');
  const url = serverUrl(env);
  console.log(`llama-server log: ${logPath}`);
  console.log(`Waiting for ${url}/props (up to 300s; first run may download the model)...`);

  const state = { exited: false, missing: false };
  const server = spawn('llama-server', args, { stdio: ['ignore', logFd, logFd] });
  closeSync(logFd);
  let monitor = null;
  let cleaned = false;
  const cleanup = (code) => {
    if (cleaned) return;
    cleaned = true;
    killTree(server);
    process.exit(code);
  };
  server.on('error', (err) => {
    state.missing = true;
    if (err.code === 'ENOENT') notOnPath(); else console.error(err.message);
    cleanup(1);
  });
  server.on('exit', (code) => {
    state.exited = true;
    if (!monitor) {
      console.error(`llama-server exited early (code ${code}). See ${logPath}`);
      cleanup(1);
    }
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { if (monitor) killTree(monitor); cleanup(130); });
  }

  const ready = await waitForProps(url, server, 300_000, state);
  if (!ready) {
    if (!cleaned) console.error(`llama-server not ready within 300s. See ${logPath}`);
    return cleanup(1);
  }

  monitor = spawn(process.execPath, [
    resolve(repo, 'src', 'index.js'),
    '--platform', 'llamacpp', '--llamacpp-host', url, ...opts.monitorArgs,
  ], { stdio: 'inherit', cwd: repo });
  monitor.on('error', (err) => { console.error(err.message); cleanup(1); });
  monitor.on('exit', (code) => cleanup(code ?? 0));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const args = buildServerArgs(process.env, { metrics: opts.metrics });
  if (!opts.withMonitor) {
    console.log(`Starting llama-server on ${serverUrl(process.env)}\nCtrl-C to stop.\n`);
    return runServeOnly(args);
  }
  return runWithMonitor(args, opts, process.env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
