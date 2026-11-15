// node --test plugins/pii-redact/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NO_VENV, PLACEHOLDER, createEngine, createPlaceholderMap, findPatterns, nerSpans, redact, resolveOverlaps, unredact } from "./plugin.js";

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
