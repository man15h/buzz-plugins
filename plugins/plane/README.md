# Plane

Follow and move your cards from a self-hosted [Plane](https://plane.so)
workspace without leaving Buzz. You get a board page in the left dock, and
Plane card links in channels with a **Move** menu and a side panel. Click a
card on the board to see its details and move it there. It uses your own API
key, so it sees and moves only what you can in Plane.

## Getting started

1. Install the plugin (below), then open **Settings → Plugins → Plane**.
2. Create an API token in Plane and paste it into **API key**.
3. Type your **Workspace** slug (the part after the server in your Plane URLs)
   and choose **Save**.

The line at the top of the card says where things stand: connected as you,
not connected, key refused, unknown workspace, or server unreachable (with
**Try again**).

---

## Install

The manifest has to name your Plane server's exact origin, so install from a
local folder rather than from this repository's URL, unless a server serves
the plugin to you with its origin already stamped in.

1. Clone this repository. The plugin is the `plugins/plane/` folder.
2. Replace `https://plane.example.com` with your Plane origin (scheme and
   host, plus the port if it has one, with no path and no trailing slash) in
   two places: `host.networkOrigins` in `manifest.json`, and `SERVER` at the
   top of `plugin.js`.
3. In Buzz: **Settings → Plugins → Manage plugins → Add**, then **Browse**
   under Add from folder, and pick the clone's `plugins/plane/` folder.
   Review the access it asks for (your Plane origin, and the `security`
   commands below) and install it.

### Updating

Run `git pull` in the clone, then choose **Update** for the plugin in Settings →
Plugins. Your two origin edits stay unless the same lines changed upstream. If
they did, put your origin back before updating.

## Your key

The key is kept in this Mac's login Keychain, as a generic password with
service `buzz-plane` and account `api-key`. The plugin reads, saves and
deletes it with macOS's `security` tool, which is why the manifest asks to run
it. Unlike Buzz's built-in Keychain storage, any program running as you can
read that item with `security`, the same as any other item you create there.
**Replace** and **Remove** on the Settings card change or forget it.

## Limits

- Plane allows an API key 60 calls a minute, so lists are reused for a
  minute. The board refreshes when you choose **Refresh** or move a card.
- Cancelled cards are left off the board.
- macOS only, because of the Keychain.

## Files

- `plugin.js`: the plugin. Plain JavaScript, no build step.
- `manifest.json`: the plugin manifest, with a placeholder origin.
