// Content hygiene applied before anything is written to disk:
//   <private>...</private> blocks are dropped entirely,
//   recognizable secrets are replaced with [REDACTED:<kind>].

const PRIVATE_RE = /<private>[\s\S]*?(<\/private>|$)/gi;

export function stripPrivate(text) {
  if (typeof text !== 'string') return text;
  return text.replace(PRIVATE_RE, '[private content removed]');
}

export function isFullyPrivate(text) {
  if (typeof text !== 'string') return false;
  const rest = text.replace(PRIVATE_RE, '').trim();
  return rest.length === 0 && /<private>/i.test(text);
}

const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer', /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi],
];

// key = value / key: value / "key": "value" assignments for secret-looking keys
const ASSIGNMENT_RE = /(["']?)([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|credential|auth[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(["']?)([^\s"',;}{]{6,})\4/gi;

export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [kind, re] of SECRET_PATTERNS) {
    out = out.replace(re, (m, p1) => {
      if (kind === 'bearer') return `${p1} [REDACTED:token]`;
      if (kind === 'url-credentials') return `${p1}[REDACTED:credentials]@`;
      return `[REDACTED:${kind}]`;
    });
  }
  out = out.replace(ASSIGNMENT_RE, (m, q, key, sep, vq, value) => {
    if (value.startsWith('[REDACTED') || /^(true|false|null|undefined|none|\$\{?[A-Z_]+\}?|process\.env\.\w+)$/i.test(value)) return m;
    return `${q}${key}${q}${sep}${vq}[REDACTED:secret]${vq}`;
  });
  return out;
}

export function truncate(text, max) {
  if (typeof text !== 'string') return text;
  if (!max || text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[${text.length - max} chars truncated]…\n${text.slice(-tail)}`;
}

export function toText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 1);
  } catch {
    return String(value);
  }
}

// Full pipeline for a captured field.
export function clean(value, { maxChars = 4000, redact = true } = {}) {
  let text = stripPrivate(toText(value));
  if (redact) text = redactSecrets(text);
  return truncate(text, maxChars);
}
