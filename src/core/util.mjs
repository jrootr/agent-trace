// Small helpers shared by the adapters, the analysis code, and the viewer.
// Everything under src/ runs in both Node and the browser: no Node built-ins here.

/** Deterministic hex hash (FNV-1a, run with several seeds and concatenated). */
export function hashHex(input, length = 16) {
  const str = String(input);
  let out = '';
  for (let seed = 0; out.length < length; seed++) {
    let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

export function truncateText(value, max) {
  if (value == null) return value;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… [${(s.length - max).toLocaleString('en-US')} more characters truncated]`;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function parseTime(value) {
  if (typeof value === 'number') return value;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Text from an Anthropic-style content value: a string, or an array of blocks. */
export function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Text between the first `open` marker and the next `close` marker, or null.
 * Plain indexOf scanning: linear time on any input (no regex backtracking).
 */
export function textBetween(text, open, close) {
  const s = String(text ?? '');
  const a = s.indexOf(open);
  if (a < 0) return null;
  const b = s.indexOf(close, a + open.length);
  return b < 0 ? null : s.slice(a + open.length, b);
}

/** Remove every `open`…`close` section (markers included). Unclosed sections are left as is. */
export function removeSections(text, open, close) {
  let s = String(text ?? '');
  let from = 0;
  for (;;) {
    const a = s.indexOf(open, from);
    if (a < 0) return s;
    const b = s.indexOf(close, a + open.length);
    if (b < 0) return s;
    s = s.slice(0, a) + s.slice(b + close.length);
    from = a;
  }
}
