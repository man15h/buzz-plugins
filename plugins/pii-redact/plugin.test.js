// node --test plugins/pii-redact/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { NO_VENV, createEngine, findPatterns, nerSpans, resolveOverlaps } from "./plugin.js";

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
