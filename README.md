# buzz-remote-agents

Run Buzz agents on your own server. The server makes and keeps each agent's
key; Buzz never sees it. A Buzz desktop plugin adds a **Remote** agent type
to create, rename and remove them.

| Folder | What it is |
|---|---|
| [`plugin/`](plugin/README.md) | The Buzz desktop plugin, and the Server API it calls |
| [`server/`](server/README.md) | The server: one owner, one agent process per agent, each under its own uid |
| `image/` | The server's Docker image: the server, buzz-acp, the buzz CLI, Claude Code and Grok Build |
| `deploy/` | A compose example and an example hooks module |

Harnesses: **Claude Code** and **Grok Build**.

## Quick start

```sh
docker build -f image/Dockerfile -t buzz-remote-agents .
cp deploy/compose.example.yml compose.yml   # then fill in a .env
docker compose up -d
```

Put TLS in front of port 8090, then open `https://<your server>/plugin/install`
to install the plugin preconfigured for it.
