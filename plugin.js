// Remote agents: a hosted agent type for Buzz whose agents run on your own
// server. The server makes and keeps each agent's key; this plugin only calls
// its HTTP API (README.md, "Server API") with the URL and token from
// ~/.config/buzz-remote-agents/config.json.

export const inject = ["agents", "host", "react", "relay"];

const CONFIG_PATH = "~/.config/buzz-remote-agents/config.json";

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const relay = ctx.relay;

  // Read on every call, so editing the file needs no reload.
  async function settings() {
    if (!ctx.host.readFile) throw new Error("Remote agents needs the Buzz desktop app.");
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await ctx.host.readFile(CONFIG_PATH)));
    } catch (error) {
      throw new Error(`Could not read ${CONFIG_PATH}: ${error.message}`);
    }
    if (typeof parsed?.url !== "string" || typeof parsed?.token !== "string" || !parsed.token)
      throw new Error(`${CONFIG_PATH} needs "url" and "token".`);
    return { url: parsed.url.replace(/\/+$/, ""), token: parsed.token };
  }

  async function call(method, path, body, signal) {
    signal?.throwIfAborted();
    const { url, token } = await settings();
    const response = await ctx.host.request({
      url: `${url}${path}`,
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try {
      data = response.body ? JSON.parse(response.body) : {};
    } catch {
      data = {};
    }
    if (response.status < 200 || response.status >= 300)
      throw new Error(data.error || `The server answered ${response.status}.`);
    return data;
  }

  const agentPath = (pubkey) => `/v1/agents/${encodeURIComponent(pubkey)}`;

  // The relay session, while connected.
  function useSession() {
    return React.useSyncExternalStore(relay.subscribe, () => {
      const snapshot = relay.snapshot();
      return snapshot.status === "ready" ? snapshot.session : undefined;
    });
  }

  // Keep the owner's activity feed live while this plugin runs, the same way
  // the Agent Activity plugin does; the leases are counted, so both can hold one.
  ctx.effect(() => {
    let session;
    let release;
    const bind = () => {
      const snapshot = relay.snapshot();
      const next = snapshot.status === "ready" ? snapshot.session : undefined;
      if (next === session) return;
      release?.();
      session = next;
      release = next?.agentActivity?.activate();
    };
    const stop = relay.subscribe(bind);
    bind();
    return () => {
      stop();
      release?.();
    };
  });

  const note = (text) => h("p", { className: "text-secondary" }, text);

  // Create form: optionally take over an agent the server already runs.
  function Create({ config, onChange, disabled }) {
    const [state, setState] = React.useState({ agents: [], error: "" });
    React.useEffect(() => {
      let live = true;
      call("GET", "/v1/agents").then(
        (agents) => live && setState({ agents: Array.isArray(agents) ? agents : [], error: "" }),
        (error) => live && setState({ agents: [], error: error.message }),
      );
      return () => {
        live = false;
      };
    }, []);
    return h(
      "label",
      { style: { display: "grid", gap: "var(--space-2)" } },
      "Existing agent",
      h(
        "select",
        {
          value: config.adopt ?? "",
          disabled,
          onChange: (event) =>
            onChange(event.target.value ? { adopt: event.target.value } : {}),
        },
        h("option", { value: "" }, "None: make a new agent"),
        ...state.agents.map((agent) =>
          h("option", { key: agent.pubkey, value: agent.pubkey }, agent.name || agent.pubkey.slice(0, 8)),
        ),
      ),
      state.error ? note(state.error) : note("Pick one to manage an agent your server already runs. Its key stays there."),
    );
  }

  function Instructions({ agent }) {
    const [state, setState] = React.useState({ text: undefined, error: "" });
    React.useEffect(() => {
      let live = true;
      call("GET", `${agentPath(agent.pubkey)}/instructions`).then(
        (data) => live && setState({ text: data.instructions ?? "", error: "" }),
        (error) => live && setState({ text: undefined, error: error.message }),
      );
      return () => {
        live = false;
      };
    }, [agent.pubkey]);
    if (state.error) return note(state.error);
    if (state.text === undefined) return note("Loading…");
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-2)" } },
      note("Read-only. Change them on the server."),
      h("pre", { style: { whiteSpace: "pre-wrap", margin: 0 } }, state.text || "No instructions."),
    );
  }

  function Activity({ agent }) {
    const session = useSession();
    const activity = session?.agentActivity;
    const empty = React.useMemo(() => ({ status: "unavailable", records: [], turns: [] }), []);
    const snapshot = React.useSyncExternalStore(
      activity?.subscribe ?? noSubscribe,
      activity?.snapshot ?? (() => empty),
    );
    const turns = React.useMemo(() => transcript(snapshot.records, agent.pubkey), [snapshot.records, agent.pubkey]);
    if (!activity) return note("Activity shows once Buzz is connected.");
    if (snapshot.status === "unavailable") return note("Activity isn't available here.");
    if (!turns.length)
      return note(
        snapshot.status === "connecting"
          ? "Connecting to the live feed…"
          : "No turns yet. Turns show as they happen while Buzz is open.",
      );
    return h(
      "div",
      { style: { display: "grid", gap: "var(--space-3, 12px)" } },
      note("Turns captured while Buzz has been open, newest first."),
      ...turns.map((turn) =>
        h(
          "section",
          { key: turn.turnId, className: "ui-card", style: { padding: "var(--space-panel-inset, 12px)" } },
          h("strong", null, `${new Date(turn.startedAt).toLocaleTimeString()} · ${turn.state}`),
          ...turn.items.map((item, index) =>
            item.type === "tool"
              ? h("p", { key: index, className: "text-secondary" }, `${item.title || "Tool"} · ${item.status || "pending"}`)
              : h("p", { key: index, style: { whiteSpace: "pre-wrap" } }, item.text),
          ),
        ),
      ),
    );
  }

  ctx.agents.register({
    id: "remote",
    title: "Remote",
    description: "Runs on your own server, which keeps the agent's key.",
    defaults: () => ({ config: {} }),
    Create,
    tabs: [
      { id: "activity", title: "Activity", role: "activity", component: Activity },
      { id: "instructions", title: "Instructions", component: Instructions },
    ],
    remote: {
      async provision({ name, picture, community, config, signal }) {
        const adopt = typeof config?.adopt === "string" && config.adopt ? config.adopt : undefined;
        const { pubkey } = await call(
          "POST",
          "/v1/agents",
          adopt ? { adopt } : { name, community, ...(picture ? { picture } : {}) },
          signal,
        );
        return { pubkey };
      },
      async activate({ pubkey, name, community, auth, signal }) {
        await call("POST", `${agentPath(pubkey)}/activate`, { auth, name, community }, signal);
      },
      async profile({ pubkey, name, picture, signal }) {
        await call("PUT", `${agentPath(pubkey)}/profile`, { name, ...(picture ? { picture } : {}) }, signal);
      },
      async remove({ pubkey, signal }) {
        await call("DELETE", agentPath(pubkey), undefined, signal);
      },
    },
  });
}

const noSubscribe = () => () => {};

// A small reading of the owner-only observer frames: each turn's messages and
// tool calls. Frames are a single event or a {kind: "batch"} envelope.
function transcript(records, pubkey) {
  const turns = new Map();
  for (const record of records) {
    if (record.agent !== pubkey) continue;
    let raw;
    try {
      raw = JSON.parse(record.plaintext);
    } catch {
      continue;
    }
    const events = raw?.kind === "batch" && Array.isArray(raw.payload?.events) ? raw.payload.events : [raw];
    for (const event of events) {
      if (!event || typeof event.turnId !== "string") continue;
      let turn = turns.get(event.turnId);
      if (!turn) {
        turn = { turnId: event.turnId, startedAt: record.createdAt * 1000, state: "working", items: [], tools: new Map() };
        turns.set(event.turnId, turn);
      }
      if (event.kind === "turn_completed") turn.state = "ended";
      else if (event.kind === "turn_error" || event.kind === "agent_panic") turn.state = "error";
      if (event.kind !== "acp_read" || event.payload?.method !== "session/update") continue;
      const update = event.payload?.params?.update ?? {};
      if (update.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
        const last = turn.items[turn.items.length - 1];
        if (last?.type === "message") last.text += update.content.text;
        else turn.items.push({ type: "message", text: update.content.text });
      } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        if (typeof update.toolCallId !== "string") continue;
        let tool = turn.tools.get(update.toolCallId);
        if (!tool) {
          tool = { type: "tool", title: "", status: "" };
          turn.tools.set(update.toolCallId, tool);
          turn.items.push(tool);
        }
        if (typeof update.title === "string") tool.title = update.title;
        if (typeof update.status === "string") tool.status = update.status;
      }
    }
  }
  return [...turns.values()].sort((a, b) => b.startedAt - a.startedAt);
}
