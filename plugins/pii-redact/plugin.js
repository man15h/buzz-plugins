// PII Redact: finds personal data in a draft, underlines it in the composer,
// and swaps it for placeholders before the draft is sent. Its **Redact & send**
// button takes the host Send's place, and Enter runs the same path. On this
// Mac, messages that carry a known placeholder show the real value again
// (README.md, "In Buzz").
//
// Emails, phones, keys and IPs are regular expressions, here in the plugin.
// Names and places come from spaCy's small English model, in the manifest's
// one `processes` entry under macOS `sandbox-exec` from `(deny default)`: no
// network, no IPC, no programs but its Python, and no reads under /Users
// except its own venv (README.md, "What it can reach"). The process is started once and kept warm, and takes one
// JSON line per draft on stdin.

export const inject = ["conversation", "host", "react"];

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

// Redaction swaps each span for a placeholder such as `[EMAIL·a3f9c20e]`:
// the type and eight random hex digits, unique in this Mac's map, so the sender's
// own Mac can show the value again. Random, not a hash, so a placeholder says
// nothing about the value it stands for. Keys get a placeholder but their
// value is never stored: a secret stays redacted even here.
const MAP_KEY = "pii-redact/placeholders/v1";
// Oldest entries go first past this.
const MAP_LIMIT = 5_000;
const PENDING_LIMIT = 500;
export const PLACEHOLDER = /\[(EMAIL|PHONE|KEY|IP|NAME|PLACE)·([0-9a-f]{8})\]/g;

function randomTag() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
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

  // Placeholders offered in the composer but not yet in a draft: in memory
  // only, so a value flagged and then deleted is never stored. Oldest go first
  // past PENDING_LIMIT.
  const pending = new Map();

  function reserve(type, value) {
    if (type !== "key") {
      for (const [p, entry] of entries) if (entry.type === type && entry.value === value) return p;
    }
    for (const [p, entry] of pending) if (entry.type === type && entry.value === value) return p;
    let p;
    do p = `[${type.toUpperCase()}·${randomTag()}]`;
    while (entries.has(p) || pending.has(p));
    pending.set(p, { type, value });
    while (pending.size > PENDING_LIMIT) pending.delete(pending.keys().next().value);
    return p;
  }

  // Store every pending placeholder that `text` now holds.
  function commit(text) {
    let changed = false;
    for (const [p] of String(text).matchAll(PLACEHOLDER)) {
      const entry = pending.get(p);
      if (!entry) continue;
      pending.delete(p);
      entries.set(p, { type: entry.type, value: entry.type === "key" ? null : entry.value });
      changed = true;
    }
    if (!changed) return;
    while (entries.size > MAP_LIMIT) entries.delete(entries.keys().next().value);
    save();
  }

  return {
    // The placeholder for a value, stored at once.
    placeholder(type, value) {
      const p = reserve(type, value);
      commit(p);
      return p;
    },
    // The placeholder a value would get, stored only once `commit` sees it in a
    // draft. Asking again before then gives the same one.
    reserve,
    commit,
    // The stored value, or undefined for a key or a placeholder from elsewhere.
    value(placeholder) {
      return entries.get(placeholder)?.value ?? undefined;
    },
    forget() {
      entries = new Map();
      pending.clear();
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
// Only this Mac's screen changes, so a reply that quotes the owner's
// placeholder shows the owner their own value. Eight random hex digits make a
// stranger's tag matching an entry here unlikely (5,000 entries in 2^32), and
// even then the value only shows to the owner who redacted it.
export function unredact(text, map) {
  return text.replace(PLACEHOLDER, (placeholder) => map.value(placeholder) ?? placeholder);
}


// "Keep as is" puts a word joiner (U+2060, invisible) after the value: host
// replacements have to change the text, and the joiner is how the next look at
// the draft knows to leave the value alone. Redact & send strips every joiner
// before the draft goes out.
export const KEEP = "⁠";
// Host limit on a replacement's length (UTF-16 units).
const REPLACEMENT_LENGTH = 64;
// Pattern types still sent if left in code, a link or a mention, so the send
// is held instead. Names and places there are mostly mentions, and pass.
const HELD_OUTSIDE_PROSE = new Set(["key", "email", "ip", "phone"]);
const LABELS = {
  key: "Key or token",
  email: "Email address",
  ip: "IP address",
  phone: "Phone number",
  name: "Name",
  place: "Place",
};

function inside(ranges, { start, end }) {
  return ranges.some((range) => range.start <= start && end <= range.end);
}

// The spans still to redact: not in a placeholder, not kept, and with no
// joiner inside. Detection sees joiners as spaces (`forDetection`), so the
// offsets hold for `text`.
export function openSpans(text, spans) {
  const taken = [...text.matchAll(PLACEHOLDER)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  return spans
    .map((span) => ({ ...span, text: text.slice(span.start, span.end) }))
    .filter((span) => text[span.end] !== KEEP && !span.text.includes(KEEP) && !taken.some((t) => span.start < t.end && span.end > t.start));
}

export function forDetection(text) {
  return text.replaceAll(KEEP, " ");
}

// Underlines for the host to draw, one per open span in prose, with the
// placeholder it would become and, when the host allows the length, Keep as is.
export function annotationsFor({ text, prose }, spans, map) {
  return openSpans(text, spans)
    .filter((span) => inside(prose, span))
    .map((span) => {
      const placeholder = map.reserve(span.type, span.text);
      const replacements = [{ text: placeholder, label: `Redact as ${placeholder}` }];
      if (span.text.length + KEEP.length <= REPLACEMENT_LENGTH) replacements.push({ text: span.text + KEEP, label: "Keep as is" });
      return { start: span.start, end: span.end, text: span.text, label: LABELS[span.type], replacements };
    });
}

// How many times `needle` starts inside a prose range before `before`. Edits
// find their text again in the editor by this count, which never counts code,
// links or mentions on either side.
export function proseOccurrence(text, prose, needle, before) {
  let count = 0;
  for (const range of prose) {
    for (let at = text.indexOf(needle, range.start); at >= 0 && at + needle.length <= range.end && at < before; at = text.indexOf(needle, at + 1)) count++;
  }
  return count;
}

// What Redact & send does to an observed draft: `edits` (each the text to
// find, which prose occurrence of it, and what goes in its place), the text
// the draft must read afterwards, and `held` for PII it cannot reach.
export function planRedaction({ text, prose }, spans, map) {
  const open = openSpans(text, spans);
  const held = open.filter((span) => !inside(prose, span) && HELD_OUTSIDE_PROSE.has(span.type));
  const changes = open.filter((span) => inside(prose, span)).map((span) => ({ ...span, insert: map.reserve(span.type, span.text) }));
  for (let at = text.indexOf(KEEP); at >= 0; at = text.indexOf(KEEP, at + 1)) {
    if (inside(prose, { start: at, end: at + 1 })) changes.push({ start: at, end: at + 1, text: KEEP, insert: "" });
  }
  changes.sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const change of changes) {
    out += text.slice(at, change.start) + change.insert;
    at = change.end;
  }
  return {
    held,
    text: out + text.slice(at),
    edits: changes.map((change) => ({ ...change, occurrence: proseOccurrence(text, prose, change.text, change.start) })),
  };
}

// The editor's prose as runs of adjacent text nodes, the way the host's
// projection counts it: text in code, links, mentions (plain spans), chips and
// across line breaks or blocks is left out and ends a run. Formatting marks,
// spoilers and annotation underlines don't.
const SEE_THROUGH = new Set(["STRONG", "EM", "S"]);
function seeThrough(element) {
  return SEE_THROUGH.has(element.tagName) || (element.tagName === "SPAN" && (element.hasAttribute("data-annotation") || element.hasAttribute("data-spoiler")));
}
function proseRuns(editor) {
  const runs = [];
  let run = null;
  const walk = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        if (!run) runs.push((run = { text: "", nodes: [] }));
        run.nodes.push({ node: child, start: run.text.length });
        run.text += child.data;
      } else if (child.nodeType === 1) {
        if (seeThrough(child)) walk(child);
        else {
          run = null;
          if (child.getAttribute("contenteditable") !== "false" && !["CODE", "PRE", "A", "SPAN"].includes(child.tagName)) {
            walk(child);
            run = null;
          }
        }
      }
    }
  };
  walk(editor);
  return runs;
}
function point(run, offset, end) {
  let found = run.nodes[0];
  for (const entry of run.nodes) if (end ? entry.start < offset : entry.start <= offset) found = entry;
  return [found.node, offset - found.start];
}
function locate(editor, needle, occurrence) {
  let count = 0;
  for (const run of proseRuns(editor)) {
    for (let at = run.text.indexOf(needle); at >= 0; at = run.text.indexOf(needle, at + 1)) {
      if (count++ === occurrence) return [...point(run, at, false), ...point(run, at + needle.length, true)];
    }
  }
}

const SEND = 'button[type="submit"][aria-label="Send message"]';
const COMPOSER = "form[data-composer-surface]";
// How long the editor gets to show the redacted draft.
const SETTLE_MS = 1_500;
// Underlines wait for typing to pause this long.
const DEBOUNCE_MS = 250;
const WARNINGS = {
  noVenv: { text: "Not redacting: engine not set up", title: "Set up the model (PII Redact's README, Setup), then turn the plugin off and on." },
  noModel: { text: "Not redacting: engine not set up", title: "Install spaCy and its model (PII Redact's README, Setup), then turn the plugin off and on." },
  noHost: { text: "Not redacting: this Buzz can't run it", title: "PII Redact needs a Buzz with composer annotators and plugin processes." },
};
const HOLDS = {
  outside: "Not sent: there's PII in code, a link or a mention. Remove it first.",
  failed: "Not sent: names and places couldn't be checked. Try again.",
  changed: "Not sent: the draft changed while redacting. Try again.",
  edit: "Not sent: the draft couldn't be redacted. Check it, then try again.",
};

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const spawn = typeof ctx.host.spawn === "function" ? ctx.host.spawn.bind(ctx.host) : null;
  const engine = spawn && createEngine(spawn);
  const map = createPlaceholderMap();
  ctx.effect(() => () => engine?.dispose());

  // Why it can't redact, once known; Send goes back to the host. "noHost" is
  // a Buzz without annotators or processes.
  let setup = spawn && typeof ctx.conversation.registerAnnotator === "function" ? null : "noHost";
  const setupListeners = new Set();
  function setSetup(value) {
    setup = value;
    for (const listener of setupListeners) listener();
  }
  async function detect(text) {
    const result = await engine.detect(forDetection(text));
    if (result.error === "noVenv" || result.error === "noModel") setSetup(result.error);
    return result;
  }

  // One entry per composer destination: its latest observation, the spans
  // found for it, and whether a redaction is running. `dirty` is set by input
  // the observation hasn't caught up with yet (a paste just before Enter).
  const composers = new Map();
  function composer(key) {
    let entry = composers.get(key);
    if (!entry) composers.set(key, (entry = { observation: null, found: null, busy: false, hold: null, dirty: false, waiters: new Set(), listeners: new Set() }));
    return entry;
  }
  function changed(entry) {
    for (const listener of entry.listeners) listener();
  }
  const keyOf = ({ scope, channelId, threadRootId }) => JSON.stringify([scope, channelId, threadRootId ?? null]);

  function Annotator({ observation, publish, ...context }) {
    const key = keyOf(context);
    React.useEffect(() => {
      const entry = composer(key);
      // Only a new draft clears `dirty`, not a re-run for a new `publish`.
      if (entry.observation !== observation) entry.dirty = false;
      entry.observation = observation;
      // A picked "Redact as" puts a reserved placeholder in the draft.
      map.commit(observation.text);
      for (const wake of entry.waiters) wake(observation);
      if (setup) return;
      let live = true;
      let withdraw;
      const timer = setTimeout(async () => {
        const { spans, error } = await detect(observation.text);
        if (!live || setup) return;
        entry.found = { observation, spans, error };
        const shown = publish(annotationsFor(observation, spans, map));
        if (typeof shown === "function") withdraw = shown;
      }, DEBOUNCE_MS);
      return () => {
        live = false;
        clearTimeout(timer);
        withdraw?.();
      };
    }, [key, observation, publish]);
    return null;
  }

  function nextObservation(entry, after) {
    return new Promise((resolve) => {
      const wake = (observation) => {
        if (observation === after) return;
        entry.waiters.delete(wake);
        clearTimeout(timer);
        resolve(observation);
      };
      const timer = setTimeout(() => {
        entry.waiters.delete(wake);
        resolve(null);
      }, SETTLE_MS);
      entry.waiters.add(wake);
    });
  }

  // Edits made by Redact & send, which the lock lets through.
  let editing = false;
  function replace(editor, edit) {
    const found = locate(editor, edit.text, edit.occurrence);
    if (!found) return false;
    document.getSelection().setBaseAndExtent(...found);
    editing = true;
    try {
      return document.execCommand(edit.insert ? "insertText" : "delete", false, edit.insert);
    } finally {
      editing = false;
    }
  }

  // Redacts the focused draft in place. Resolves true when the draft now
  // reads exactly as planned, or a HOLDS key, or null when the engine turned
  // out to be missing (the host Send is back by then).
  async function redactDraft(entry, editor) {
    // Input the observation hasn't caught up with yet: wait for it, so the
    // plan (and "nothing to redact") is for the draft as it is now. Input that
    // left the draft as it was brings no new observation; past SETTLE_MS the
    // current one stands. A draft not focused since Buzz started has none yet.
    if (entry.dirty || !entry.observation) await nextObservation(entry, entry.observation);
    entry.dirty = false;
    const observation = entry.observation;
    if (!observation || !editor.contains(document.activeElement)) return "edit";
    const { spans, error } = entry.found?.observation === observation && !entry.found.error ? entry.found : await detect(observation.text);
    if (setup) return null;
    if (error) return "failed";
    if (entry.observation !== observation) return "changed";
    const plan = planRedaction(observation, spans, map);
    if (plan.held.length) return "outside";
    if (!plan.edits.length) return true;
    // Last to first, so each edit leaves the earlier ones where they were.
    for (const edit of [...plan.edits].reverse()) {
      if (!replace(editor, edit)) return "edit";
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const next = entry.observation !== observation ? entry.observation : await nextObservation(entry, observation);
    if (next?.text !== plan.text) return "edit";
    map.commit(plan.text);
    return true;
  }

  async function run(key, form, then) {
    const entry = composer(key);
    if (entry.busy) return;
    const editor = form.querySelector('[contenteditable="true"]');
    if (!editor) return;
    entry.busy = true;
    entry.hold = null;
    changed(entry);
    let result;
    try {
      result = await redactDraft(entry, editor);
    } catch (cause) {
      console.warn("pii-redact:", cause);
      result = "edit";
    }
    entry.busy = false;
    entry.hold = typeof result === "string" ? HOLDS[result] : null;
    changed(entry);
    if (result === true) then();
  }

  // Enter, or ⌘/Ctrl+Enter, in a composer with Redact & send: redact first,
  // then hand the same key back to the host, which decides whether it sends
  // (or adds a line, in a list or with ⌘+Enter to send). A draft with nothing
  // to redact passes straight through.
  const passed = new WeakSet();
  ctx.effect(() => {
    function composerOf(event) {
      const editor = event.target instanceof Element ? event.target.closest('[contenteditable="true"]') : null;
      const form = editor?.closest(COMPOSER);
      const slot = form && !form.hasAttribute("data-editing") ? form.querySelector("[data-pii-redact-send]") : null;
      return slot && { editor, form, key: slot.getAttribute("data-pii-redact-send") };
    }
    function onKeyDown(event) {
      const target = composerOf(event);
      if (!target) return;
      const entry = composer(target.key);
      if (entry.busy) {
        // The box is locked while it is being redacted.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (passed.has(event) || event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
      // A suggestion list is open: Enter picks from it.
      const list = target.editor.getAttribute("aria-controls");
      if (list && document.getElementById(list)) return;
      const found = entry.found;
      if (!entry.dirty && found && found.observation === entry.observation && !found.error) {
        const plan = planRedaction(found.observation, found.spans, map);
        if (!plan.edits.length && !plan.held.length) return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const { key, code, metaKey, ctrlKey } = event;
      void run(target.key, target.form, () => {
        const again = new KeyboardEvent("keydown", { key, code, metaKey, ctrlKey, bubbles: true, cancelable: true });
        passed.add(again);
        target.editor.dispatchEvent(again);
      });
    }
    function onInput(event) {
      const target = composerOf(event);
      if (!target) return;
      const entry = composer(target.key);
      if (entry.busy && !editing) {
        event.preventDefault();
        event.stopPropagation();
      } else if (!entry.busy) entry.dirty = true;
    }
    document.addEventListener("keydown", onKeyDown, true);
    for (const type of ["beforeinput", "paste", "drop"]) document.addEventListener(type, onInput, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      for (const type of ["beforeinput", "paste", "drop"]) document.removeEventListener(type, onInput, true);
    };
  });

  function useSetup() {
    return React.useSyncExternalStore(
      (listener) => {
        setupListeners.add(listener);
        return () => setupListeners.delete(listener);
      },
      () => setup,
    );
  }

  // Tabler shield and alert triangle.
  function icon(paths) {
    return h(
      "svg",
      { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
      ...paths.map((d) => h("path", { key: d, d })),
    );
  }
  const SHIELD = ["M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"];
  const ALERT = ["M12 9v4", "M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z", "M12 16h.01"];

  function RedactSend({ disabled, focus, ...context }) {
    const key = keyOf(context);
    const missing = useSetup();
    const entry = composer(key);
    const state = React.useSyncExternalStore(
      (listener) => {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      () => (entry.busy ? "busy" : entry.hold ?? ""),
    );
    const slot = React.useRef(null);

    // Sit exactly over the hidden host Send, which is widened to this button
    // so whatever sits left of it (the model picker) makes room.
    React.useLayoutEffect(() => {
      const element = slot.current;
      const form = element?.closest(COMPOSER);
      const send = form?.querySelector(SEND);
      if (missing || !form || !send) return;
      const place = () => {
        form.style.setProperty("--pii-redact-send-width", `${element.offsetWidth}px`);
        const parent = element.offsetParent ?? document.body;
        const box = parent.getBoundingClientRect();
        const target = send.getBoundingClientRect();
        element.style.left = `${target.left - box.left - parent.clientLeft + parent.scrollLeft}px`;
        element.style.top = `${target.top + (target.height - element.offsetHeight) / 2 - box.top - parent.clientTop + parent.scrollTop}px`;
      };
      place();
      const observer = new ResizeObserver(place);
      for (const watched of [form, send, element]) observer.observe(watched);
      window.addEventListener("resize", place);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", place);
        form.style.removeProperty("--pii-redact-send-width");
      };
    }, [missing, state]);

    if (missing)
      return h(
        "span",
        { className: "pii-warning", role: "status", title: WARNINGS[missing].title },
        h("style", null, CSS),
        icon(ALERT),
        WARNINGS[missing].text,
      );
    const busy = state === "busy";
    return h(
      "span",
      { ref: slot, className: "pii-slot", "data-pii-redact-send": key, "data-busy": busy || undefined },
      h("style", null, CSS),
      state && !busy && h("span", { className: "pii-hold", role: "alert" }, state),
      h(
        "button",
        {
          type: "button",
          "data-buzz-ui": "",
          className: "buzz-button pii-send",
          "data-variant": "primary",
          "data-size": "sm",
          title: "Redact & send · Enter",
          disabled: disabled || busy,
          "aria-busy": busy || undefined,
          // Keep the caret in the draft: only the focused composer is observed.
          onMouseDown: (event) => event.preventDefault(),
          onClick: (event) => {
            const form = event.currentTarget.closest(COMPOSER);
            if (!form) return;
            focus();
            void run(key, form, () => form.querySelector(SEND)?.click());
          },
        },
        busy ? h("span", { className: "pii-spinner", "aria-hidden": true }) : icon(SHIELD),
        h("span", { className: "buzz-button-label" }, busy ? "Redacting…" : "Redact & send"),
      ),
    );
  }

  if (!setup) ctx.conversation.registerAnnotator({ id: "pii", title: "PII Redact", component: Annotator });
  ctx.conversation.registerTool({ id: "redact-send", title: "Redact & send", order: 1000, component: RedactSend });

  // Placeholders this Mac knows show their value, with the placeholder that
  // was sent on hover. Keys have no stored value and stay as they are.
  if (typeof ctx.conversation.registerInline === "function")
    ctx.conversation.registerInline({
      id: "unredact",
      title: "PII Redact",
      matches: ({ text }) =>
        [...text.matchAll(PLACEHOLDER)].filter((m) => map.value(m[0]) !== undefined).map((m) => ({ start: m.index, end: m.index + m[0].length })),
      component: ({ text }) => h("span", { title: `Sent as ${text}` }, map.value(text) ?? text),
    });
}

// Hides the host Send only in composers that show Redact & send, so it comes
// back by itself when this button isn't drawn: engine missing, plugin off, or
// editing a sent message.
const CSS = `
${COMPOSER}:not([data-editing]):has([data-pii-redact-send]) ${SEND} {
  visibility: hidden;
  flex: none;
  min-width: var(--pii-redact-send-width, auto);
}
${COMPOSER}[data-editing] [data-pii-redact-send] {
  display: none;
}
${COMPOSER}:has([data-pii-redact-send][data-busy]) [contenteditable="true"] {
  opacity: 0.6;
  cursor: progress;
}
.pii-slot {
  position: absolute;
  z-index: 1;
  display: flex;
  align-items: center;
}
.pii-send {
  white-space: nowrap;
  gap: var(--space-1);
}
.pii-hold {
  position: absolute;
  right: calc(100% + var(--space-2));
  width: max-content;
  max-width: 320px;
  font-size: var(--text-caption);
  color: var(--text-danger);
}
.pii-warning {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--text-caption);
  white-space: nowrap;
  color: var(--text-danger);
}
.pii-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: pii-spin 0.8s linear infinite;
}
@keyframes pii-spin {
  to {
    transform: rotate(360deg);
  }
}
`;
