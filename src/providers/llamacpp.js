import { fetchText, parsePrometheus } from '../http.js';

// ---- llama.cpp provider -----------------------------------------------
// llama-server exposes a genuine Prometheus endpoint — the thing Ollama lacks —
// so nothing here parses a log. It is off unless the server was started with
// --metrics, which is why /props is polled too: it reports endpoint_metrics,
// turning an empty throughput panel into a diagnosis. Metric names verified
// against to_metrics() in tools/server/server-task.cpp at build b10453.
//
// The throughput gauges cannot carry a live reading, which is the one thing that
// shapes this provider. llama.cpp commits prompt/predict timings only when a
// request *finishes*, and the gauge is steps/accumulated-decode-time over a
// bucket that reset_bucket() empties on every /metrics read — returning 0 while
// time == 0. Both were measured: through a 900-token generation
// tokens_predicted_total stayed frozen and the gauge read 0 on every poll, so
// differencing the counter would not help either. Worse, whichever client reads
// /metrics first drains the bucket, so a browser on the built-in web UI or a
// second monitor silently steals the reading.
//
// So decode rate is differenced from /slots instead, where n_decoded does climb
// live, and the gauge is used only when nothing is in flight — where it reports
// the last completed request. Prefill has no live equivalent (it lands in one
// batch), and reads 0 during decode, which is the truth: nothing is prefilling.
//
// Separately, llamacpp:prompt_tokens_total counts only tokens actually
// evaluated, so prefix reuse is cached/(cached + evaluated) rather than a
// hits/queries ratio.
//
// There is no KV-usage metric, so occupancy is read from /slots (enabled by
// default): every slot reports its own n_ctx and what it currently holds.
// Model bytes, parameter count, quant and context come from /v1/models, whose
// meta block carries size, n_params, ftype and n_ctx.
//
// VRAM residency is not exposed over HTTP at all. With -ngl below full offload
// the CPU spill is invisible here, so placement is left unreported rather than
// guessed, and the nvidia-smi VRAM gauge above is the signal to read instead.
export class LlamaCppProvider {
  constructor(host) {
    this.host = host;
    this.label = 'llama.cpp';
    // Previous /slots sample, for differencing n_decoded into a live rate.
    this.prev = null; // { t, slots: Map(slotId -> { task, decoded }) }
    this.reqTrack = { baselined: false, slots: new Map(), count: 0, last: null };
  }

  // Reconstruct per-request stats from /slots, tracked per slot and keyed on
  // id_task: llama.cpp only commits timings at request end and /metrics may be
  // off, so we watch each task while it runs and finalize when it stops.
  // Baseline rule: tasks already idle or running on the first poll are
  // pre-existing, not new requests, so they are recorded but not counted.
  // Known limits: n_prompt_tokens may include cached tokens, and multiple
  // requests on the same slot within one poll interval collapse to the latest.
  // Slots absent from a sample are dropped uncounted. If /slots failed for longer
  // than MAX_GAP_MS, runtime ends at the last sample seen, not at "now".
  trackRequests(slots, now, model) {
    const rt = this.reqTrack;
    const MAX_GAP_MS = 10000; // several default poll intervals
    const finite = (v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      return null;
    };
    const finish = (tr, decoded, nPrompt) => {
      tr.finished = true;
      if (tr.baseline) return;
      // An idle slot may hold a stale or reset count, so only trust it if it
      // has not gone backwards.
      const genTokens = decoded != null && (tr.lastDecoded == null || decoded >= tr.lastDecoded) ? decoded : tr.lastDecoded;
      let decodeRate = null;
      if (tr.firstDecodedAt != null && tr.firstDecoded != null && tr.lastDecoded != null) {
        const dt = (tr.lastDecodedAt - tr.firstDecodedAt) / 1000;
        const delta = tr.lastDecoded - tr.firstDecoded;
        // A zero window or no observed decode progress gives no honest rate, so null.
        if (dt > 0 && delta > 0) decodeRate = delta / dt;
      }
      let runtimeMs = null;
      if (tr.firstSeen != null) {
        const end = tr.lastSeen != null && now - tr.lastSeen > MAX_GAP_MS ? tr.lastSeen : now;
        runtimeMs = end - tr.firstSeen;
      }
      rt.count += 1;
      rt.last = {
        model: tr.model ?? model ?? null,
        runtimeMs,
        promptTokens: nPrompt ?? tr.nPrompt ?? null,
        genTokens: genTokens ?? null,
        outcome: 'done',
        endedAt: now,
        prefillRate: null,
        decodeRate,
      };
    };
    const seen = new Set();
    for (const [index, s] of slots.entries()) {
      const id = String(s.id ?? index);
      seen.add(id);
      const rawTask = s.id_task;
      const task = rawTask == null || Number(rawTask) < 0 ? null : String(rawTask);
      const decoded = finite(s.next_token?.[0]?.n_decoded);
      const nPrompt = finite(s.n_prompt_tokens);
      let tr = rt.slots.get(id);
      if (task == null) {
        // Idle slot with no task id: finish a tracked request from what the
        // slot still reports.
        if (tr && !tr.finished && !s.is_processing) finish(tr, decoded, nPrompt);
        continue;
      }
      if (tr && tr.task !== task) {
        if (!tr.finished) finish(tr, null, null);
        rt.slots.delete(id);
        tr = null;
      }
      if (s.is_processing) {
        // A finished tracker with the same task id means the id was reused
        // (e.g. server restart), so it is a new request.
        if (!tr || tr.finished) {
          tr = { task, firstSeen: now, firstDecoded: null, finished: false, model, baseline: !rt.baselined };
          rt.slots.set(id, tr);
        }
        tr.lastSeen = now;
        if (decoded != null) {
          tr.lastDecoded = decoded;
          tr.lastDecodedAt = now;
          // Decode window starts at the first sample with output, excluding prefill.
          if (tr.firstDecoded == null && decoded > 0) {
            tr.firstDecoded = decoded;
            tr.firstDecodedAt = now;
          }
        }
        if (nPrompt != null) tr.nPrompt = nPrompt;
      } else if (tr) {
        if (!tr.finished) finish(tr, decoded, nPrompt);
      } else {
        // New id_task seen only while idle: the request finished between polls.
        // Count it with the retained token counts; timing is unknown (null).
        tr = { task, firstSeen: null, finished: true, nPrompt };
        rt.slots.set(id, tr);
        if (rt.baselined) {
          rt.count += 1;
          rt.last = {
            model: model ?? null,
            runtimeMs: null,
            promptTokens: nPrompt,
            genTokens: decoded,
            outcome: 'done',
            endedAt: now,
            prefillRate: null,
            decodeRate: null,
          };
        }
      }
    }
    for (const id of [...rt.slots.keys()]) if (!seen.has(id)) rt.slots.delete(id);
    rt.baselined = true;
  }

  // Tokens decoded since the previous poll, over wall-clock. Only slots that are
  // still processing count: an idle slot keeps its finished task's n_decoded, so
  // reading it would replay tokens that already happened. A slot that has moved
  // on to a new task restarts its count, so deltas are taken within one task
  // only — the tail of the request it just finished is what the gauge reports.
  liveDecodeRate(slots, now) {
    const cur = new Map();
    for (const s of slots) {
      if (!s.is_processing) continue;
      const decoded = Number(s.next_token?.[0]?.n_decoded);
      if (!Number.isFinite(decoded)) continue;
      cur.set(String(s.id), { task: String(s.id_task ?? ''), decoded });
    }
    let rate = null;
    if (this.prev && cur.size) {
      const dt = (now - this.prev.t) / 1000;
      if (dt > 0) {
        let delta = 0;
        for (const [id, c] of cur) {
          const p = this.prev.slots.get(id);
          if (p && p.task === c.task && c.decoded > p.decoded) delta += c.decoded - p.decoded;
        }
        if (delta > 0) rate = delta / dt;
      }
    }
    // Always advance, so an idle gap cannot later look like one huge delta.
    this.prev = { t: now, slots: cur };
    return rate;
  }

  // n_params is a raw count, but the model panels elsewhere show "8.2B"-style
  // sizes, so match them.
  paramSize(n) {
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return Math.round(n / 1e6) + 'M';
    return String(n);
  }

  // Each slot owns an independent n_ctx window and n_prompt_tokens is what it
  // holds right now, so summing across slots gives the occupancy of the whole
  // KV pool — the closest analogue to vLLM's kv_cache_usage_perc. Tokens stay
  // resident after a request finishes, so this reads non-zero on an idle server
  // that has served anything: that is the prefix cache, not a leak.
  kvFromSlots(slots) {
    let used = 0;
    let total = 0;
    for (const s of slots) {
      const ctx = Number(s.n_ctx);
      const held = Number(s.n_prompt_tokens);
      if (Number.isFinite(ctx) && ctx > 0) total += ctx;
      if (Number.isFinite(held) && held > 0) used += held;
    }
    return total > 0 ? { used, total, pct: (used / total) * 100 } : null;
  }

  async poll() {
    const [propsRes, modelsRes, slotsRes, metricsRes] = await Promise.all([
      fetchText(`${this.host}/props`),
      fetchText(`${this.host}/v1/models`),
      fetchText(`${this.host}/slots`),
      fetchText(`${this.host}/metrics`),
    ]);

    // /props answers even while the model is sleeping and needs no API key, so
    // it decides reachability. A failing /metrics usually means only that
    // --metrics was omitted, which is not the server being down.
    const result = { ok: propsRes.ok, error: propsRes.error, models: [] };
    if (!propsRes.ok) return result;

    let props = null;
    try {
      props = JSON.parse(propsRes.text);
    } catch {
      return { ...result, ok: false, error: 'bad JSON from /props' };
    }

    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

    // Model identity and geometry. Fall back to /props when /v1/models is
    // unavailable: it carries the alias, ftype and context but not the bytes.
    let meta = null;
    let modelId = props.model_alias || null;
    if (modelsRes.ok) {
      try {
        const data = JSON.parse(modelsRes.text);
        const info = Array.isArray(data.data) ? data.data[0] : null;
        if (info) {
          modelId = info.id || modelId;
          meta = info.meta || null;
        }
      } catch {}
    }
    result.loaded = modelId
      ? [
          {
            id: modelId,
            size: meta ? num(meta.size) : null,
            context: (meta ? num(meta.n_ctx) : null) ?? num(props.default_generation_settings?.n_ctx),
            contextTrain: meta ? num(meta.n_ctx_train) : null,
            params: this.paramSize(meta ? num(meta.n_params) : null),
            quant: (meta && meta.ftype) || props.model_ftype || null,
          },
        ]
      : [];
    result.models = result.loaded.map((m) => ({ id: m.id }));

    let liveDecode = null;
    if (slotsRes.ok) {
      try {
        const arr = JSON.parse(slotsRes.text);
        if (Array.isArray(arr)) {
          const slots = arr.filter((s) => s && typeof s === 'object');
          result.slots = { busy: slots.filter((s) => s.is_processing).length, total: slots.length };
          result.kv = this.kvFromSlots(slots);
          const polledAt = Date.now();
          liveDecode = this.liveDecodeRate(slots, polledAt);
          this.trackRequests(slots, polledAt, modelId);
        }
      } catch {}
    }

    // Only reported when metrics are unavailable (disabled or /metrics failing),
    // so the metrics-on display is unchanged. The count is since monitor start.
    // lastRequest persists across polls so the last finished request stays visible.
    if (this.reqTrack.baselined && (props.endpoint_metrics === false || !metricsRes.ok)) {
      result.requestCountTotal = this.reqTrack.count;
      result.requestCountSince = 'monitor start';
      if (this.reqTrack.last) result.lastRequest = this.reqTrack.last;
    }

    if (props.endpoint_metrics === false) {
      result.metricsDisabled = true;
    } else if (!metricsRes.ok) {
      result.metricsError = metricsRes.error;
    } else {
      const m = parsePrometheus(metricsRes.text);
      result.promptRate = m.get('llamacpp:prompt_tokens_seconds');
      result.decodeRate = m.get('llamacpp:predicted_tokens_seconds');
      result.running = m.get('llamacpp:requests_processing');
      result.waiting = m.get('llamacpp:requests_deferred');
      result.promptTotal = m.get('llamacpp:prompt_tokens_total');
      result.genTotal = m.get('llamacpp:tokens_predicted_total');
      result.peakTokens = m.get('llamacpp:n_tokens_max');
      // prompt_tokens_total excludes cached tokens, so the two counters sum to
      // every prompt token the server has been asked to handle.
      const cached = m.get('llamacpp:prompt_tokens_cached_total');
      if (cached != null && result.promptTotal != null) {
        const seen = cached + result.promptTotal;
        if (seen > 0) {
          result.cacheHit = {
            cached,
            prompt: seen,
            pct: (cached / seen) * 100,
            scope: 'of all prompt tokens',
          };
        }
      }
    }

    // A request in flight has no committed gauge, so the differenced /slots rate
    // is the only real reading; it also wins over a gauge left behind by an
    // earlier request, which would otherwise be reported as if it were current.
    if (liveDecode != null) {
      result.decodeRate = liveDecode;
      result.rateLive = true;
    }

    // --no-slots leaves no per-slot data, but /props still knows the slot count
    // and /metrics the busy count, which is enough for the occupancy bar.
    if (!result.slots && props.total_slots != null && result.running != null) {
      result.slots = { busy: result.running, total: num(props.total_slots) };
    }
    return result;
  }
}
