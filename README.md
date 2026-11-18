# buzz-plugins

Buzz desktop plugins, one folder each under `plugins/`.

| Plugin | What it does |
|---|---|
| [`plugins/remote-agents/`](plugins/remote-agents/README.md) | A **Remote** agent type: create, rename and remove agents that run on your own server, which keeps their keys |
| [`plugins/plane/`](plugins/plane/README.md) | A self-hosted Plane workspace: a board page in the left dock, and card link previews whose state you can move |
| [`plugins/github-ci/`](plugins/github-ci/README.md) | A **CI** tab for a channel's linked GitHub repo: open pull requests with their checks, and the runs each merge starts |
| [`plugins/voice-input/`](plugins/voice-input/README.md) | A **Dictate** button in the composer: whisper.cpp turns your speech into text on your Mac, in a sandbox with no network |
| [`plugins/pinned-threads/`](plugins/pinned-threads/README.md) | Pin threads from any channel to a row of tabs below the title bar, with their unread and agent-working marks |
| [`plugins/pii-redact/`](plugins/pii-redact/README.md) | A **Redact & send** button in Send's place: emails, phones, keys, IPs, names and places become placeholders before you send, found on your Mac with no network |

Where a plugin's `manifest.json` names placeholder origins (`*.example.com`), put in
your own before installing from a folder, or install from a server that
serves the plugin with its origin stamped in.

`plugins/github-ci/`, `plugins/voice-input/` and `plugins/pinned-threads/` have
no placeholder origins, so they also install in one click:

- [Install github-ci in Buzz](https://man15h.github.io/buzz-plugins/install.html?path=plugins/github-ci)
- [Install voice-input in Buzz](https://man15h.github.io/buzz-plugins/install.html?path=plugins/voice-input)
- [Install pinned-threads in Buzz](https://man15h.github.io/buzz-plugins/install.html?path=plugins/pinned-threads)

Each plugin's Install section has the paste command too, for when the link
doesn't open Buzz.
