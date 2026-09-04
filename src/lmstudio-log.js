import { spawn } from 'node:child_process';

function number(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseLmStudioLogLine(line) {
  if (typeof line !== 'string') return null;

  let record;
  try {
    record = JSON.parse(line.trim());
  } catch {
    return null;
  }

  const data = record?.data;
  if (data?.type === 'llm.prediction.input') return { kind: 'start' };
  if (data?.type !== 'llm.prediction.output') return null;
  const stats = data.stats && typeof data.stats === 'object' ? data.stats : {};

  const decodeRate = number(stats.tokensPerSecond);
  const promptTokens = number(stats.promptTokensCount);
  const genTokens = number(stats.predictedTokensCount);

  return { kind: 'complete', decodeRate, promptTokens, genTokens };
}

export function parseLmStudioServerLogLine(line) {
  if (typeof line !== 'string') return null;

  let record;
  try {
    record = JSON.parse(line.trim());
  } catch {
    return null;
  }

  const content = record?.data?.content;
  if (typeof content !== 'string') return null;

  const request = content.match(/Received request:\s+POST to\s+(\S+)/i);
  if (
    request &&
    /^\/(?:api\/)?v1\/(?:chat(?:\/completions)?|completions|responses)(?:[/?]|$)/i.test(request[1])
  ) {
    return { kind: 'start', endpoint: request[1] };
  }
  if (/\]\s*Generated (?:prediction|response):/i.test(content)) return { kind: 'complete' };
  return null;
}

export function startLmStudioLogStream(onRequest, onError = () => {}, source = 'model') {
  const streamArgs =
    source === 'server'
      ? ['log', 'stream', '--json', '--source', 'server']
      : ['log', 'stream', '--json', '--stats', '--source', 'model', '--filter', 'output'];
  const parse = source === 'server' ? parseLmStudioServerLogLine : parseLmStudioLogLine;
  let child;
  try {
    child = spawn('lms', streamArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    onError(error);
    return () => {};
  }

  let pending = '';
  let stderr = '';
  let stopped = false;
  let reportedError = false;
  const reportError = (error) => {
    if (reportedError) return;
    reportedError = true;
    onError(error);
  };
  const consume = (chunk) => {
    pending += chunk.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const request = parse(line);
      if (request) onRequest(request);
    }
  };

  child.stdout.on('data', consume);
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-512);
  });
  child.once('error', (error) => {
    if (!stopped) reportError(error);
  });
  child.once('close', (code, signal) => {
    if (pending) {
      const request = parse(pending);
      if (request) onRequest(request);
    }
    if (!stopped) {
      const detail = stderr.trim() || `exited with ${code != null ? `code ${code}` : signal || 'unknown status'}`;
      reportError(new Error(`lms log stream ${detail}`));
    }
  });

  return () => {
    stopped = true;
    if (!child.killed) child.kill();
  };
}

export function startLmStudioServerLogStream(onRequest, onError = () => {}) {
  return startLmStudioLogStream(onRequest, onError, 'server');
}
