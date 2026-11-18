# PII Redact

Finds personal data in a draft before you send it: emails, phone numbers,
keys and tokens, IP addresses, and the names and places a small language
model picks out. Everything runs on your Mac, and the model runs with no
network.

In the composer it underlines what it finds, and its **Redact & send**
button takes Send's place: one click (or Enter) swaps every find for a
placeholder such as `[EMAIL·a3f9c20e]`, then sends. On your Mac, your messages
and replies that quote your placeholders show the real values again (see
[In Buzz](#in-buzz)).

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

Without it the plugin doesn't redact: Redact & send steps aside, the normal
Send comes back, and "Not redacting: engine not set up" sits in the toolbar.
After setting it up, turn the plugin off and on in Settings.

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
`[EMAIL·a3f9c20e]`: the type, then eight random hex digits. The placeholder is what
gets sent, so everyone else sees only that. Each value keeps one placeholder,
which is what lets the sender's Mac show it again (`unredact`). The other
side of that: two messages that carry the same placeholder carry the same
value. The digits are random, not a hash, so a placeholder can't be guessed
back from a phone number or a name.

`unredact` runs on any message, so an agent's reply that quotes your
placeholder shows you your own value. It only changes what your screen
shows: the value is one you redacted, and nobody else's view changes. Another
person's placeholder matching an entry in your map by chance is unlikely
(5,000 entries in about four billion tags), and would show you a value of
yours, not theirs.

Keys and tokens are the exception. Each one gets a fresh placeholder and its
value is never stored, so a secret stays redacted even on your Mac.

## The placeholder map

The placeholder→value map holds the real emails, phones, IPs, names and
places you redacted, so it stays on this Mac. A value only goes in once its
placeholder is in a draft; underlined values wait in memory until then, so
one you delete before redacting is never stored.

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

## In Buzz

- **Underlines:** finds are underlined as you type. Right-click one (or put
  the caret in it and press ⌘.) for **Redact as `[EMAIL·a3f9c20e]`** or
  **Keep as is**. Keep as is leaves that value alone in this draft.
- **Redact & send** sits where Send was, which is hidden. It swaps every
  remaining find for its placeholder, checks the box now reads exactly the
  redacted text, then presses the hidden Send. The box is locked while it
  works.
- **Enter** (and ⌘+Enter) do the same, then hand the key back to Buzz, so
  Shift+Enter, lists and your send-key setting work as before. A draft with
  nothing to redact sends at once.
- **Held sends:** it doesn't send, and says why, when a key, email, phone or IP
  sits in code, a link target or a mention (it can't rewrite those), when
  names couldn't be checked, or when the box didn't end up as planned.
  Whatever was already swapped stays swapped; ⌘Z undoes it.
- **Your Mac:** a placeholder from your map shows its real value, as normal
  text, and hovering shows the placeholder that was sent. Everyone else, and
  your other devices, see the placeholder. Keys always stay redacted.

Keep as is works by putting an invisible word joiner (U+2060) after the
value, since Buzz's menu can only replace text. Redact & send removes it
before sending.

How it fits Buzz, which has no pre-send hook for plugins: it underlines
through `registerAnnotator`, shows values through `registerInline`, and is a
`registerTool` button that hides the host Send with CSS (only in composers
where the button is drawn) and clicks it once the draft is redacted. It
edits the draft the way typing does, by selecting each find and inserting
its placeholder. Not covered: editing a sent message (Save sends as typed),
and composers without tools, such as Forward's note.

## Tests

```sh
node --test plugins/pii-redact/
```

The tests stand in for the process, so they need neither macOS nor the model.
