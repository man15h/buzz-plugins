# PII Redact

Finds personal data in a draft before you send it: emails, phone numbers,
keys and tokens, IP addresses, and the names and places a small language
model picks out. Everything runs on your Mac, and the model runs with no
network.

This revision is the engine only. It returns what it found as typed spans
with offsets, and has no composer UI yet (see [Composer hook](#composer-hook)).

## What it finds

| Type | How |
|---|---|
| `email` | Pattern |
| `phone` | Pattern: 10 to 15 digits, or 8 and up after a `+` country code |
| `key` | Pattern: private key blocks, GitHub, OpenAI/Anthropic, Stripe, Slack, GitLab, AWS, Google and nostr secret keys, JWTs, and the value after `token:`, `password=` and the like |
| `ip` | Pattern: IPv4 (with an optional `/prefix`) and IPv6 |
| `name` | spaCy `en_core_web_sm`, `PERSON` |
| `place` | spaCy `en_core_web_sm`, `GPE`, `LOC` and `FAC` |

A span is `{ type, start, end, text }`, where `start` and `end` are UTF-16
offsets into the draft, as composer selections count them. Spans never
overlap. [`fixtures/draft.json`](fixtures/draft.json) is a draft with one of
each, and the spans it comes back as.

## Setup

The model runs from its own virtual environment, made with a Homebrew
`python3`. The venv is the only thing under your home folder its
sandbox lets it read:

```sh
python3 -m venv ~/.local/share/pii-redact/venv
~/.local/share/pii-redact/venv/bin/pip install spacy
~/.local/share/pii-redact/venv/bin/python -m spacy download en_core_web_sm
```

Without it the patterns still work, and `detect` reports `noVenv` (no venv)
or `noModel` (spaCy or the model missing) so a UI can say why names and
places were not checked.

## What it can reach

The plugin asks for one process, `ner`, and no network origins. Buzz runs it
under macOS `sandbox-exec` with a profile that:

- denies all network access,
- denies running any program except a shell, the venv's Python, and the
  Python it links to under `/opt/homebrew` or `/usr/local`,
- denies reads under `/Users` and `/Volumes`, except the venv,
- denies writes, except `/dev/null` and the per-user temporary folder.

It starts on the first draft and stays up, so later drafts skip the model
load. A draft that takes longer than 10 seconds kills it, and the next draft
starts a fresh one. Drafts over 20,000 characters are checked for names and
places up to there; the patterns cover all of it.

## Composer hook

A plugin can't read or rewrite the composer draft today, and it can't hook
send (buzz-app `src/features/conversation/contracts.ts`):

- `registerTool` (a composer button) gets `insertText`, `insertMention(s)`,
  `replaceRecipients`, `insertResource` and `focus`, plus read-only
  `recipients`. It inserts at the caret only: no read of the prose, no
  replace-range.
- There is no pre-send hook; sending is owned by the host.
- `registerAccessory` is read-only UI with no editor commands.
- `registerCompletion` sees the full draft in `match()`, but only replaces
  the query under a collapsed caret, and can't stop a send.

The composer UI needs a host API first: a draft read (text and revision),
`replaceRange(start, end, text, revision)` rejected on a stale revision, a
tool `send()`, and `registerSendCheck` for a mode where every send is
redacted first.

## Tests

```sh
node --test plugins/pii-redact/
```

The tests stand in for the process, so they need neither macOS nor the model.
