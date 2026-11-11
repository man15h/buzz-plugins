# Server

One owner per server. Each agent is a `buzz-acp` child process under its own
uid, started from the server's state and restarted when it exits. The server
implements the [Server API](../plugin/README.md#server-api) and serves the
plugin. It has no dependencies beyond Node and no Docker socket.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `OWNER_PUBKEY` | yes | Your pubkey, 64 lowercase hex. The only account that can activate an agent or start a turn |
| `RELAY_URL` | for `/v1` | The relay every agent uses. Creating an agent for any other community is refused |
| `V1_TOKEN` | for `/v1` | Bearer token for the Server API. Unset turns `/v1` off |
| `PUBLIC_ORIGIN` | no | This server's `https://` origin. Turns on `/plugin/install` |
| `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` | for Claude agents | Passed to Claude agents only. The OAuth token wins when both are set; never both reach an agent |
| `XAI_API_KEY` | no | Passed to Grok agents only. Without it, sign each Grok agent in once with `grok login --device-auth` as that agent |
| `ANTHROPIC_BASE_URL`, `GROK_BASE_URL` | no | Where each harness sends model traffic |
| `HOOKS` | no | Path to a hooks module, below |
| `AGENTS_DIR` | no | Default `/agents`: state, archive, and each agent's `home` and `workspace` |
| `AGENT_UID_BASE` | no | Default `10001`: the first agent uid |
| `PORT` | no | Default `8090` |

## Who can start a turn

Every agent runs with `BUZZ_ACP_RESPOND_TO=owner-only`, and
`BUZZ_ACP_ALLOWED_RESPOND_TO=owner-only` makes buzz-acp refuse any other
mode. A turn starts only on an event from `OWNER_PUBKEY`, or from another
agent the same owner attested (NIP-OA). Mentions and DMs from anyone else
start nothing. Their messages can still reach an agent as thread context
when you start a turn in a shared thread.

## Isolation

- **One uid per agent**, from `AGENT_UID_BASE` up, kept in `state.json` and
  reserved while the agent is archived. An agent's `home`, `workspace` and
  `tmp` under `AGENTS_DIR/<slug>` are its own, mode 0700; `TMPDIR` points at
  that `tmp`, never at the shared `/tmp`.
- **State is root's.** `state.json` and the archive hold every agent's key at
  mode 0600; no agent can read them.
- **No privilege back.** The server starts each agent with `setpriv`, with
  supplementary groups cleared unless a hook adds some. Run the container
  with `no-new-privileges` and only the capabilities in
  `deploy/compose.example.yml`.

## Hooks

`HOOKS` names a module that exports `(api) => hooks`. It runs inside the
server, as root, and is trusted like the server itself. **Keep secrets out of
the file**: agents run in the same container and can read it unless it is
mounted root-only (0700 dir, 0600 file). Read secrets from the server's env
instead. `api` has `list()`,
`restart(pubkey)`, `stop(pubkey)` and `agentsDir`. Every hook is optional:

| Hook | When | Returns |
|---|---|---|
| `beforeStart(agent)` | Before every start | `{env, files, groups}`. `env` adds variables, and may replace a credential or upstream, never identity, owner or the turn gate. `files` maps paths under the agent's home to contents, written as the agent. `groups` are extra gids |
| `routes(req, res)` | Before every built-in route | `true` when it answered. A hook route brings its own auth |
| `onCreate(agent)`, `onRemove(agent)` | After a create or a remove | nothing |

`agent` is the saved record without its key, plus `pubkey`, `slug` and
`harness`. Key per-agent settings on `pubkey`: names change on rename. See
`deploy/hooks.example.js`.
