# buzz-remote-agents server image: the server, the plugin it serves, buzz-acp
# and the buzz CLI built from source, and two harnesses: Claude Code (through
# its ACP adapter) and Grok Build. Build from the repository root:
#   docker build -f image/Dockerfile -t buzz-remote-agents .
# amd64 only: Grok Build ships as an amd64 binary.
ARG BUZZ_REF=desktop-v0.5.28

# Rust 1.95 to match Buzz's rust-toolchain.toml at desktop-v0.5.28.
FROM rust:1.95-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential git pkg-config libssl-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG BUZZ_REF
WORKDIR /build
RUN git clone --depth 1 --branch "${BUZZ_REF}" https://github.com/block/buzz .
# buzz-acp drives each agent; buzz (the CLI) publishes agent profiles and is
# what agents use to talk to the relay.
RUN cargo build --release --locked -p buzz-acp -p buzz-cli --bin buzz-acp --bin buzz \
    && strip target/release/buzz-acp target/release/buzz

FROM node:24.22.2-bookworm-slim
# Agents do real work here: shell tooling, python, build tools, ssh git
# remotes, plus the Chromium runtime libs and fonts for browser tools, and
# bubblewrap for Claude Code's own sandbox. util-linux brings setpriv, which
# the server uses to start each agent as its own uid.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libssl3 git tini util-linux \
      curl jq ripgrep less procps unzip openssh-client \
      build-essential python3 python3-pip python3-venv \
      tmux bubblewrap \
      libglib2.0-0 libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 \
      libcups2 libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libcairo2 libpango-1.0-0 libasound2 \
      fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
# Claude Code's ACP adapter, pinned. It decides which BUZZ_ACP_MODEL strings
# are accepted, and an unknown one silently falls back rather than failing, so
# a floating adapter could change agent behaviour with nothing in the diff.
# Held at 0.94.0: from 0.95.0 the adapter validates protocolVersion 2 against
# the real v2 schema, which wants `info` where buzz-acp (desktop-v0.5.28) sends
# `clientInfo`, and every agent fails to start with -32602 Invalid params.
# Don't bump it until Buzz fixes that upstream.
ARG ACP_VERSION=0.94.0
RUN npm install -g "@agentclientprotocol/claude-agent-acp@${ACP_VERSION}" @anthropic-ai/claude-code
# Two Claude Code binaries ship: the global CLI, and the adapter's bundled SDK
# binary, which is the one buzz-acp runs (pinned through ACP_VERSION).
RUN claude --version \
    && "$(npm root -g)/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude" --version
# Grok Build speaks ACP natively (`grok agent stdio`). Fetched as the static
# binary the official installer would fetch, without the installer, which
# checks no checksum and defaults to "latest". Bump version and checksum
# together, from https://x.ai/cli/stable.
ARG GROK_VERSION=1.0.70
ARG GROK_SHA256=22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9
RUN curl -fsSL --connect-timeout 10 -o /usr/local/bin/grok \
      "https://x.ai/cli/grok-${GROK_VERSION}-linux-x86_64" \
    && echo "${GROK_SHA256}  /usr/local/bin/grok" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/grok \
    && grok --version
COPY --from=builder /build/target/release/buzz-acp /usr/local/bin/buzz-acp
COPY --from=builder /build/target/release/buzz /usr/local/bin/buzz
COPY server/ /app/server/
COPY plugin/ /app/plugin/
# Root on purpose: the server needs it to give each agent its own uid, and
# drops it for every agent it starts.
ENTRYPOINT ["tini", "--", "node", "/app/server/server.js"]
