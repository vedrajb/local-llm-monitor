// Terminal UI for the Local LLM Monitor.
// Zero dependencies: plain ANSI escapes, no alternate-screen buffer and no raw
// input, so it degrades cleanly wherever the plain renderer already worked.
// Every glyph used here is single-width, so stripping ANSI is enough to compute
// visible width — no string-width dependency needed.

const NO_COLOR = 'NO_COLOR' in process.env || process.env.TERM === 'dumb';

function fg(r, g, b) {
  return NO_COLOR ? '' : `\x1b[38;2;${r};${g};${b}m`;
}
const RESET = NO_COLOR ? '' : '\x1b[0m';
const BOLD = NO_COLOR ? '' : '\x1b[1m';
const OK = fg(80, 200, 120);
const WARN = fg(230, 180, 60);
const BAD = fg(220, 90, 90);
const ACC = fg(110, 170, 240);
const MUTE = fg(130, 130, 140);

// A box renders as w+1 cells (two corners plus w-1 dashes), and a line that
// exactly fills the terminal wraps, so reserve two columns. Clamped so a very
// narrow window still produces a readable frame and a very wide one does not
// stretch the gauges across the whole screen.
function termWidth() {
  const cols = process.stdout.columns || 80;
  return Math.min(cols - 2, 120);
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const visible = (s) => strip(s).length;

// Truncate on visible width, keeping any ANSI already emitted intact.
function fit(s, n) {
  if (visible(s) <= n) return s;
  let out = '';
  let seen = 0;
  const re = /(\x1b\[[0-9;]*m)|([\s\S])/g;
  let m;
  while ((m = re.exec(s)) && seen < n) {
    if (m[1]) out += m[1];
    else {
      out += m[2];
      seen += 1;
    }
  }
  return out + RESET;
}

const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SPARKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// Bar with sub-cell precision: full blocks plus a partial block for the
// remainder, so slow-moving values still show movement.
function gauge(frac, w, color) {
  const f = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0));
  const exact = f * w;
  let full = Math.floor(exact);
  let rem = Math.round((exact - full) * 8);
  // Rounding up to a whole cell must promote to a full block, not overflow the
  // partial-block table.
  if (rem === 8) {
    full += 1;
    rem = 0;
  }
  const head = rem && full < w ? BLOCKS[rem] : '';
  const filled = '█'.repeat(full) + head;
  const pad = '·'.repeat(Math.max(0, w - full - (head ? 1 : 0)));
  return `${color}${filled}${RESET}${MUTE}${pad}${RESET}`;
}

function spark(vals, max) {
  if (!vals || !vals.length) return '';
  const top = max || Math.max(...vals, 1);
  return vals
    .map((v) => SPARKS[Math.max(0, Math.min(7, Math.floor(((v || 0) / top) * 7.99)))])
    .join('');
}

function sevColor(p) {
  if (p == null || Number.isNaN(p)) return MUTE;
  return p >= 90 ? BAD : p >= 70 ? WARN : OK;
}

function box(title, lines, accent) {
  const w = termWidth();
  // A long title would push the top border past the bottom one, so clip it to
  // whatever room is left after the corners.
  const t = fit(title, Math.max(0, w - 5));
  const head = `${accent}┌─${RESET}${BOLD} ${t} ${RESET}${accent}`;
  // Bottom border is "└" + (w-1) dashes + "┘" = w+1 cells; match it exactly.
  const dashes = Math.max(0, w - visible(head));
  const out = [`${head}${'─'.repeat(dashes)}┐${RESET}`];
  for (const l of lines) out.push(`${accent}│${RESET} ${fit(l, w - 2)}`);
  out.push(`${accent}└${'─'.repeat(w - 1)}┘${RESET}`);
  return out;
}

// Right-pad on visible width so columns line up despite colour codes.
function col(s, n) {
  return s + ' '.repeat(Math.max(0, n - visible(s)));
}

export function renderTui(provider, gpus, v, history, opts = {}) {
  const { gb, pct, rate, interval } = opts;
  const L = [];
  const dot = v.ok ? `${OK}●${RESET}` : `${BAD}●${RESET}`;

  L.push('');
  L.push(
    fit(
      `  ${BOLD}Local LLM Monitor${RESET}  ${MUTE}${provider.label} · ${provider.host}${RESET}` +
        `  ${dot} ${MUTE}${new Date().toLocaleTimeString()}${interval ? ` · ${interval / 1000}s` : ''}${RESET}`,
      termWidth()
    )
  );
  L.push('');

  // ---- GPU ----
  if (!gpus) {
    L.push(...box('GPU', [`${MUTE}nvidia-smi not available${RESET}`], MUTE));
  } else {
    for (const g of gpus) {
      const bars = 22;
      const vramPct = g.memTotal ? (g.memUsed / g.memTotal) * 100 : null;
      const lines = [
        `${col('util', 7)}${gauge(g.gpuUtil / 100, bars, sevColor(g.gpuUtil))} ${BOLD}${col(pct(g.gpuUtil), 5)}${RESET}` +
          (history.gpuUtil && history.gpuUtil.length > 1
            ? `  ${MUTE}trend${RESET} ${ACC}${spark(history.gpuUtil, 100)}${RESET}`
            : ''),
        `${col('memBW', 7)}${gauge(g.memUtil / 100, bars, sevColor(g.memUtil))} ${BOLD}${col(pct(g.memUtil), 5)}${RESET}`,
        `${col('VRAM', 7)}${gauge(vramPct / 100, bars, sevColor(vramPct))} ${BOLD}${gb(g.memUsed)}${RESET}${MUTE}/${gb(g.memTotal)}${RESET}`,
        [
          g.temp != null ? `${MUTE}temp${RESET} ${sevColor(g.temp)}${g.temp}°C${RESET}` : null,
          g.power != null ? `${MUTE}power${RESET} ${BOLD}${Math.round(g.power)}W${RESET}` : null,
        ]
          .filter(Boolean)
          .join('   '),
      ].filter((l) => visible(l) > 0);
      L.push(...box(`GPU${g.index}  ${g.name}`, lines, ACC));
    }
  }

  // ---- server ----
  if (!v.ok) {
    L.push(...box(provider.label, [`${BAD}server not reachable${RESET} ${MUTE}(${v.error})${RESET}`], BAD));
    L.push('');
    return L.join('\n');
  }

  // ---- model ----
  if (v.loaded) {
    const lines = [];
    if (!v.loaded.length) lines.push(`${MUTE}no model loaded${RESET}`);
    for (const m of v.loaded) {
      lines.push(
        `${BOLD}${m.id}${RESET}` +
          (m.params ? `  ${MUTE}${m.params}${m.quant ? ` ${m.quant}` : ''}${RESET}` : '') +
          `  ${gb(m.size)} ${MUTE}loaded (${gb(m.vram)} VRAM)${RESET}`
      );
      const gpuResident = m.placement === '100% GPU';
      lines.push(
        `${MUTE}placement${RESET} ${gpuResident ? OK : WARN}${m.placement ?? '—'}${RESET}` +
          (m.context != null ? `   ${MUTE}context${RESET} ${m.context}` : '') +
          (m.until ? `   ${MUTE}until${RESET} ${m.until}` : '')
      );
    }
    L.push(...box('Model', lines, OK));
  } else if (v.models.length) {
    L.push(
      ...box(
        'Model',
        v.models.map(
          (m) =>
            `${BOLD}${m.id}${RESET}${m.root && m.root !== m.id ? `  ${MUTE}(${m.root})${RESET}` : ''}`
        ),
        OK
      )
    );
  }

  // ---- runtime + throughput ----
  const bars = 16;
  if (v.loaded) {
    const rt = [];
    if (v.slots) {
      const frac = v.slots.total ? v.slots.busy / v.slots.total : 0;
      rt.push(
        `${col('slots', 10)}${gauge(frac, bars, sevColor(frac * 100))} ${BOLD}${v.slots.busy}/${v.slots.total ?? '—'}${RESET} ${MUTE}busy${RESET}`
      );
    }
    if (v.kv) {
      rt.push(
        `${col('KV cache', 10)}${gauge(v.kv.pct / 100, bars, sevColor(v.kv.pct))} ${BOLD}${col(pct(v.kv.pct), 5)}${RESET} ${MUTE}(${v.kv.used}/${v.kv.total} tok)${RESET}`
      );
    }
    if (v.cacheHit) {
      rt.push(
        `${col('reuse', 10)}${gauge(v.cacheHit.pct / 100, bars, OK)} ${BOLD}${col(pct(v.cacheHit.pct), 5)}${RESET} ${MUTE}of last prompt (${v.cacheHit.cached}/${v.cacheHit.prompt} tok)${RESET}`
      );
    }
    if (v.promptCache) {
      const p = v.promptCache;
      rt.push(
        `${col('prompts', 10)}${gauge(p.mib / p.limitMib, bars, OK)} ${BOLD}${p.prompts}${RESET} ${MUTE}cached · ${p.mib.toFixed(0)}/${p.limitMib.toFixed(0)} MiB RAM${RESET}`
      );
    }
    if (rt.length) L.push(...box('Runtime', rt, ACC));

    const tp = [];
    if (v.lastRequest) {
      const r = v.lastRequest;
      tp.push(
        `${MUTE}prefill${RESET} ${BOLD}${rate(r.prefillRate)}${RESET}` +
          (r.promptTokens != null ? ` ${MUTE}(${r.promptTokens} tok)${RESET}` : '') +
          `    ${MUTE}decode${RESET} ${BOLD}${rate(r.decodeRate)}${RESET}` +
          (r.genTokens != null ? ` ${MUTE}(${r.genTokens} tok)${RESET}` : '')
      );
      if (history.decodeRate && history.decodeRate.length > 1) {
        tp.push(`${MUTE}decode trend${RESET} ${ACC}${spark(history.decodeRate)}${RESET}`);
      }
    } else if (v.logMissing) {
      tp.push(`${WARN}throughput unavailable${RESET} ${MUTE}(no server.log at ${v.logMissing})${RESET}`);
    } else {
      tp.push(`${MUTE}no completed request in recent log${RESET}`);
    }
    L.push(...box('Throughput  (last completed request)', tp, WARN));
  } else {
    L.push(
      ...box(
        'Runtime',
        [
          `${col('running', 10)}${BOLD}${v.running ?? '—'}${RESET}   ${MUTE}waiting${RESET} ${BOLD}${v.waiting ?? '—'}${RESET}`,
          `${col('KV cache', 10)}${gauge(v.kvUsage / 100, bars, sevColor(v.kvUsage))} ${BOLD}${pct(v.kvUsage)}${RESET}`,
          `${col('reuse', 10)}${gauge(v.cacheHitRate / 100, bars, OK)} ${BOLD}${pct(v.cacheHitRate)}${RESET} ${MUTE}prefix cache hit${RESET}`,
        ],
        ACC
      )
    );
    const tp = [
      `${MUTE}input${RESET} ${BOLD}${rate(v.promptRate)}${RESET}    ${MUTE}output${RESET} ${BOLD}${rate(v.decodeRate)}${RESET}`,
    ];
    if (history.decodeRate && history.decodeRate.length > 1) {
      tp.push(`${MUTE}output trend${RESET} ${ACC}${spark(history.decodeRate)}${RESET}`);
    }
    L.push(...box('Throughput', tp, WARN));
  }

  L.push('');
  L.push(fit(`  ${MUTE}Ctrl-C to exit${RESET}`, termWidth()));
  L.push('');
  return L.join('\n');
}
