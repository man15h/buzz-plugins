# GitHub CI plugin

A Buzz desktop plugin that links a channel to a GitHub repo and shows that
repo's CI in a **CI** tab beside the channel's threads:

- open pull requests with their checks, failing ones first, under a summary
  such as "5 open · 2 failing · 1 running · 2 passing";
- the latest merges into one branch, each with the workflow runs it started.

Failed checks and runs open to their jobs. A pull request or check opens in
Buzz's own GitHub panel when that plugin can show it, else in your browser.
The GitHub button in the channel header shows how many pull requests are
failing, once you have opened the tab in this session.

Mockups: [`docs/github-ci/`](../../docs/github-ci/).

## Install

1. Clone this repository. The plugin is the `plugins/github-ci/` folder.
2. In Buzz: **Settings → Plugins → Manage plugins → Add**, then **Browse**
   under Add from folder, and pick the clone's `plugins/github-ci/` folder.
   Review the access it asks for and install it:
   - two `gh` commands: `gh api graphql` for reads and `gh api user` for your
     login;
   - requests to `https://api.github.com`, for reads with a token.
3. Sign in with `gh auth login`, or add a token (below).

## Reading GitHub

Each viewer reads GitHub with their own credential. Nothing about it reaches
the channel.

1. A token saved in **Settings → GitHub CI**, if there is one.
2. Otherwise, or when GitHub rejects the token or it can't see the repo, your
   `gh` sign-in.

The footer of the CI tab says which one did the read: "Read with token",
"Read as mchen with gh" or "Token rejected · read with gh". The tab reads
again every two minutes while it is open, and on **Refresh**. If a read fails
after an earlier one worked, the earlier one stays on screen, dimmed.

### Token permissions

Use a fine-grained token limited to the repos you need, with an expiry. It
needs only these repository permissions, all read-only:

| Permission | Used for |
|---|---|
| Metadata | the repo itself (always granted) |
| Pull requests | open and merged pull requests |
| Actions | workflow runs and their jobs |
| Commit statuses | statuses posted by services such as deploy previews |

GitHub has no fine-grained permission for the check runs of apps outside
GitHub Actions, so those checks show only when `gh` does the read.

### Token storage

Buzz has no credential store for plugins yet, so the token sits in this
computer's Buzz app data as one `localStorage` key,
`buzz-plugins.github-ci.token.v1`, **unencrypted**. **Remove** in Settings
deletes the key.

- Every other plugin in your Buzz can read it, since plugins are not sandboxed
  from each other. So can anything running as your OS user, root, and backups
  of your home folder.
- The relay, channel members and other viewers can't. The plugin sends the
  token only in the `Authorization` header of requests to
  `https://api.github.com`, and never logs it or puts it in an error message.

A fine-grained, read-only token for only the repos you need keeps the worst
case to someone reading those repos' pull requests and CI.

## Repo link

A channel owner or admin links the repo from the CI tab: type `owner/name`, the
plugin looks it up, then asks which branch's merges to watch (the repo's
default branch to start with). Members see the link but can't change it.

The link is a kind 30078 event in the channel:

```json
{
  "kind": 30078,
  "content": "{\"repo\":\"acme/website\",\"branch\":\"main\"}",
  "tags": [["d", "buzz-plugins.github-ci.link:<channel id>"], ["h", "<channel id>"]]
}
```

Readers take the newest such event whose author is an owner or admin in the
channel's current roster (kind 39001, signed by the relay's own key), and
ignore the rest. Without the relay's key the tab shows an error instead of a
link. **Unlink**
publishes the same event with empty content. The event holds only the repo
and branch.

## Files

- `plugin.js`: the plugin. Plain JavaScript, no build step.
- `manifest.json`: the plugin manifest.
