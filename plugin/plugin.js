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
      ...turns.map((turn) => h(Turn, { key: turn.turnId, turn })),
    );
  }

  // Tabler outline paths, the icon set Buzz itself uses.
  function icon(name, size = 16, style) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        className: name === "loader-2" ? "animate-spin" : undefined,
        style: { flexShrink: 0, ...style },
      },
      ...ICONS[name].map((d) => h("path", { key: d, d })),
    );
  }

  function Turn({ turn }) {
    const [label, name, color] = pick(STATES, turn.state, "working");
    return h(
      "section",
      {
        className: "ui-card",
        style: { display: "grid", gap: "var(--space-2, 8px)", padding: "var(--space-panel-inset, 12px)" },
      },
      h(
        "header",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2, 8px)",
            paddingBottom: "var(--space-2, 8px)",
            borderBottom: "1px solid var(--border)",
          },
        },
        h(
          "span",
          { style: { display: "inline-flex", alignItems: "center", gap: "6px", fontWeight: 500, color } },
          icon(name),
          label,
        ),
        h(
          "time",
          { style: { marginLeft: "auto", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" } },
          new Date(turn.startedAt).toLocaleTimeString(),
        ),
      ),
      ...turn.items.map((item, index) =>
        item.type === "tool"
          ? h(Tool, { key: index, item })
          : h("p", { key: index, style: { margin: 0, whiteSpace: "pre-wrap" } }, item.text),
      ),
    );
  }

  // One tool call: kind icon, title clamped to two lines, status chip. A
  // clamped row expands on click.
  function Tool({ item }) {
    const [open, setOpen] = React.useState(false);
    const [clamped, setClamped] = React.useState(false);
    const title = React.useRef(null);
    React.useLayoutEffect(() => {
      const node = title.current;
      if (!node || open) return;
      const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }, [item.title, open]);
    const failed = item.status === "failed";
    const [label, name] = pick(STATUS, item.status, "pending");
    const toggle = () => setOpen((value) => !value);
    const expandable = clamped || open;
    return h(
      "div",
      {
        ...(expandable
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": open,
              onClick: toggle,
              onKeyDown: (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                toggle();
              },
            }
          : {}),
        style: {
          display: "grid",
          gridTemplateColumns: "16px minmax(0, 1fr) auto",
          columnGap: "var(--space-2, 8px)",
          alignItems: "start",
          color: failed ? "var(--text-danger)" : "var(--text-secondary)",
          cursor: expandable ? "pointer" : undefined,
        },
      },
      icon(pick(KINDS, item.kind, "other"), 16, { marginTop: "2px" }),
      h(
        "span",
        {
          ref: title,
          style: {
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.78125rem",
            lineHeight: "1.25rem",
            color: failed ? "var(--text-danger)" : "var(--text-primary)",
            overflowWrap: "anywhere",
            ...(open
              ? { whiteSpace: "pre-wrap" }
              : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden" }),
          },
        },
        item.title || "Tool",
      ),
      h(
        "span",
        {
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            height: "20px",
            padding: "0 8px 0 6px",
            borderRadius: "var(--radius-chip, 0.75rem)",
            background: failed ? "var(--affordance-danger)" : "var(--affordance-subtle)",
            boxShadow: failed ? "inset 0 0 0 1px var(--border-danger)" : undefined,
            color: failed ? "var(--text-danger)" : "var(--text-secondary)",
            fontSize: "0.75rem",
            fontWeight: 500,
            whiteSpace: "nowrap",
          },
        },
        icon(name, 12),
        label,
      ),
      expandable &&
        h(
          "span",
          {
            style: {
              gridColumn: 2,
              justifySelf: "start",
              fontSize: "0.75rem",
              fontWeight: 500,
              textDecoration: "underline",
              textUnderlineOffset: "2px",
              color: "var(--text-secondary)",
            },
          },
          open ? "Show less" : "Show more",
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

// ACP tool kinds; anything else, or no kind, shows as "other".
const KINDS = {
  execute: "terminal-2",
  fetch: "world",
  read: "file-text",
  edit: "pencil",
  search: "search",
  think: "bulb",
  delete: "trash",
  move: "arrows-move",
  other: "tool",
};
const STATUS = {
  pending: ["Pending", "clock-hour-4"],
  in_progress: ["Running", "loader-2"],
  completed: ["Done", "circle-check"],
  failed: ["Failed", "circle-x"],
};
const STATES = {
  working: ["Working", "loader-2", "var(--text-primary)"],
  ended: ["Ended", "circle-check", "var(--text-secondary)"],
  error: ["Error", "circle-x", "var(--text-danger)"],
};
// Own keys only: kind and status come from the agent.
const pick = (table, key, fallback) => table[Object.hasOwn(table, key) ? key : fallback];
// From @tabler/icons 3.46.0 (MIT), outline.
const ICONS = {
  "terminal-2": ["M8 9l3 3l-3 3", "M13 15l3 0", "M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12"],
  world: ["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M3.6 9h16.8", "M3.6 15h16.8", "M11.5 3a17 17 0 0 0 0 18", "M12.5 3a17 17 0 0 1 0 18"],
  "file-text": ["M14 3v4a1 1 0 0 0 1 1h4", "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2", "M9 9l1 0", "M9 13l6 0", "M9 17l6 0"],
  pencil: ["M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4", "M13.5 6.5l4 4"],
  search: ["M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0", "M21 21l-6 -6"],
  bulb: ["M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7", "M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3", "M9.7 17l4.6 0"],
  trash: ["M4 7l16 0", "M10 11l0 6", "M14 11l0 6", "M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12", "M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"],
  "arrows-move": ["M18 9l3 3l-3 3", "M15 12h6", "M6 9l-3 3l3 3", "M3 12h6", "M9 18l3 3l3 -3", "M12 15v6", "M15 6l-3 -3l-3 3", "M12 3v6"],
  tool: ["M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5"],
  "clock-hour-4": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M12 12l3 2", "M12 7v5"],
  "loader-2": ["M12 3a9 9 0 1 0 9 9"],
  "circle-check": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M9 12l2 2l4 -4"],
  "circle-x": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M10 10l4 4m0 -4l-4 4"],
};

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
          tool = { type: "tool", kind: "", title: "", status: "" };
          turn.tools.set(update.toolCallId, tool);
          turn.items.push(tool);
        }
        if (typeof update.kind === "string") tool.kind = update.kind;
        if (typeof update.title === "string") tool.title = update.title;
        if (typeof update.status === "string") tool.status = update.status;
      }
    }
  }
  return [...turns.values()].sort((a, b) => b.startedAt - a.startedAt);
}
