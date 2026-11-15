// PII Redact: finds personal data in a draft and returns it as typed spans,
// for a composer UI to highlight and redact. This revision is the engine
// only; the composer UI follows with the host's send hook (README.md,
// "Composer hook").
//
// Emails, phones, keys and IPs are regular expressions, here in the plugin.
// Names and places come from spaCy's small English model, in the manifest's
// one `processes` entry under macOS `sandbox-exec` from `(deny default)`: no
// network, no IPC, no programs but its Python, and no reads under /Users
// except its own venv (README.md, "What it can reach"). The process is started once and kept warm, and takes one
// JSON line per draft on stdin.

export const inject = [];

// The process's exit codes when its venv or the model is missing.
export const NO_VENV = 3;
export const NO_MODEL = 4;
// Generous for the first draft, which waits for the model to load.
const DETECT_MS = 10_000;
// Longer drafts are checked up to here; the rest is left to the regexes.
const NER_CHARS = 20_000;
// spaCy labels kept, and what they become.
const NER_TYPES = { PERSON: "name", GPE: "place", LOC: "place", FAC: "place" };
// On overlap, the earlier and then longer span wins; then this order.
const PRIORITY = ["key", "email", "ip", "phone", "name", "place"];

const PATTERNS = [
  {
    type: "key",
    pattern: new RegExp(
      [
        String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
        String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})`,
        String.raw`\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`,
        String.raw`\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}`,
        String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`,
        String.raw`\bglpat-[A-Za-z0-9_-]{20,}`,
        String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
        String.raw`\bAIza[0-9A-Za-z_-]{35}`,
        String.raw`\bnsec1[02-9ac-hj-np-z]{58}\b`,
        String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
      ].join("|"),
      "g",
    ),
  },
  // `token: …`, `password=…` and the like: only the value is the key.
  {
    type: "key",
    pattern: /\b(?:api[_-]?key|access[_-]?key|secret|token|passw(?:or)?d|pwd)["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    group: 1,
  },
  {
    type: "email",
    pattern: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g,
  },
  {
    type: "ip",
    pattern: /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\/(?:3[0-2]|[12]?\d))?(?![\w.])/g,
  },
  // Candidates only; the URL parser decides what is really IPv6.
  {
    type: "ip",
    pattern: /(?<![\w:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:])/g,
    valid: (text) => /[0-9A-Fa-f]/.test(text) && URL.canParse(`http://[${text}]/`),
  },
  // 10 to 15 digits, or 8 and up after a `+` country code. Dates, times and
  // version numbers stay under that.
  {
    type: "phone",
    pattern: /(?<![\w+.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,5}(?:[\s.-]?\d{2,5}){1,4}(?![\w.-])/g,
    valid: (text) => {
      const digits = text.replace(/\D/g, "").length;
      return digits <= 15 && digits >= (text.startsWith("+") ? 8 : 10);
    },
  },
];

// The regex recognizers. Spans use the string's own (UTF-16) offsets, which
// is what the composer's selections use too.
export function findPatterns(text) {
  const spans = [];
  for (const { type, pattern, group, valid } of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[group ?? 0];
      if (!value || (valid && !valid(value))) continue;
      const start = match.index + (group ? match[0].lastIndexOf(value) : 0);
      spans.push({ type, start, end: start + value.length, text: value });
    }
  }
  return resolveOverlaps(spans);
}

// spaCy reports code point offsets; the composer counts UTF-16 units.
export function nerSpans(text, ents) {
  const units = [0];
  for (const char of text) units.push(units[units.length - 1] + char.length);
  const spans = [];
  for (const [from, to, label] of ents) {
    const type = NER_TYPES[label];
    if (!type || !(from >= 0 && to > from && to < units.length)) continue;
    const start = units[from];
    const end = units[to];
    spans.push({ type, start, end, text: text.slice(start, end) });
  }
  return spans;
}

export function resolveOverlaps(spans) {
  const sorted = [...spans].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - a.end ||
      PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type),
  );
  const kept = [];
  for (const span of sorted) {
    if (kept.length && span.start < kept[kept.length - 1].end) continue;
    kept.push(span);
  }
  return kept;
}

// The engine a composer UI holds: `detect(text)` resolves
// `{ spans, error? }`. The regex spans always come back; `error` is
// "noVenv", "noModel" or "failed" when names and places could not be checked.
// `spawn` is `ctx.host.spawn`; call `dispose` from the plugin's `ctx.effect`
// cleanup.
export function createEngine(spawn) {
  let child = null;
  let buffer = "";
  let nextId = 1;
  let setupError = null;
  const pending = new Map();

  function settle(id, value) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    request.resolve(value);
  }

  function onLine(line) {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof reply?.id === "number") settle(reply.id, reply.error ? { error: "failed" } : { ents: reply.ents ?? [] });
  }

  function start() {
    buffer = "";
    const proc = spawn("ner", {
      cwd: "/tmp",
      onStdout: (data) => {
        buffer += data;
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      },
      onStderr: (data) => console.warn("pii-redact:", String(data).slice(-500)),
    });
    child = proc;
    proc.exited.then((code) => {
      if (child === proc) child = null;
      if (code === NO_VENV) setupError = "noVenv";
      if (code === NO_MODEL) setupError = "noModel";
      for (const id of [...pending.keys()]) settle(id, { error: setupError ?? "failed" });
    });
    return proc;
  }

  function entities(text) {
    if (setupError) return Promise.resolve({ error: setupError });
    const proc = child ?? start();
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A wedged model: the next draft starts a fresh process.
        void proc.kill();
        settle(id, { error: "failed" });
      }, DETECT_MS);
      pending.set(id, { resolve, timer });
      Promise.resolve(proc.write(`${JSON.stringify({ id, text })}\n`)).catch(() => settle(id, { error: "failed" }));
    });
  }

  return {
    async detect(text) {
      const patterns = findPatterns(text);
      if (!/\p{L}/u.test(text)) return { spans: patterns };
      const checked = text.slice(0, NER_CHARS);
      const { ents, error } = await entities(checked);
      const spans = resolveOverlaps([...patterns, ...(ents ? nerSpans(checked, ents) : [])]);
      return error ? { spans, error } : { spans };
    },
    // After the owner fixes the setup, try the process again.
    retry() {
      setupError = null;
    },
    dispose() {
      const proc = child;
      child = null;
      for (const id of [...pending.keys()]) settle(id, { error: "failed" });
      if (proc) void proc.kill();
    },
  };
}

// Redaction swaps each span for a placeholder such as `[EMAIL·a3f9]`: the
// type and four random hex digits, unique in this Mac's map, so the sender's
// own Mac can show the value again. Random, not a hash, so a placeholder says
// nothing about the value it stands for. Keys get a placeholder but their
// value is never stored: a secret stays redacted even here.
const MAP_KEY = "pii-redact/placeholders/v1";
// Oldest entries go first past this.
const MAP_LIMIT = 5_000;
export const PLACEHOLDER = /\[(EMAIL|PHONE|KEY|IP|NAME|PLACE)·([0-9a-f]{4})\]/g;

function randomTag() {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The placeholder→value map. It lives in this Mac's Buzz web storage under
// MAP_KEY and is never published or synced (README.md, "The placeholder
// map"). `storage` is `localStorage`; without it the map lasts until Buzz
// quits.
export function createPlaceholderMap(storage = globalThis.localStorage) {
  let entries = new Map();
  try {
    const saved = JSON.parse(storage?.getItem(MAP_KEY) ?? "[]");
    if (Array.isArray(saved)) entries = new Map(saved.filter((e) => Array.isArray(e) && e.length === 3).map(([p, type, value]) => [p, { type, value }]));
  } catch {
    // An unreadable map starts empty.
  }

  function save() {
    try {
      storage?.setItem(MAP_KEY, JSON.stringify([...entries].map(([p, { type, value }]) => [p, type, value])));
    } catch {
      // Full or unavailable storage: the map lasts until Buzz quits.
    }
  }

  return {
    placeholder(type, value) {
      const label = type.toUpperCase();
      if (type !== "key") {
        for (const [p, entry] of entries) if (entry.type === type && entry.value === value) return p;
      }
      let p;
      do p = `[${label}·${randomTag()}]`;
      while (entries.has(p));
      entries.set(p, { type, value: type === "key" ? null : value });
      while (entries.size > MAP_LIMIT) entries.delete(entries.keys().next().value);
      save();
      return p;
    },
    // The stored value, or undefined for a key or a placeholder from elsewhere.
    value(placeholder) {
      return entries.get(placeholder)?.value ?? undefined;
    },
    forget() {
      entries = new Map();
      try {
        storage?.removeItem(MAP_KEY);
      } catch {
        // Nothing stored.
      }
    },
  };
}

// The redacted draft, and each replacement as a range of the original draft
// (for `replaceRange`, applied last to first), in draft order. Spans inside an
// existing placeholder are skipped.
export function redact(text, spans, map) {
  const taken = [...text.matchAll(PLACEHOLDER)].map((m) => [m.index, m.index + m[0].length]);
  const kept = resolveOverlaps(spans).filter(({ start, end }) => !taken.some(([s, e]) => start < e && end > s));
  let out = "";
  let at = 0;
  const replacements = [];
  for (const span of kept) {
    const placeholder = map.placeholder(span.type, span.text);
    out += text.slice(at, span.start);
    replacements.push({ type: span.type, start: span.start, end: span.end, placeholder });
    out += placeholder;
    at = span.end;
  }
  return { text: out + text.slice(at), replacements };
}

// The text with every placeholder this Mac knows put back; the rest stay.
export function unredact(text, map) {
  return text.replace(PLACEHOLDER, (placeholder) => map.value(placeholder) ?? placeholder);
}

// Nothing to register until the composer UI lands.
export function apply() {}
