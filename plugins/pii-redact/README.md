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
~/.local/share/pii-redact/venv/bin/pip install --only-binary :all: spacy
~/.local/share/pii-redact/venv/bin/python -m spacy download en_core_web_sm --only-binary :all:
```

These run outside the sandbox, so `--only-binary :all:` takes prebuilt wheels
only: no package's build script runs on your Mac. `spacy download` passes the
flag on to pip.

Without it the patterns still work, and `detect` reports `noVenv` (no venv)
or `noModel` (spaCy or the model missing) so a UI can say why names and
places were not checked.

## What it can reach

The plugin asks for one process, `ner`, and no network origins. Buzz runs it
under macOS `sandbox-exec` with a fixed profile, running a fixed `/bin/sh`
line. The profile starts from `(deny default)`, the same base as Voice Input:
everything is refused unless a rule below allows it. That covers network, IPC
with system services and other apps (Mach lookups and Apple Events, so no
asking a browser or a daemon to fetch something), and every file not listed.
Every allow:

| Rule | What it lets through | Why |
|---|---|---|
| `process-exec` | Only `/bin/sh` (and the `/bin/bash` or `/bin/dash` it hands off to), the venv's `bin/python3`, and Homebrew's `python@3.x` under `/opt/homebrew` or `/usr/local` (`Cellar/` and its `opt/` links) | The shell line, the venv's Python, and the interpreter it links to |
| `sysctl-read` | Reading kernel settings such as the CPU count | NumPy picks its thread count from it |
| `file-read-metadata` | `stat` on any path: whether it exists, size and dates. Not its contents, and not a directory's listing | Loading libraries walks paths; listing every parent folder would be brittle |
| `file-read*` on `/System/Library`, `/System/Cryptexes`, `/System/Volumes/Preboot/Cryptexes`, `/usr/lib`, `/usr/share`, `/bin`, `/usr/bin`, `/private/var/select` | macOS's own libraries, programs and shared data | Every program needs the system libraries; `/private/var/select` says which shell `/bin/sh` is |
| `file-read*` on `/opt/homebrew`, `/usr/local` | Homebrew's programs and libraries | Python's standard library and the libraries it links (OpenSSL, libffi and the like) |
| `file-read*` on `/dev/null`, `/dev/urandom` | Those two devices | Standard library start-up |
| `file-read*` on `~/.local/share/pii-redact/venv` | spaCy, its dependencies and the model, and nothing else under `/Users` | The model |
| `file-write-data` on `/dev/null` | Writes to `/dev/null` only | Discarded output |

Python runs with `-I -B`: no user site-packages, no environment variables
steering imports, and no bytecode files written.

It starts on the first draft and stays up, so later drafts skip the model
load. A draft that takes longer than 10 seconds kills it, and the next draft
starts a fresh one. Drafts over 20,000 characters are checked for names and
places up to there; the patterns cover all of it.

## Placeholders

`redact(text, spans, map)` swaps each span for a placeholder such as
`[EMAIL·a3f9]`: the type, then four random hex digits. The placeholder is what
gets sent, so everyone else sees only that. Each value keeps one placeholder,
which is what lets the sender's Mac show it again (`unredact`). The other
side of that: two messages that carry the same placeholder carry the same
value. The digits are random, not a hash, so a placeholder can't be guessed
back from a phone number or a name.

Keys and tokens are the exception. Each one gets a fresh placeholder and its
value is never stored, so a secret stays redacted even on your Mac.

## The placeholder map

The placeholder→value map holds the real emails, phones, IPs, names and
places you redacted, so it stays on this Mac:

- **Where:** Buzz's web storage (`localStorage`) on this Mac, key
  `pii-redact/placeholders/v1`, as plain JSON. The plugin never publishes it,
  and Buzz doesn't sync web storage to the relay or to your other devices.
  Keeping the newest 5,000 entries caps its size.
- **What can read it:** any plugin you install (plugins run as trusted code in
  Buzz's JavaScript context and share its storage), and any program running
  as you that can read Buzz's app data folder, the same as the rest of Buzz's
  local data. It isn't encrypted. FileVault protects it at rest only while the
  Mac is off.
- **Forgetting:** `forget()` clears it. After that, your own sent messages show
  their placeholders like everyone else's.

## Composer hook

On buzz-app `main`, a plugin can read the draft and mark ranges in it with
`registerAnnotator`. The annotator gets an observation (`revision`, `text`,
`prose`) and publishes marks over `prose`, each with suggested replacements
the person can pick. That covers highlighting and click-to-redact. It can't:

- rewrite the draft itself, so there is no one-click "redact everything";
- mark anything outside `prose`, such as code spans, links and mentions, where
  a pasted token often sits;
- see or stop a send: there is no pre-send hook, and a tool has no `send()`.

A Redact & send button and a mode that redacts every send need those from
the host first.

## Tests

```sh
node --test plugins/pii-redact/
```

The tests stand in for the process, so they need neither macOS nor the model.
