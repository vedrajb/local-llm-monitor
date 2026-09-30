import { fetchText } from '../http.js';
import { summarizeOpenClawRequests } from './openclaw.js';

const SESSIONS_LIMIT = 20;
const ACTIVE_WINDOW_MS = 60000;
const ACTIVE_TURN_MS = 15 * 60000;
const MESSAGES_LIMIT = 200;
const HEALTHY = new Set(['ok', 'healthy', 'ready', 'up', 'running', 'connected', 'pass', 'passing']);

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function epochMs(value) {
  const n = num(value);
  if (n == null) return null;
  return n < 1e12 ? Math.round(n * 1000) : n;
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (num(value) != null) return value;
  if (value && typeof value === 'object') return num(value.count) ?? num(value.active) ?? null;
  return null;
}

function findKey(obj, pattern, depth = 4) {
  if (!obj || typeof obj !== 'object' || depth < 0) return undefined;
  for (const [k, v] of Object.entries(obj)) if (pattern.test(k)) return v;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findKey(v, pattern, depth - 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function parseHermesHealth(text) {
  const data = parseJson(text);
  if (!data || typeof data !== 'object') return null;
  return { status: typeof data.status === 'string' ? data.status : null };
}

export function parseHermesDetailed(text) {
  const data = parseJson(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const failing = [];
  const scan = (obj, prefix) => {
    for (const [name, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const st = typeof v.status === 'string' ? v.status.toLowerCase() : null;
      if (st && !HEALTHY.has(st)) failing.push(`${prefix}${name}`);
    }
  };
  scan(data, '');
  for (const container of [data, data.readiness]) {
    for (const key of ['checks', 'components']) {
      const group = container?.[key];
      if (group && typeof group === 'object' && !Array.isArray(group)) scan(group, '');
    }
  }
  const gatewayState = data.gateway_state ?? findKey(data, /^gateway(_state)?$/i);
  const today = findKey(data, /^metrics_today$/i);
  return {
    status: typeof data.status === 'string' ? data.status : null,
    failing,
    activeRuns: countOf(findKey(data, /^(active_(api_)?runs)$/i)),
    pendingProcesses: countOf(findKey(data, /^(pending_?process\w*|process_completions)$/i)),
    delegations: countOf(findKey(data, /^(active_?)?delegations$/i)),
    today: today && typeof today === 'object'
      ? {
          requests: num(today.requests),
          tokens: num(today.tokens),
          latencyP95Ms: num(today.latency_p95_ms),
        }
      : null,
    gatewayState:
      typeof gatewayState === 'string'
        ? gatewayState
        : typeof gatewayState?.state === 'string'
          ? gatewayState.state
          : typeof gatewayState?.status === 'string'
            ? gatewayState.status
            : null,
  };
}

export function parseHermesSessions(text, now = Date.now()) {
  const data = parseJson(text);
  const list = Array.isArray(data)
    ? data
    : [data?.data, data?.sessions, data?.items, data?.results].find(Array.isArray);
  if (!list) return null;
  return list
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const startedAt = epochMs(s.started_at ?? s.startedAt);
      const endedAt = epochMs(s.ended_at ?? s.endedAt);
      const lastActive = epochMs(s.last_active ?? s.lastActive);
      const reason = typeof s.end_reason === 'string' ? s.end_reason : null;
      return {
        active: endedAt == null && (lastActive == null || now - lastActive < ACTIVE_WINDOW_MS),
        status: endedAt == null ? 'running' : reason || 'done',
        runId: s.id != null ? String(s.id) : null,
        startedAt,
        endedAt,
        runtimeMs: null,
        inputTokens: num(s.input_tokens ?? s.inputTokens),
        outputTokens: num(s.output_tokens ?? s.outputTokens),
        contextTokens: null,
        model: typeof s.model === 'string' ? s.model : null,
        aborted: reason != null && /abort|interrupt|cancel/i.test(reason),
      };
    });
}

export function parseHermesTurns(rows, now = Date.now()) {
  const bySession = new Map();
  for (const r of rows) {
    if (!r || r.sessionId == null) continue;
    const list = bySession.get(r.sessionId) ?? [];
    list.push(r);
    bySession.set(r.sessionId, list);
  }
  const turns = [];
  const active = [];
  for (const [sessionId, msgs] of bySession) {
    let turn = null;
    const close = (outcome, endedAt) => {
      turns.push({ ...turn, endedAt, outcome, runtimeMs: endedAt - turn.startedAt });
      turn = null;
    };
    for (const m of msgs) {
      const ts = epochMs(m.timestamp);
      if (m.role === 'user') {
        if (turn) close('no reply', turn.lastAt);
        if (ts == null) continue;
        turn = { key: `${sessionId}:${m.id}`, sessionId, startedAt: ts, lastAt: ts, toolCalls: 0 };
        continue;
      }
      if (!turn) continue;
      if (ts != null) turn.lastAt = ts;
      if (m.role === 'tool') turn.toolCalls += 1;
      else if (m.role === 'assistant' && !m.hasToolCalls) close(m.finishReason || 'incomplete', turn.lastAt);
    }
    if (turn && now - turn.lastAt < ACTIVE_TURN_MS) active.push(turn);
  }
  return { turns, active };
}

const MESSAGES_SQL = `SELECT id, session_id AS sessionId, role, timestamp, finish_reason AS finishReason,
  (tool_calls IS NOT NULL AND tool_calls NOT IN ('', '[]', 'null')) AS hasToolCalls
  FROM messages WHERE COALESCE(active, 1) = 1 ORDER BY id DESC LIMIT ${MESSAGES_LIMIT}`;

function sessionsSql(count) {
  return `SELECT id, model, started_at AS startedAt, input_tokens AS inputTokens,
    output_tokens AS outputTokens, api_call_count AS apiCalls
    FROM sessions WHERE ended_at IS NULL${count ? ` OR id IN (${Array(count).fill('?').join(', ')})` : ''}`;
}

function delta(cur, base, field) {
  const d = num(cur?.[field]) != null && num(base?.[field]) != null ? cur[field] - base[field] : null;
  return d != null && d >= 0 ? d : null;
}

export class HermesProvider {
  constructor(host, headers, dbPath) {
    this.host = host;
    this.headers = headers;
    this.dbPath = dbPath;
    this.label = 'Hermes Agent';
    this.monitorStartedAt = Date.now();
    this.countedRuns = new Set();
    this.requestCountTotal = 0;
    this.db = null;
    this.prevSnapshot = null;
    this.turnBaselines = new Map();
    this.turnResults = new Map();
    this.turnCountTotal = 0;
  }

  async openDb() {
    if (this.db) return this.db;
    const { DatabaseSync } = await import('node:sqlite');
    this.db = new DatabaseSync(this.dbPath, { readOnly: true });
    return this.db;
  }

  async readTurns() {
    const db = await this.openDb();
    const now = Date.now();
    let rows;
    let sessionRows;
    try {
      rows = db.prepare(MESSAGES_SQL).all().reverse();
      const ids = [...new Set(rows.map((r) => r.sessionId))];
      sessionRows = db.prepare(sessionsSql(ids.length)).all(...ids);
    } catch (error) {
      try { db.close(); } catch {}
      this.db = null;
      throw error;
    }
    const sessions = new Map(sessionRows.map((s) => [s.id, s]));
    const { turns, active } = parseHermesTurns(rows, now);

    const prev = this.prevSnapshot;
    for (const t of [...turns, ...active]) {
      if (this.turnBaselines.has(t.key)) continue;
      let base = null;
      if (prev && prev.at <= t.startedAt) {
        base = prev.sessions.get(t.sessionId) ?? null;
        const s = sessions.get(t.sessionId);
        if (!base && epochMs(s?.startedAt) >= prev.at) base = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
      }
      this.turnBaselines.set(t.key, base);
    }

    const fresh = turns.filter((t) => !this.turnResults.has(t.key));
    const freshPerSession = new Map();
    for (const t of fresh) freshPerSession.set(t.sessionId, (freshPerSession.get(t.sessionId) ?? 0) + 1);
    for (const t of fresh) {
      const base = this.turnBaselines.get(t.key);
      const cur = sessions.get(t.sessionId);
      const usable = base && cur && freshPerSession.get(t.sessionId) === 1;
      this.turnResults.set(
        t.key,
        usable
          ? {
              inputTokens: delta(cur, base, 'inputTokens'),
              outputTokens: delta(cur, base, 'outputTokens'),
              apiCalls: delta(cur, base, 'apiCalls'),
            }
          : null
      );
      if (t.endedAt >= this.monitorStartedAt) this.turnCountTotal += 1;
    }

    const visible = new Set([...turns, ...active].map((t) => t.key));
    for (const map of [this.turnBaselines, this.turnResults]) {
      for (const key of map.keys()) if (!visible.has(key)) map.delete(key);
    }
    this.prevSnapshot = { at: now, sessions };

    const last = turns.reduce((a, t) => (!a || t.endedAt > a.endedAt ? t : a), null);
    const usage = last ? this.turnResults.get(last.key) : null;
    return {
      source: 'state.db',
      busy: active.length > 0,
      running: active.length,
      activeElapsedMs: active.length ? Math.max(...active.map((t) => now - t.startedAt)) : null,
      completed: this.turnCountTotal,
      lastRequest: last
        ? {
            model: sessions.get(last.sessionId)?.model ?? null,
            runtimeMs: last.runtimeMs,
            promptTokens: usage?.inputTokens ?? null,
            genTokens: usage?.outputTokens ?? null,
            apiCalls: usage?.apiCalls ?? null,
            toolCalls: last.toolCalls,
            outcome: last.outcome,
            endedAt: last.endedAt,
            prefillRate: null,
            decodeRate: null,
          }
        : null,
    };
  }

  async poll() {
    const health = await fetchText(`${this.host}/health`, 3000, this.headers);
    if (!health.ok) return { ok: false, error: health.error, models: [] };
    const parsed = parseHermesHealth(health.text);
    if (!parsed) return { ok: false, error: 'bad JSON from /health', models: [] };

    let turnView = null;
    let dbError = null;
    if (this.dbPath) {
      try {
        turnView = await this.readTurns();
      } catch (error) {
        dbError = error?.message || String(error);
      }
    }

    const [detailedRes, sessionsRes] = await Promise.all([
      fetchText(`${this.host}/health/detailed`, 3000, this.headers),
      turnView
        ? null
        : fetchText(`${this.host}/api/sessions?limit=${SESSIONS_LIMIT}`, 3000, this.headers),
    ]);

    if (turnView) {
      const detailed = detailedRes.ok ? parseHermesDetailed(detailedRes.text) : null;
      const requests = { ...turnView };
      if (detailed?.activeRuns != null && detailed.activeRuns > requests.running) {
        requests.busy = true;
        requests.running = detailed.activeRuns;
      }
      return {
        ok: true,
        models: [],
        requestCountTotal: this.turnCountTotal,
        lastRequest: requests.lastRequest,
        gateway: {
          kind: 'hermes',
          ready: parsed.status ? HEALTHY.has(parsed.status.toLowerCase()) : true,
          failing: detailed?.failing ?? [],
          health: parsed.status,
          detailed,
          detailedError: detailedRes.ok
            ? detailed
              ? null
              : 'unreadable /health/detailed output'
            : detailedRes.error,
          requests,
          requestsError: null,
        },
      };
    }

    let detailed = null;
    let detailedError = null;
    if (detailedRes.ok) {
      detailed = parseHermesDetailed(detailedRes.text);
      if (!detailed) detailedError = 'unreadable /health/detailed output';
    } else {
      detailedError = detailedRes.error;
    }

    let sessions = null;
    let requestsError = null;
    if (sessionsRes.ok) {
      sessions = parseHermesSessions(sessionsRes.text);
      if (!sessions) requestsError = 'unreadable /api/sessions output';
    } else {
      requestsError = sessionsRes.error;
    }
    if (dbError) requestsError = `state.db ${dbError}${requestsError ? `; /api/sessions ${requestsError}` : ''}`;

    if (sessions) {
      for (const s of sessions) {
        if (s.active || !s.runId || s.endedAt == null || s.endedAt < this.monitorStartedAt) continue;
        if (this.countedRuns.has(s.runId)) continue;
        this.countedRuns.add(s.runId);
        this.requestCountTotal += 1;
      }
    }

    let requests = null;
    if (sessions) {
      requests = { ...summarizeOpenClawRequests(sessions), completed: this.requestCountTotal };
      if (requests.lastRequest) requests.lastRequest = { ...requests.lastRequest, decodeRate: null };
      if (detailed?.activeRuns != null) {
        requests.busy = detailed.activeRuns > 0;
        requests.running = detailed.activeRuns;
        requests.activeElapsedMs = null;
      }
    } else if (detailed?.activeRuns != null) {
      requests = {
        busy: detailed.activeRuns > 0,
        running: detailed.activeRuns,
        activeElapsedMs: null,
        lastRequest: null,
        completed: null,
      };
    }

    return {
      ok: true,
      models: [],
      requestCountTotal: sessions ? this.requestCountTotal : null,
      lastRequest: requests?.lastRequest ?? null,
      gateway: {
        kind: 'hermes',
        ready: parsed.status ? HEALTHY.has(parsed.status.toLowerCase()) : true,
        failing: detailed?.failing ?? [],
        health: parsed.status,
        detailed,
        detailedError,
        requests,
        requestsError,
      },
    };
  }
}
