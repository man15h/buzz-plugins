// node --test plugins/pii-redact/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { KEEP, NO_VENV, PLACEHOLDER, annotationsFor, createEngine, createPlaceholderMap, findPatterns, nerSpans, planRedaction, proseOccurrence, redact, resolveOverlaps, unredact } from "./plugin.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/draft.json", import.meta.url), "utf8"));

// A stand-in for `ctx.host.spawn` that answers each line with `reply(request)`.
function fakeSpawn(reply, { exitCode } = {}) {
  const calls = [];
  const spawn = (id, { onStdout }) => {
    let exit;
    const exited = new Promise((resolve) => (exit = resolve));
    calls.push(id);
    if (exitCode !== undefined) queueMicrotask(() => exit(exitCode));
    return {
      exited,
      write(line) {
        if (exitCode !== undefined) return;
        const request = JSON.parse(line);
        queueMicrotask(() => onStdout(`${JSON.stringify({ id: request.id, ...reply(request) })}\n`));
      },
      kill() {
        exit(null);
      },
    };
  };
  return { spawn, calls };
}

test("the fixture draft comes back as typed spans", async () => {
  const { spawn } = fakeSpawn(() => ({ ents: fixture.ner }));
  const engine = createEngine(spawn);
  const { spans, error } = await engine.detect(fixture.text);
  assert.equal(error, undefined);
  assert.deepEqual(spans, fixture.spans);
  for (const span of spans) assert.equal(fixture.text.slice(span.start, span.end), span.text);
  engine.dispose();
});

test("one process serves every draft", async () => {
  const { spawn, calls } = fakeSpawn(() => ({ ents: [] }));
  const engine = createEngine(spawn);
  await engine.detect("first draft");
  await engine.detect("second draft");
  assert.deepEqual(calls, ["ner"]);
  engine.dispose();
});

test("regex spans survive a missing venv", async () => {
  const { spawn } = fakeSpawn(() => ({}), { exitCode: NO_VENV });
  const engine = createEngine(spawn);
  const { spans, error } = await engine.detect("mail me at someone@example.com");
  assert.equal(error, "noVenv");
  assert.deepEqual(spans.map((s) => s.type), ["email"]);
});

test("NER code point offsets become UTF-16 offsets", () => {
  const text = "🙂 Ana";
  assert.deepEqual(nerSpans(text, [[2, 5, "PERSON"], [0, 1, "DATE"]]), [{ type: "name", start: 3, end: 6, text: "Ana" }]);
});

test("dates, versions and times are not phones", () => {
  assert.deepEqual(findPatterns("on 2026-11-15 at 18:44, v1.27.2, build 20261115"), []);
});

test("only the value of a key assignment is the key", () => {
  const [span] = findPatterns("password = hunter2hunter2");
  assert.deepEqual(span, { type: "key", start: 11, end: 25, text: "hunter2hunter2" });
});

test("IPv6 needs to parse as an address", () => {
  assert.deepEqual(findPatterns("2001:db8::1 at 10:30:00").map((s) => s.text), ["2001:db8::1"]);
});

test("on overlap the earlier, then longer, span wins", () => {
  const spans = resolveOverlaps([
    { type: "name", start: 0, end: 5, text: "" },
    { type: "email", start: 0, end: 10, text: "" },
    { type: "place", start: 8, end: 12, text: "" },
  ]);
  assert.deepEqual(spans.map((s) => s.type), ["email"]);
});

function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => items.set(k, String(v)),
    removeItem: (k) => items.delete(k),
  };
}

test("redacting the fixture and putting it back", () => {
  const map = createPlaceholderMap(memoryStorage());
  const { text, replacements } = redact(fixture.text, fixture.spans, map);
  assert.deepEqual(replacements.map((r) => [r.start, r.end]), fixture.spans.map((s) => [s.start, s.end]));
  assert.deepEqual([...text.matchAll(PLACEHOLDER)].map((m) => m[1]), ["NAME", "EMAIL", "PHONE", "IP", "KEY", "PLACE"]);
  for (const span of fixture.spans) assert.ok(!text.includes(span.text));
  const key = fixture.spans.find((s) => s.type === "key");
  assert.equal(unredact(text, map), fixture.text.replace(key.text, replacements.find((r) => r.type === "key").placeholder));
});

test("replacements applied last to first give the redacted text", () => {
  const map = createPlaceholderMap(memoryStorage());
  const { text, replacements } = redact(fixture.text, fixture.spans, map);
  let draft = fixture.text;
  for (const r of [...replacements].reverse()) draft = draft.slice(0, r.start) + r.placeholder + draft.slice(r.end);
  assert.equal(draft, text);
});

test("one value keeps one placeholder; keys get a new one and no stored value", () => {
  const storage = memoryStorage();
  const map = createPlaceholderMap(storage);
  const email = map.placeholder("email", "someone@example.com");
  assert.equal(map.placeholder("email", "someone@example.com"), email);
  assert.notEqual(map.placeholder("email", "other@example.com"), email);
  const secret = fixture.spans.find((s) => s.type === "key").text;
  const key = map.placeholder("key", secret);
  assert.notEqual(map.placeholder("key", secret), key);
  assert.equal(map.value(key), undefined);
  assert.ok(![...storage.items.values()].join().includes(secret));
});

test("the map survives a reload and forget clears it", () => {
  const storage = memoryStorage();
  const placeholder = createPlaceholderMap(storage).placeholder("name", "Maria Garcia");
  const reloaded = createPlaceholderMap(storage);
  assert.equal(reloaded.value(placeholder), "Maria Garcia");
  reloaded.forget();
  assert.equal(createPlaceholderMap(storage).value(placeholder), undefined);
});

test("unknown placeholders and existing ones are left alone", () => {
  const map = createPlaceholderMap(memoryStorage());
  assert.equal(unredact("hi [EMAIL·00000000]", map), "hi [EMAIL·00000000]");
  const text = "see [NAME·ab12cd34] now";
  assert.equal(redact(text, [{ type: "name", start: 5, end: 9, text: "NAME" }], map).text, text);
});

test("without storage the map still works", () => {
  const map = createPlaceholderMap(null);
  assert.equal(map.value(map.placeholder("ip", "192.0.2.1")), "192.0.2.1");
});

test("a reserved placeholder is stored only once a draft holds it", () => {
  const storage = memoryStorage();
  const map = createPlaceholderMap(storage);
  const p = map.reserve("email", "someone@example.com");
  assert.equal(map.reserve("email", "someone@example.com"), p);
  assert.equal(map.value(p), undefined);
  assert.equal(storage.items.size, 0);
  map.commit(`write to ${p}`);
  assert.equal(map.value(p), "someone@example.com");
  assert.equal(map.reserve("email", "someone@example.com"), p);
});

// One prose run over the whole text, as a plain draft observes.
const observe = (text) => ({ text, prose: [{ start: 0, end: text.length }] });
const span = (text, type, value, from = 0) => {
  const start = text.indexOf(value, from);
  return { type, start, end: start + value.length, text: value };
};

test("underlines offer the placeholder and Keep as is", () => {
  const map = createPlaceholderMap(memoryStorage());
  const text = "mail ana@example.com";
  const [mark] = annotationsFor(observe(text), [span(text, "email", "ana@example.com")], map);
  assert.equal(mark.label, "Email address");
  assert.equal(mark.text, "ana@example.com");
  assert.match(mark.replacements[0].text, PLACEHOLDER);
  assert.equal(mark.replacements[0].label, `Redact as ${mark.replacements[0].text}`);
  assert.deepEqual(mark.replacements[1], { text: `ana@example.com${KEEP}`, label: "Keep as is" });
});

test("kept values and placeholders get no underline; spans outside prose none either", () => {
  const map = createPlaceholderMap(memoryStorage());
  const text = `Ana${KEEP} met Bo in \`tok_123\``;
  const observation = { text, prose: [{ start: 0, end: text.indexOf("`") }] };
  const spans = [span(text, "name", "Ana"), span(text, "name", "Bo"), span(text, "key", "tok_123")];
  assert.deepEqual(annotationsFor(observation, spans, map).map((m) => m.text), ["Bo"]);
});

test("Redact & send plans placeholders, strips Keep marks and holds PII in code", () => {
  const map = createPlaceholderMap(memoryStorage());
  const text = `Ana${KEEP} and Bo, Bo again`;
  const second = span(text, "name", "Bo", text.indexOf("Bo") + 1);
  const plan = planRedaction(observe(text), [span(text, "name", "Ana"), span(text, "name", "Bo"), second], map);
  const p = map.reserve("name", "Bo");
  assert.equal(plan.text, `Ana and ${p}, ${p} again`);
  assert.deepEqual(plan.edits.map((e) => [e.text, e.occurrence, e.insert]), [[KEEP, 0, ""], ["Bo", 0, p], ["Bo", 1, p]]);
  assert.deepEqual(plan.held, []);

  const code = "key `ghp_x`";
  const held = planRedaction({ text: code, prose: [{ start: 0, end: 4 }] }, [{ type: "key", start: 5, end: 10, text: "ghp_x" }], map);
  assert.equal(held.held.length, 1);
  assert.equal(held.edits.length, 0);
});

test("occurrences are counted in prose only", () => {
  const text = "Bo `Bo` Bo";
  const prose = [{ start: 0, end: 3 }, { start: 7, end: 10 }];
  assert.equal(proseOccurrence(text, prose, "Bo", 8), 1);
});
