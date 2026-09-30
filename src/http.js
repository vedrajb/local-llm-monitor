// ---- shared HTTP helper ----------------------------------------------
export async function fetchText(url, timeoutMs = 3000, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  }
}

// ---- vLLM provider ----------------------------------------------------
// Minimal Prometheus parser: returns a map of metricName -> summed value
// across labels. Good enough for a single-model server (one label set per
// metric).
export function parsePrometheus(text) {
  const m = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line[0] === '#') continue;
    // name{labels} value   OR   name value
    const sp = line.lastIndexOf(' ');
    if (sp < 0) continue;
    const rawName = line.slice(0, sp);
    const val = parseFloat(line.slice(sp + 1));
    if (Number.isNaN(val)) continue;
    const brace = rawName.indexOf('{');
    const name = brace >= 0 ? rawName.slice(0, brace) : rawName;
    m.set(name, (m.get(name) || 0) + val);
  }
  return m;
}
