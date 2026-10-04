// Best-effort secret scrubbing before anything is written into a report or exported.

export const REDACTED_MARK = '[REDACTED]';

const SECRET_WORDS = new Set([
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'credential', 'credentials',
  'cookie', 'cookies', 'authorization', 'bearer', 'privatekey', 'otp',
]);
const SECRET_KEY_RE = /api[-_]?key|private[-_]?key|access[-_]?key|client[-_]?secret|session[-_]?token/i;
const SECRET_VALUE_RES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi,
];

export function isSecretKeyName(key) {
  if (!key) return false;
  if (SECRET_KEY_RE.test(key)) return true;
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some((w) => SECRET_WORDS.has(w));
}

const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';
const PEM_DASHES = '-----';

/** Replace PEM private key blocks (BEGIN … END). Linear indexOf scan; an unterminated block is redacted to the end. */
function redactPrivateKeys(s) {
  let out = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf(PEM_BEGIN, i);
    if (a < 0) return out + s.slice(i);
    const labelEnd = s.indexOf(PEM_DASHES, a + PEM_BEGIN.length);
    const label = labelEnd < 0 ? '' : s.slice(a + PEM_BEGIN.length, labelEnd);
    if (!label.endsWith('PRIVATE KEY') || label.length > 40) {
      out += s.slice(i, a + PEM_BEGIN.length);
      i = a + PEM_BEGIN.length;
      continue;
    }
    const endMarker = s.indexOf(PEM_END, labelEnd);
    const close = endMarker < 0 ? -1 : s.indexOf(PEM_DASHES, endMarker + PEM_END.length);
    out += s.slice(i, a) + REDACTED_MARK;
    if (close < 0) return out;
    i = close + PEM_DASHES.length;
  }
}

export function redactString(s) {
  let out = redactPrivateKeys(s);
  for (const re of SECRET_VALUE_RES) out = out.replace(re, REDACTED_MARK);
  return out;
}

export function redactValue(value, key) {
  if (key && isSecretKeyName(key) && value != null && value !== '' && typeof value !== 'boolean') return REDACTED_MARK;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k);
    return out;
  }
  return value;
}
