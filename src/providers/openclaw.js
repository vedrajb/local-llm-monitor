import { spawn } from 'node:child_process';
import { fetchText } from '../http.js';

const STATUS_INTERVAL = 30000;
const STATUS_TIMEOUT = 20000;
const SESSIONS_INTERVAL = 3000;
const SESSIONS_TIMEOUT = 10000;

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

export function parseOpenClawReady(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const loop = data?.eventLoop && typeof data.eventLoop === 'object' ? data.eventLoop : {};
  return {
    ready: data?.ready === true,
    failing: Array.isArray(data?.failing) ? data.failing.map(String) : [],
    uptimeMs: num(data?.uptimeMs),
    eventLoop: {
      degraded: loop.degraded === true,
      reasons: Array.isArray(loop.reasons) ? loop.reasons.map(String) : [],
      delayP99Ms: num(loop.delayP99Ms),
      utilization: num(loop.utilization),
    },
  };
}

export function parseOpenClawStatus(text) {
  const data = parseJson(text);
  if (!data) return null;
  const tasks = data?.tasks && typeof data.tasks === 'object' ? data.tasks : {};
  const byStatus = tasks.byStatus && typeof tasks.byStatus === 'object' ? tasks.byStatus : {};
  return {
    version: typeof data?.runtimeVersion === 'string' ? data.runtimeVersion : null,
    pid: num(data?.pid),
    rssBytes: num(data?.processMemory?.rssBytes),
    connectLatencyMs: num(data?.gateway?.connectLatencyMs),
    tasks: {
      active: num(tasks.active),
      queued: num(byStatus.queued),
      running: num(byStatus.running),
      failed: num(byStatus.failed),
    },
    sessions: num(data?.sessions?.count),
    channels: Array.isArray(data?.channelSummary) ? data.channelSummary.length : null,
    modelRuntimeDegraded: data?.modelRuntime?.degraded === true,
    degradedPlugins: Array.isArray(data?.degradedPlugins) ? data.degradedPlugins.length : 0,
  };
}

export function parseOpenClawSessions(text) {
  const data = parseJson(text);
  if (!Array.isArray(data?.sessions)) return null;
  return data.sessions
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      active: s.hasActiveRun === true || s.status === 'running',
      status: typeof s.status === 'string' ? s.status : null,
      runId: typeof s.lastRunId === 'string' ? s.lastRunId : null,
      startedAt: num(s.startedAt),
      endedAt: num(s.endedAt),
      runtimeMs: num(s.runtimeMs),
      inputTokens: num(s.inputTokens),
      outputTokens: num(s.outputTokens),
      contextTokens: num(s.contextTokens),
      model: typeof s.model === 'string' ? s.model : null,
      aborted: s.abortedLastRun === true,
    }));
}

export function summarizeOpenClawRequests(sessions, now = Date.now()) {
  const active = sessions.filter((s) => s.active);
  const last = sessions
    .filter((s) => !s.active && s.endedAt != null)
    .sort((a, b) => b.endedAt - a.endedAt)[0];
  const runtimeMs = last
    ? last.runtimeMs ?? (last.startedAt != null ? last.endedAt - last.startedAt : null)
    : null;
  return {
    busy: active.length > 0,
    running: active.length,
    activeElapsedMs: active.length
      ? Math.max(...active.map((s) => (s.startedAt != null ? now - s.startedAt : 0)))
      : null,
    lastRequest: last
      ? {
          model: last.model,
          runtimeMs,
          promptTokens: last.inputTokens,
          genTokens: last.outputTokens,
          contextTokens: last.contextTokens,
          outcome: last.aborted ? 'aborted' : last.status,
          endedAt: last.endedAt,
          prefillRate: null,
          decodeRate: null,
        }
      : null,
  };
}

function runOpenClaw(command, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    let timer;
    const done = (error) => {
      clearTimeout(timer);
      resolve({ out, error });
    };
    try {
      const opts = { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
      child =
        process.platform === 'win32'
          ? spawn(`openclaw ${command.join(' ')}`, { ...opts, shell: true })
          : spawn('openclaw', command, opts);
    } catch (error) {
      return resolve({ out, error: error?.message || String(error) });
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done(`openclaw ${command.join(' ')} timed out`);
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.once('error', (error) => done(error?.message || String(error)));
    child.once('close', (code) =>
      done(code === 0 ? null : `openclaw ${command.join(' ')} exited with code ${code}`)
    );
  });
}

export class OpenClawProvider {
  constructor(host) {
    this.host = host;
    this.label = 'OpenClaw';
    this.status = null;
    this.statusError = null;
    this.statusPending = null;
    this.statusTimer = null;
    this.sessions = null;
    this.sessionsError = null;
    this.sessionsPending = null;
    this.sessionsTimer = null;
    this.monitorStartedAt = Date.now();
    this.countedRuns = new Set();
    this.requestCountTotal = 0;
  }

  refreshStatus() {
    if (this.statusPending) return this.statusPending;
    this.statusPending = runOpenClaw(['status', '--json'], STATUS_TIMEOUT).then(({ out, error }) => {
      const status = parseOpenClawStatus(out);
      if (status) {
        this.status = status;
        this.statusError = null;
      } else {
        this.statusError = error || 'unreadable openclaw status output';
      }
      this.statusPending = null;
    });
    return this.statusPending;
  }

  refreshSessions() {
    if (this.sessionsPending) return this.sessionsPending;
    this.sessionsPending = runOpenClaw(
      ['gateway', 'call', 'sessions.list', '--json'],
      SESSIONS_TIMEOUT
    ).then(({ out, error }) => {
      const sessions = parseOpenClawSessions(out);
      if (sessions) {
        this.sessions = sessions;
        this.sessionsError = null;
        for (const s of sessions) {
          if (s.active || !s.runId || s.endedAt == null || s.endedAt < this.monitorStartedAt) continue;
          if (this.countedRuns.has(s.runId)) continue;
          this.countedRuns.add(s.runId);
          this.requestCountTotal += 1;
        }
      } else {
        this.sessionsError = error || 'unreadable sessions.list output';
      }
      this.sessionsPending = null;
    });
    return this.sessionsPending;
  }

  startStatus() {
    if (this.statusTimer) return;
    this.refreshStatus();
    this.statusTimer = setInterval(() => this.refreshStatus(), STATUS_INTERVAL);
    this.statusTimer.unref();
    this.refreshSessions();
    this.sessionsTimer = setInterval(() => this.refreshSessions(), SESSIONS_INTERVAL);
    this.sessionsTimer.unref();
  }

  async poll() {
    const res = await fetchText(`${this.host}/ready`, 3000);
    const requests = this.sessions
      ? { ...summarizeOpenClawRequests(this.sessions), completed: this.requestCountTotal }
      : null;
    const gateway = {
      status: this.status,
      statusError: this.statusError,
      requests,
      requestsError: this.sessionsError,
    };
    const result = {
      ok: true,
      models: [],
      requestCountTotal: requests ? this.requestCountTotal : null,
      lastRequest: requests?.lastRequest ?? null,
    };
    if (!res.ok) {
      if (res.error === 'HTTP 503') {
        return { ...result, gateway: { ...gateway, ready: false, failing: [] } };
      }
      return { ok: false, error: res.error, models: [] };
    }
    const ready = parseOpenClawReady(res.text);
    if (!ready) return { ok: false, error: 'bad JSON from /ready', models: [] };
    this.startStatus();
    return { ...result, gateway: { ...gateway, ...ready } };
  }
}
