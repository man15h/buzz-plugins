# buzz-remote-agents

A Buzz desktop plugin that adds a **Remote** agent type: agents that run on
your own server instead of on your computer or a hosted provider. The server
makes and keeps each agent's key. Buzz never sees it.

With the plugin installed you can, from Buzz's Agents page:

- create a Remote agent, or take over one your server already runs;
- rename it and change its picture;
- read its instructions (read-only) and watch its turns on the Activity tab;
- delete it.

You need a server that implements the [Server API](#server-api) below.

## Install

The manifest has to name your server's exact origin, so install from a local
folder rather than from this repository's URL.

1. Clone this repository.
2. In `manifest.json`, replace `https://deployer.example.com` in
   `host.networkOrigins` with your server's origin: scheme and host, plus the
   port if it has one, with no path and no trailing slash.
3. Create `~/.config/buzz-remote-agents/config.json` from
   `config.example.json`, with your server's URL and token, and make it
   readable only by you:
   ```sh
   mkdir -p ~/.config/buzz-remote-agents
   cp config.example.json ~/.config/buzz-remote-agents/config.json
   chmod 600 ~/.config/buzz-remote-agents/config.json
   ```
4. In Buzz: **Settings → Plugins → Manage plugins → Add**, then **Browse**
   under Add from folder, and pick the clone. Review the access it asks for
   (your server's origin, and file reading for the config) and install it.

The plugin reads the config file on every call, so a new token needs no
reinstall.

### Updating

Run `git pull` in the clone, then choose **Update** for the plugin in Settings →
Plugins. Your `networkOrigins` edit stays unless the same line changed
upstream. If it did, put your origin back before updating.

## Using it

- **New agent:** Agents → New agent → Harness → **Remote**. Leave **Existing
  agent** on "None". If your server needs the agent admitted to the community
  first, do that before Buzz finishes setting it up. Buzz retries until it
  succeeds.
- **An agent your server already runs:** pick it under **Existing agent**.
  Buzz signs a fresh owner attestation for it. The server may restart it once
  to pick that up.
- **Activity:** works best with the Agent Activity plugin on as well. It shows
  only turns that happened while Buzz was open.
- **Not available:** stopping a single turn, and editing instructions from
  Buzz.

### Moving agents from another app

If the agents you take over were also managed by another app, such as an
older Buzz with a server backend, **stop editing them there once they're
moved.** A save from the other app can overwrite the agent's state on the
server.

Buzz refuses to take over an agent if your account already has an agent
record for it (kind 30177) from an older app: "The provider returned a key
that is already in use". Delete that old record first.

## Server API

JSON over HTTPS, with `Authorization: Bearer <token>` on every call. An error
is any non-2xx status with `{"error": "<message>"}`, which Buzz shows. Every
call may be retried, so each one must be safe to repeat. **No response may
contain a private key.**

| Call | Request | Response | Must |
|---|---|---|---|
| `GET /v1/agents` | | `[{pubkey, name}]` | List the agents that can be taken over |
| `POST /v1/agents` | `{name, community, picture?}` | `{pubkey}` | Make a new key on the server and keep the agent stopped. `community` is a `wss://` URL |
| `POST /v1/agents` | `{adopt: pubkey}` | `{pubkey}` | Return that existing agent's pubkey, or 404 if unknown |
| `POST /v1/agents/{pubkey}/activate` | `{auth, name, community}` | `{}` | `auth` is a NIP-OA tag, `["auth", ownerPubkey, "", signature]`. Accept it only for your configured owner, attach it to what the agent signs, publish its profile, and start it |
| `PUT /v1/agents/{pubkey}/profile` | `{name, picture?}` | `{}` | Publish the agent's kind 0, signed with its key |
| `GET /v1/agents/{pubkey}/instructions` | | `{instructions}` | Return its system prompt |
| `DELETE /v1/agents/{pubkey}` | | `{}` | Stop it. An unknown agent counts as removed. Keeping the key archived rather than deleting it is recommended |

`pubkey` is 64 lowercase hex characters. `picture` is an HTTPS image URL.

### Token scope

The token sits in a file on the owner's computer, so give it the least
reach: no route that returns a key, edits a prompt, or starts an agent for
anyone other than the configured owner.

## Files

- `plugin.js`: the plugin. Plain JavaScript, no build step.
- `manifest.json`: the plugin manifest, with a placeholder origin.
- `config.example.json`: the shape of `~/.config/buzz-remote-agents/config.json`.
