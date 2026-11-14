// Remote agents: a hosted agent type for Buzz whose agents run on your own
// server. The server makes and keeps each agent's key; this plugin only calls
// its HTTP API (README.md, "Server API") with the URL and token from
// ~/.config/buzz-remote-agents/config.json.
//
// The Activity tab's transcript (Activity through Tool, and
// activityTranscript with its helpers and CSS) is ported from buzz-app
// b495765cb2f8e22356541f881b1af91413190a11: src/features/agents/
// activity-transcript.ts, ActivityTranscript.tsx and
// ActivityTranscript.module.css, licensed Apache-2.0 (LICENSE-Apache-2.0
// here). Changed: plain JS with no imports, prefixed class names, replies as
// plain text instead of Markdown, initials instead of avatars, turns newest
// first as labelled cards with running ones on top, and inside a turn the
// steps after the request and plan newest first.

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

  function Activity({ agent, openConversation }) {
    const session = useSession();
    const activity = session?.agentActivity;
    const empty = React.useMemo(() => ({ status: "unavailable", records: [], turns: [] }), []);
    const snapshot = React.useSyncExternalStore(
      activity?.subscribe ?? noSubscribe,
      activity?.snapshot ?? (() => empty),
    );
    const turns = React.useMemo(
      () => activityTranscript(snapshot.records, agent.pubkey).reverse(),
      [snapshot.records, agent.pubkey],
    );
    // The feed's live state per turn, for turns whose end isn't loaded.
    const states = React.useMemo(
      () =>
        new Map(
          (snapshot.turns ?? []).filter((turn) => turn.agent === agent.pubkey).map((turn) => [turn.turnId, turn.state]),
        ),
      [snapshot.turns, agent.pubkey],
    );
    // Running turns sort by start, newest first, so cards hold still as
    // steps land. Only the top one starts open.
    const live = turns.filter((turn) => !turn.endedAt && states.get(turn.turnId) === "working");
    const ended = turns.filter((turn) => !live.includes(turn));
    const [toggled, setToggled] = React.useState(() => new Map());
    const now = useClock(live.length > 0);
    const channels = useChannels(session);
    if (!activity) return note("Activity shows once Buzz is connected.");
    if (snapshot.status === "unavailable") return note("Activity isn't available here.");
    if (!turns.length)
      return note(
        snapshot.status === "connecting"
          ? "Connecting to the live feed…"
          : "No turns yet. Turns show as they happen while Buzz is open.",
      );
    const card = (turn) =>
      h(
        React.Fragment,
        { key: turn.turnId },
        h(Turn, {
          turn,
          state: turn.endedAt ? "ended" : (states.get(turn.turnId) ?? "unknown"),
          agentName: agent.name || "Agent",
          openConversation,
          session,
          channel: channels.get(turn.channelId),
          now,
          open: toggled.get(turn.turnId) ?? turn === live[0],
          onToggle: (open) => setToggled((previous) => new Map(previous).set(turn.turnId, open)),
        }),
        // Below its turn: newest first, the session began before it.
        turn.newSession && h("p", { className: "text-body rat-session" }, "New session"),
      );
    return h(
      "div",
      { className: "text-body rat-timeline" },
      h("style", null, CSS),
      note("Turns captured while Buzz has been open. Running ones first, newest first."),
      live.length > 0 && h("h3", { className: "text-caption rat-group" }, `${live.length} running`),
      ...live.map(card),
      ended.length > 0 && live.length > 0 && h("h3", { className: "text-caption rat-group" }, "Ended"),
      ...ended.map(card),
    );
  }

  // A second clock for running cards' elapsed time, only while one runs.
  function useClock(running) {
    const [now, setNow] = React.useState(() => Date.now());
    React.useEffect(() => {
      if (!running) return;
      setNow(Date.now());
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, [running]);
    return now;
  }

  // The viewer's channels by id, for card labels.
  function useChannels(session) {
    const queries = session?.channels;
    const list = React.useSyncExternalStore(
      queries?.subscribeList ?? noSubscribe,
      queries?.list ?? noChannels,
    );
    return React.useMemo(() => new Map((list.channels ?? []).map((channel) => [channel.id, channel])), [list]);
  }

  // The first line of a thread's root message. Frames carry only the root's
  // id, so read it once through a short-lived exact view, as Buzz's link
  // previews do, and keep the line for the session.
  function useRootLine(session, channelId, rootId) {
    const key = `${channelId}:${rootId}`;
    const [text, setText] = React.useState(() => rootLines.get(key));
    React.useEffect(() => {
      if (!session?.thread || !channelId || !rootId) return;
      if (rootLines.has(key)) {
        setText(rootLines.get(key));
        return;
      }
      let view;
      try {
        view = session.thread(channelId, rootId, { exact: true });
      } catch {
        return; // No view capacity or no access: the prompt's line stands.
      }
      let done = false;
      let stop;
      const read = () => {
        const snapshot = view.snapshot();
        const message = snapshot.target ?? snapshot.root;
        if (done || !message) return;
        done = true;
        rootLines.set(key, line(message.content));
        setText(rootLines.get(key));
        stop();
        view.dispose();
      };
      stop = view.subscribe(read);
      view.refresh().catch(() => {});
      read();
      return () => {
        if (done) return;
        stop();
        view.dispose();
      };
    }, [session, channelId, rootId, key]);
    return text;
  }

  // Tabler outline paths, the icon set Buzz itself uses.
  function icon(name, size = 16, props) {
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
        ...props,
      },
      ...ICONS[name].map((d) => h("path", { key: d, d })),
    );
  }

  // Quiet trailing metadata: a tool's duration, and the time.
  function Stamp({ item }) {
    const elapsed = item.type === "tool" && item.completedAt !== undefined ? item.completedAt - item.at : undefined;
    if (item.type === "prompt" || (!known(item.at) && elapsed === undefined)) return null;
    return h(
      "span",
      { className: "text-body rat-at" },
      elapsed !== undefined && h("span", null, duration(elapsed)),
      elapsed !== undefined &&
        known(item.at) &&
        h("span", { className: "text-caption rat-metaSeparator", "aria-hidden": true }, "•"),
      known(item.at) && h("time", { dateTime: new Date(item.at).toISOString(), title: fullTime(item.at) }, time(item.at)),
    );
  }

  // One turn as a card. The header names its state, channel and thread, and
  // opens or folds it. Open, the request, system prompt and plan stay first
  // and the steps after them run newest first. Folded, a running turn shows
  // its latest step and a failed one its error.
  function Turn({ turn, state, agentName, openConversation, session, channel, now, open, onToggle }) {
    const { channelId, threadRootId } = turn;
    const openPlace =
      openConversation && channelId && threadRootId !== undefined
        ? () => openConversation(channelId, threadRootId ?? undefined)
        : undefined;
    const status =
      turn.error || turn.outcome === "error"
        ? "Failed"
        : turn.outcome === "stopped"
          ? "Stopped"
          : turn.outcome === "unknown"
            ? "Status unknown"
            : turn.outcome === "ended"
              ? "Completed"
              : state === "working"
                ? "Working"
                : turn.endedAt
                  ? "Completed"
                  : "Status unknown";
    const tone =
      status === "Failed" ? "failed" : status === "Completed" ? "completed" : status === "Working" ? "working" : "unknown";
    const pinned = [];
    const steps = [];
    for (const item of turn.items)
      (item.type === "system" || item.type === "plan" || (item.type === "prompt" && !item.steer) ? pinned : steps).push(
        item,
      );
    steps.reverse();
    const entry = (item) => h(Entry, { key: item.id, item, agentName });
    const request = pinned.find((item) => item.type === "prompt");
    const rootLine = useRootLine(session, channelId, threadRootId);
    // A thread's root, else the request: a top-level mention is its own root.
    const subjectLine = rootLine || (request ? line(request.text) : "");
    const place = channel ? (channel.hidden ? channel.name : `#${channel.name}`) : channelId ? "Channel" : "";
    const meta = turn.endedAt
      ? `${duration(turn.endedAt - turn.startedAt)} · ${time(turn.endedAt)}`
      : known(turn.startedAt) && state === "working"
        ? duration(Math.max(0, now - turn.startedAt))
        : "";
    const error =
      turn.error &&
      h("p", { role: "note", className: "rat-row rat-error" }, icon("alert-circle"), h("span", { className: "rat-text" }, turn.error));
    return h(
      "article",
      { className: "rat-turn rat-card", "aria-label": known(turn.startedAt) ? `Turn ${time(turn.startedAt)}` : "Turn" },
      h(
        "button",
        {
          type: "button",
          className: "text-body rat-statusRow rat-row rat-cardHeader",
          "data-status": tone,
          "aria-expanded": open,
          onClick: () => onToggle(!open),
        },
        icon(
          { failed: "circle-x", completed: "circle-check", working: "dots" }[tone] ??
            (status === "Stopped" ? "square" : "help-circle"),
        ),
        h("span", { className: "rat-cardState" }, status),
        place && h("span", { className: "rat-cardPlace" }, place),
        subjectLine && h("span", { className: "rat-cardSubject" }, `· ${subjectLine}`),
        meta && h("span", { className: "rat-cardMeta" }, meta),
        icon("chevron-right", 16, { className: "rat-chevron" }),
      ),
      !open && state === "working" && steps.length > 0 && entry(steps[0]),
      !open && error,
      open &&
        openConversation &&
        h(
          "div",
          { className: "text-body text-secondary" },
          openPlace
            ? h(
                "button",
                { type: "button", className: "rat-link", onClick: openPlace },
                turn.threadRootId ? "Open thread" : "Open channel",
              )
            : "Conversation unknown",
        ),
      open && turn.partial && h("p", { className: "text-body text-secondary" }, "The start of this turn isn't loaded."),
      ...(open ? pinned.map(entry) : []),
      open && (steps.length > 0 || turn.error) && h("p", { className: "text-body rat-session" }, "Newest first"),
      open && error,
      ...(open ? steps.map(entry) : []),
    );
  }

  function Entry({ item, agentName }) {
    return h(
      "div",
      { className: "rat-item", "data-type": item.type, title: known(item.at) ? fullTime(item.at) : undefined },
      h(Item, { item, agentName }),
    );
  }

  function Sections({ title, sections }) {
    return h(
      "details",
      { className: "rat-context" },
      h(
        "summary",
        { className: "text-body text-subtle" },
        icon("file-text"),
        h("span", null, `${title} · ${sections.length} sections`),
        icon("chevron-right", 14, { className: "rat-chevron" }),
      ),
      ...sections.map((section, index) =>
        h(
          "section",
          { key: index, className: "rat-codePanel" },
          h("h3", { className: "text-body text-secondary rat-codePanelHeading" }, sectionTitle(section.tag)),
          h("pre", { className: "rat-pre" }, section.body),
        ),
      ),
    );
  }

  // Native disclosure keeps expansion local and stable as streamed items update.
  function Disclosure({ item, icon: glyph, label, preview, metadata, footer, children }) {
    return h(
      "details",
      { className: "rat-tool", "data-status": item.type === "tool" ? item.status : undefined },
      h(
        "summary",
        { className: "rat-row" },
        glyph,
        h("span", { className: "rat-summary" }, label, preview && h("span", { className: "rat-preview" }, ` ${preview}`)),
        metadata,
        icon("chevron-right", 14, { className: "rat-chevron" }),
        h(Stamp, { item }),
      ),
      children && h("div", { className: "rat-toolBody" }, children),
      footer,
    );
  }

  // The host's avatars need its profile lookups; a name's initial stands in.
  const avatar = (name) => h("span", { className: "rat-avatar" }, h("span", null, name.trim().charAt(0).toUpperCase()));
  const subject = (text) => h("span", { className: "rat-subject" }, text);

  function Item({ item, agentName }) {
    switch (item.type) {
      case "system":
        return h(Sections, { title: "System prompt", sections: item.sections });
      case "prompt": {
        const name = item.author || "Request";
        return h(
          Disclosure,
          { item, icon: avatar(name), label: subject(name), preview: line(item.text) },
          h("p", { className: "rat-text" }, item.steer && h("em", null, "(steer) "), item.text),
          item.sections.length > 1 && h(Sections, { title: "Prompt context", sections: item.sections }),
        );
      }
      case "thought": {
        const heading = line(item.text).replace(/^#{1,6}\s+|^\*\*|\*\*$/g, "") || "Thinking";
        const body = item.text.trimStart().split("\n").slice(1).join("\n").trimStart();
        return h(
          Disclosure,
          { item, icon: icon("bulb", 16, { "aria-hidden": undefined, "aria-label": "Thought" }), label: subject(heading) },
          body && h("div", { className: "rat-plain" }, body),
        );
      }
      case "message":
        return h(
          Disclosure,
          {
            item,
            icon: avatar(agentName),
            label: h(
              "span",
              { className: "rat-subject" },
              agentName,
              item.posted && h("span", { className: "text-body text-secondary" }, " · Posted"),
            ),
            preview: line(item.text),
          },
          h("div", { className: "text-message rat-plain" }, item.text),
        );
      case "tool":
        return h(Tool, { item });
      case "plan":
        return h(
          Disclosure,
          { item, icon: icon("list-check"), label: subject("Plan"), preview: `${item.entries.length} steps` },
          h(
            "ul",
            { className: "rat-plan", "aria-label": "Plan" },
            ...item.entries.map((entry, index) =>
              h(
                "li",
                { key: index, "data-status": entry.status },
                `${entry.status === "completed" ? "☑" : "☐"} ${entry.content}`,
              ),
            ),
          ),
        );
      case "status":
        return h(
          Disclosure,
          { item, icon: icon("dots"), label: subject(line(item.text)) },
          h("p", { className: "rat-text" }, item.text),
        );
    }
    return null;
  }

  // One hunk between the unchanged leading and trailing lines.
  function Diff({ diff }) {
    const before = diff.oldText === undefined ? [] : lines(diff.oldText);
    const after = lines(diff.newText);
    let head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    let tail = 0;
    while (
      tail < before.length - head &&
      tail < after.length - head &&
      before[before.length - 1 - tail] === after[after.length - 1 - tail]
    )
      tail++;
    const removed = before.slice(head, before.length - tail);
    const added = after.slice(head, after.length - tail);
    return h(
      "figure",
      { className: "rat-diff" },
      h("figcaption", { className: "text-body text-secondary" }, `${diff.oldText === undefined ? "New file" : "Changed"} ${diff.path}`),
      h(
        "pre",
        { className: "rat-pre" },
        ...removed.map((text, index) => h("span", { key: `-${index}`, className: "rat-removed" }, `- ${text}\n`)),
        ...added.map((text, index) => h("span", { key: `+${index}`, className: "rat-added" }, `+ ${text}\n`)),
      ),
    );
  }

  function ToolInput({ text }) {
    const content = [];
    let end = 0;
    for (const match of text.matchAll(/\btools\.[A-Za-z_$][\w$]*(?=\s*\()/g)) {
      content.push(text.slice(end, match.index), h("span", { key: match.index, className: "text-accent" }, match[0]));
      end = match.index + match[0].length;
    }
    content.push(text.slice(end));
    return h("pre", { className: "rat-pre" }, ...content);
  }

  const panel = (heading, body) =>
    h(
      "section",
      { className: "rat-codePanel" },
      h("h3", { className: "text-body text-secondary rat-codePanelHeading" }, heading),
      body,
    );

  function Tool({ item }) {
    const status = pick(STATUS, item.status, "");
    const path = toolPath(item);
    const label = toolLabel(item);
    return h(
      Disclosure,
      {
        item,
        icon: icon(pick(KINDS, item.kind, "other")),
        label: h(
          React.Fragment,
          null,
          status && h("span", { className: "rat-status" }, `${status} `),
          h("span", { className: "text-body rat-subject" }, label.action),
          label.detail && h("span", { className: "rat-path" }, ` ${label.detail}`),
          path && h("span", { className: "text-body rat-path" }, ` ${path}`),
        ),
        metadata:
          item.permission &&
          h(
            "span",
            {
              className: "text-body text-secondary rat-badge",
              title: `Permission options: ${item.permission.options.join(", ")}`,
            },
            icon("shield", 14),
            item.permission.outcome ?? "Permission requested",
          ),
        footer:
          item.truncated &&
          h("p", { className: "text-body text-secondary" }, "Part of this tool call was too large and was elided by the agent."),
      },
      item.title.includes("\n") && h("pre", { className: "rat-pre" }, item.title),
      item.input && panel("Input", h(ToolInput, { text: item.input })),
      ...item.diffs.map((diff, index) => h(Diff, { key: index, diff })),
      item.output && panel("Output", h("pre", { className: "rat-pre" }, item.output)),
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
const noChannels = () => ({ channels: [] });
// Thread root first lines by "channel:root", kept while the plugin runs.
const rootLines = new Map();

// ACP tool kinds; anything else, or no kind, shows as "other".
const KINDS = {
  execute: "terminal-2",
  read: "eye",
  edit: "pencil",
  delete: "trash",
  move: "pencil",
  search: "search",
  fetch: "world",
  think: "bulb",
  other: "tool",
};
const STATUS = {
  "": "",
  pending: "Pending",
  in_progress: "Running",
  failed: "Failed",
  terminated: "Terminated",
  yielded: "Yielded",
};
const ACTIONS = {
  execute: "Run",
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  fetch: "Fetch",
  think: "Think",
};
// Own keys only: kind and status come from the agent.
const pick = (table, key, fallback) => table[Object.hasOwn(table, key) ? key : fallback];
// From @tabler/icons 3.46.0 (MIT), outline.
const ICONS = {
  "terminal-2": ["M8 9l3 3l-3 3", "M13 15l3 0", "M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12"],
  world: ["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M3.6 9h16.8", "M3.6 15h16.8", "M11.5 3a17 17 0 0 0 0 18", "M12.5 3a17 17 0 0 1 0 18"],
  eye: ["M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0", "M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6"],
  "file-text": ["M14 3v4a1 1 0 0 0 1 1h4", "M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2", "M9 9l1 0", "M9 13l6 0", "M9 17l6 0"],
  pencil: ["M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4", "M13.5 6.5l4 4"],
  search: ["M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0", "M21 21l-6 -6"],
  bulb: ["M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7", "M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3", "M9.7 17l4.6 0"],
  trash: ["M4 7l16 0", "M10 11l0 6", "M14 11l0 6", "M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12", "M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"],
  tool: ["M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5"],
  "circle-check": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M9 12l2 2l4 -4"],
  "circle-x": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M10 10l4 4m0 -4l-4 4"],
  "help-circle": ["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 16v.01", "M12 13a2 2 0 0 0 .914 -3.782a1.98 1.98 0 0 0 -2.414 .483"],
  "alert-circle": ["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 8v4", "M12 16h.01"],
  "chevron-right": ["M9 6l6 6l-6 6"],
  square: ["M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z"],
  dots: ["M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0", "M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"],
  "list-check": ["M3.5 5.5l1.5 1.5l2.5 -2.5", "M3.5 11.5l1.5 1.5l2.5 -2.5", "M3.5 17.5l1.5 1.5l2.5 -2.5", "M11 6l9 0", "M11 12l9 0", "M11 18l9 0"],
  shield: ["M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"],
};

// From here to the end: buzz-app's transcript parser and styles (see the note
// at the top of this file).

// ActivityTranscript.module.css, with its classes prefixed "rat-".
const CSS = `
.rat-timeline { display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; }
.rat-turn { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; width: 100%; max-width: 48rem; margin-inline: auto; }
.rat-session { display: flex; align-items: center; gap: var(--space-3); margin: 0; color: var(--text-subtle); }
.rat-session::before, .rat-session::after { content: ""; flex: 1; border-block-start: 1px solid var(--border-standard); }
.rat-error { color: var(--text-danger); }
.rat-item { min-width: 0; }
.rat-at { display: block; margin: 0; color: var(--text-subtle); font-variant-numeric: tabular-nums; text-align: end; }
.rat-tool > summary > .rat-at { margin-block: 0; margin-inline-start: auto; flex: 1 1 0; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rat-row { display: flex; align-items: center; gap: var(--space-2); min-width: 0; margin: 0; }
.rat-row > svg { flex-shrink: 0; }
.rat-text { margin: 0; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.rat-tool > summary, .rat-context > summary { align-items: center; padding-block: var(--space-1); border-radius: var(--radius-row); transition: background-color var(--duration-state) var(--easing-state); }
@media (hover: hover) and (pointer: fine) {
  .rat-tool > summary:hover, .rat-context > summary:hover { --text-subtle: var(--interaction-row-text); --text-metadata: var(--interaction-row-metadata); background: var(--interaction-row-hover); }
}
@media (prefers-reduced-motion: reduce) {
  .rat-tool > summary, .rat-context > summary { transition: none; }
}
.rat-context summary { min-height: var(--space-7); margin-inline: calc(-1 * var(--space-2)); padding-inline: var(--space-2); display: flex; align-items: center; gap: var(--space-2); cursor: pointer; list-style: none; }
.rat-context summary::-webkit-details-marker { display: none; }
.rat-context summary > svg { flex-shrink: 0; }
.rat-section { margin-block-start: var(--space-1); }
.rat-toolBody { display: flex; flex-direction: column; gap: var(--space-1); margin-block-start: var(--space-1); color: var(--text-secondary); }
.rat-tool > .rat-toolBody > * { margin-block: 0; }
.rat-toolBody > .rat-section { display: flex; flex-direction: column; gap: var(--space-1); }
.rat-toolBody > .rat-section > * { margin-block: 0; }
.rat-tool { padding-inline-start: calc(var(--space-4) + var(--space-2)); }
.rat-tool > summary { flex-wrap: wrap; min-height: var(--space-7); margin-inline-start: calc(-1 * (var(--space-4) + 2 * var(--space-2))); margin-inline-end: calc(-1 * var(--space-2)); padding-inline: var(--space-2); cursor: pointer; list-style: none; color: var(--text-secondary); }
.rat-tool[data-status="failed"] > summary, .rat-tool[data-status="terminated"] > summary { color: var(--text-danger); }
.rat-summary { flex: 1 1 0; min-width: min(10rem, calc(100% - var(--space-6))); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rat-subject { color: var(--text-primary); overflow-wrap: anywhere; }
.rat-tool[data-status="failed"] .rat-subject, .rat-tool[data-status="terminated"] .rat-subject { color: var(--text-danger); }
.rat-metaSeparator { margin-inline: var(--space-2); }
.rat-chevron { color: var(--text-subtle); }
.rat-context[open] > summary > .rat-chevron, .rat-tool[open] > summary > .rat-chevron { transform: rotate(90deg); }
.rat-tool[open] > summary .rat-summary { white-space: normal; overflow-wrap: anywhere; }
.rat-tool > summary::-webkit-details-marker { display: none; }
html[data-keyboard-navigation] .rat-tool > summary:focus-visible, html[data-keyboard-navigation] .rat-context summary:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.rat-path { color: var(--text-subtle); }
.rat-status { color: var(--text-subtle); }
.rat-tool[data-status="failed"] .rat-status, .rat-tool[data-status="terminated"] .rat-status { color: var(--text-danger); }
.rat-plain { white-space: pre-wrap; }
.rat-pre { font-family: var(--font-mono); font-size: var(--text-mono); line-height: var(--text-mono--line-height); letter-spacing: var(--text-mono--letter-spacing); font-weight: var(--text-mono--font-weight); }
.rat-diff { margin: var(--space-1) 0 0; }
.rat-removed { color: var(--text-danger); }
.rat-added { color: var(--text-success); }
.rat-badge { display: inline-flex; align-items: center; gap: var(--space-1); flex-shrink: 1; overflow-wrap: anywhere; }
.rat-pre { max-height: 24rem; overflow: auto; margin: var(--space-1) 0 0; padding: var(--space-3); background: var(--surface-inset); border: 1px solid var(--border-standard); border-radius: var(--radius-lg); white-space: pre-wrap; overflow-wrap: anywhere; }
.rat-plan { margin: 0; padding: 0; list-style: none; }
.rat-avatar { display: flex; box-sizing: border-box; padding: calc(var(--space-half) / 2); width: var(--space-4); height: var(--space-4); flex-shrink: 0; }
.rat-preview { color: var(--text-secondary); }
.rat-tool[open] > summary .rat-preview { display: none; }
.rat-item[data-type="thought"] .rat-subject, .rat-item[data-type="status"] .rat-subject { color: var(--text-secondary); }
.rat-tool[data-status="failed"] > summary > svg, .rat-tool[data-status="terminated"] > summary > svg { color: var(--text-danger); }
@media (hover: hover) and (pointer: fine) {
  .rat-at, .rat-chevron { opacity: 0; }
  summary:hover > .rat-at, summary:focus-visible > .rat-at, summary:hover > .rat-chevron, summary:focus-visible > .rat-chevron { opacity: 1; }
}
.rat-item[data-type="prompt"] .rat-toolBody, .rat-item[data-type="message"] .rat-toolBody { color: var(--text-primary); }
.rat-statusRow { align-items: center; min-height: var(--space-7); margin-inline: calc(-1 * var(--space-2)); padding: var(--space-1) var(--space-2); border-radius: var(--radius-row); background: var(--affordance-subtle); color: var(--text-secondary); }
.rat-statusRow[data-status="completed"] { background: var(--surface-status-success); color: var(--text-on-status-success); }
.rat-statusRow[data-status="failed"] { background: var(--surface-status-danger); color: var(--text-on-status); }
.rat-codePanel { overflow: hidden; background: var(--surface-inset); border: 1px solid var(--border-standard); border-radius: var(--radius-lg); }
.rat-codePanelHeading { margin: 0; padding: var(--space-2) var(--space-3); border-block-end: 1px solid var(--border-standard); }
.rat-codePanel > .rat-pre { margin: 0; border: 0; border-radius: 0; }
.rat-context > .rat-codePanel { margin-block-start: var(--space-1); }
@media (prefers-reduced-motion: no-preference) {
  html:not([data-keyboard-navigation]) .rat-chevron { transition: transform var(--duration-fast) var(--easing-enter); }
}
@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {
  html:not([data-keyboard-navigation]) .rat-at { transition: opacity var(--duration-fast) var(--easing-enter); }
  html:not([data-keyboard-navigation]) .rat-chevron { transition: transform var(--duration-fast) var(--easing-enter), opacity var(--duration-fast) var(--easing-enter); }
}
.rat-avatar > span { display: grid; place-items: center; width: 100%; height: 100%; border-radius: 50%; background: var(--affordance-subtle); color: var(--text-secondary); font-size: 0.5625rem; font-weight: 600; line-height: 1; }
.rat-link { padding: 0; border: 0; background: none; color: inherit; font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.rat-group { margin: 0 auto calc(-1 * var(--space-3)); width: 100%; max-width: 48rem; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.04em; }
.rat-card { padding: var(--space-3) var(--space-4); border: 1px solid var(--border-standard); border-radius: var(--radius-lg); box-sizing: border-box; }
.rat-cardHeader { width: calc(100% + 2 * var(--space-2)); border: 0; font: inherit; text-align: start; cursor: pointer; }
.rat-cardState, .rat-cardPlace { flex-shrink: 0; font-weight: 600; }
.rat-cardSubject { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rat-cardMeta { flex-shrink: 0; margin-inline-start: auto; font-variant-numeric: tabular-nums; }
.rat-cardHeader > .rat-chevron { opacity: 1; color: inherit; }
.rat-cardHeader[aria-expanded="true"] > .rat-chevron { transform: rotate(90deg); }
html[data-keyboard-navigation] .rat-cardHeader:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
`;

const line = (text) => text.split("\n").find(Boolean)?.trim() ?? "";
const time = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fullTime = (at) => new Date(at).toLocaleString();
// Zero, non-finite and out-of-range times are unknown: show nothing.
const known = (at) => !!at && !Number.isNaN(new Date(at).getTime());
function duration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
function toolLabel(item) {
  const title = line(item.title) || "tool";
  const action = ACTIONS[item.kind];
  if (!action) return { action: title, detail: "" };
  return { action, detail: title.replace(new RegExp(`^${action}(?:\\s+|$)`, "i"), "") };
}
// The first location, unless the adapter's title already names it.
const toolPath = (item) => (item.paths[0] && !item.title.includes(item.paths[0]) ? item.paths[0] : "");
// A file's lines; a final newline does not start another line.
const lines = (text) => text.replace(/\n$/, "").split("\n");

const object = (value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined);
const str = (value) => (typeof value === "string" ? value : "");
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const eventId = (value) => (typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined);
// The Buzz tools that post a message, named as goose names them, `buzz__send`,
// or as Claude Code does, `mcp__buzz__send`.
const MESSAGE_TOOLS = ["send", "reply_in_subthread"];
const postsMessage = (title) => MESSAGE_TOOLS.includes(/^(?:mcp__)?buzz__(\w+)$/.exec(title.trim())?.[1]);
const ELIDED = "…[elided ";
const PROMPT_METHODS = new Set(["session/prompt", "_session/steering", "_goose/unstable/session/steer"]);
const TRIGGER_LIMIT = 64;

const TITLES = new Map(
  Object.entries({
    identity: "Identity",
    base: "Base",
    workspace: "Workspace",
    "community-repositories": "Repositories folder",
    "agent-instructions": "Agent instructions",
    team: "Team",
    "core-memory": "Core memory",
    "recent-notes": "Recent notes",
    context: "Context",
    mention: "Mention",
    "buzz-event": "Buzz event",
    "buzz-events": "Buzz events",
    "thread-context": "Thread context",
    "conversation-context": "Conversation context",
    "turn-context": "Turn context",
    interest: "Interest",
    text: "Text",
  }),
);
// A prompt section's readable title; an unknown tag shows as it is.
const sectionTitle = (tag) => TITLES.get(tag) ?? tag;
// A steer's section holds its event, or before exact records, a whole turn.
const EVENT_TAGS = new Set(["buzz-event", "new-message-arrived-while-you-were-working"]);

// Split top-level `<tag attrs>` … `</tag>` prompt framing; other text is kept.
function promptSections(text) {
  const sections = [];
  const loose = [];
  let open;
  for (const row of text.split("\n")) {
    if (open) {
      if (row === `</${open.tag}>`) {
        sections.push({ tag: open.tag, body: open.lines.join("\n") });
        open = undefined;
      } else open.lines.push(row);
      continue;
    }
    const start = /^<([a-z][a-z0-9-]*)(?:\s[^<>]*)?>$/.exec(row);
    if (start?.[1]) open = { tag: start[1], lines: [] };
    else loose.push(row);
  }
  // An unterminated section is ordinary text, not a silently dropped body.
  if (open) loose.push(`<${open.tag}>`, ...open.lines);
  const rest = loose.join("\n").trim();
  if (rest) sections.push({ tag: "text", body: rest });
  return sections;
}

// Who sent an exact-record event body, and its request.
function readEventBody(body) {
  const match = /^(\{[^\n]*\})\nRequest: ("[^\n]*")$/.exec(body);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    const pubkey = JSON.parse(match[1])?.pubkey;
    const request = JSON.parse(match[2]);
    return typeof pubkey === "string" && typeof request === "string" ? { pubkey, request } : undefined;
  } catch {
    return undefined;
  }
}

// The triggering Buzz event(s): author label and content, without tags.
function promptMessage(sections) {
  const authors = [];
  const authorKeys = [];
  const contents = [];
  for (const { tag, body } of sections) {
    const record = EVENT_TAGS.has(tag) ? readEventBody(body) : undefined;
    if (record) {
      contents.push(record.request);
      authorKeys.push(record.pubkey);
      continue;
    }
    if (tag !== "buzz-event" && tag !== "buzz-events") continue;
    // Turns from before exact records serialized the event as escaped JSON.
    let event;
    try {
      event = object(JSON.parse(body));
    } catch {
      // Legacy human-readable event block.
    }
    if (event && typeof event.content === "string") {
      contents.push(event.content);
      const key = str(event.pubkey);
      if (/^[0-9a-f]{64}$/.test(key)) authorKeys.push(key);
      const author = str(event.author) || str(event.npub) || str(event.pubkey);
      if (author) authors.push(author);
      continue;
    }
    for (const block of body.split(/\n(?=--- Event \d+ )/)) {
      const from = /^From: (.*)$/m.exec(block)?.[1];
      const start = block.indexOf("\nContent: ");
      if (start < 0) continue;
      const end = block.lastIndexOf("\nTags: ");
      contents.push(block.slice(start + 10, end > start ? end : undefined).trim());
      if (from) authors.push(from.replace(/ \((?:npub|hex)[^)]*\)$/, ""));
    }
  }
  return {
    text: contents.join("\n\n"),
    author: [...new Set(authors)].join(", ") || undefined,
    authorPubkey: contents.length === authorKeys.length && new Set(authorKeys).size === 1 ? authorKeys[0] : undefined,
  };
}

// Thread evidence from the prompt's `<context>`: root, channel (null), or unknown.
function promptThread(sections) {
  const context = sections.find((section) => section.tag === "context")?.body;
  if (!context) return undefined;
  const root = eventId(/^Thread root: (\S+)$/m.exec(context)?.[1]);
  if (root) return root;
  return /^Scope: (?:channel|dm)$/m.test(context) ? null : undefined;
}

// A start's or steer's message ids, admitted whole or not at all, that the
// turn doesn't know yet.
function freshTriggers(known, value) {
  const added =
    Array.isArray(value) && value.length <= TRIGGER_LIMIT && value.every((id) => eventId(id)) ? value : [];
  const fresh = added.filter((id, index, ids) => !known.includes(id) && ids.indexOf(id) === index);
  return known.length + fresh.length > TRIGGER_LIMIT ? [] : fresh;
}

function terminalOutcome(kind, outcome) {
  if (kind === "turn_error" || kind === "agent_panic") return "error";
  if (kind !== "turn_completed") return undefined;
  switch (outcome) {
    case undefined:
    case "completed":
      return "ended";
    case "failed":
    case "terminated":
      return "error";
    case "cancelled":
      return "stopped";
    default:
      return "unknown";
  }
}

const display = (value) =>
  value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
// Text content is Markdown; a block that is one fenced code block shows its body.
const unfence = (text) => /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)?.[1] ?? text;
function toolContent(update) {
  const diffs = [];
  const text = [];
  for (const value of Array.isArray(update.content) ? update.content : []) {
    const entry = object(value);
    const block = object(entry?.content);
    if (entry?.type === "diff" && typeof entry.newText === "string")
      diffs.push({
        path: str(entry.path),
        newText: entry.newText,
        ...(typeof entry.oldText === "string" ? { oldText: entry.oldText } : {}),
      });
    else if (block?.type === "text" && str(block.text)) text.push(unfence(block.text));
  }
  return { diffs, output: text.length ? text.join("\n") : display(update.rawOutput) };
}
// Selected values of ACP config options, by their display names.
function configLabels(options) {
  if (!Array.isArray(options)) return undefined;
  return options.flatMap((value) => {
    const option = object(value);
    const current = option?.currentValue;
    if (typeof current !== "string" || !current) return [];
    const choice = Array.isArray(option?.options)
      ? option.options.map(object).find((entry) => entry?.value === current)
      : undefined;
    const label = str(choice?.name) || current;
    const name = str(option?.name);
    return [name && !label.startsWith(name) ? `${name}: ${label}` : label];
  });
}

// The owner-only observer frames, read into turns oldest first. Each turn
// keeps its sessionId, channelId and threadRootId. Frames are a single event
// or a {kind: "batch"} envelope.
function activityTranscript(records, agent) {
  const events = [];
  for (const record of records) {
    if (record.agent !== agent) continue;
    let raw;
    try {
      raw = JSON.parse(record.plaintext);
    } catch {
      continue;
    }
    const envelope = object(raw);
    const children = envelope?.kind === "batch" ? object(envelope.payload)?.events : [raw];
    if (!Array.isArray(children)) continue;
    children.forEach((child, index) => {
      const event = object(child);
      if (!event) return;
      const parsed = Date.parse(str(event.timestamp));
      const at = Number.isFinite(parsed) && parsed <= record.receivedAt + 5000 ? parsed : record.receivedAt;
      events.push({ id: `${record.id}:${index}`, at, order: events.length, event });
    });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order);

  const turns = new Map();
  // JSON-RPC ids are per agent process and direction, so key them by pool slot
  // and keep our prompts apart from the agent's permission requests.
  const prompts = new Map();
  const permissions = new Map();
  const tool = (turn, id, at, eventKey) => {
    let item = turn.tools.get(id);
    if (!item) {
      item = {
        id: eventKey,
        at,
        type: "tool",
        toolCallId: id,
        title: "",
        kind: "",
        status: "pending",
        input: "",
        output: "",
        diffs: [],
        paths: [],
        truncated: false,
      };
      turn.tools.set(id, item);
      turn.items.push(item);
    }
    return item;
  };
  const chunk = (turn, type, text, messageId, id, at) => {
    const same = (item) => ((item?.type === "message" || item?.type === "thought") && item.type === type ? item : undefined);
    const last = same(turn.items.at(-1));
    // Explicit message IDs join across tools; unkeyed chunks join only adjacent.
    const target = messageId
      ? turn.items.map(same).find((item) => item?.messageId === messageId)
      : last && !last.messageId
        ? last
        : undefined;
    if (target) target.text += text;
    else turn.items.push({ id, at, type, text, ...(messageId ? { messageId } : {}) });
  };

  for (const { id, at, event } of events) {
    const turnId = str(event.turnId);
    if (!turnId) continue;
    const kind = str(event.kind);
    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        turnId,
        channelId: str(event.channelId) || null,
        threadRootId: undefined,
        triggeringEventIds: [],
        newSession: false,
        config: [],
        startedAt: at,
        partial: true,
        items: [],
        tools: new Map(),
        sent: new Map(),
        errored: new Set(),
      };
      turns.set(turnId, turn);
    }
    if (str(event.sessionId)) turn.sessionId = str(event.sessionId);
    const payload = object(event.payload) ?? {};
    const root = eventId(payload.threadRootEventId);
    if (root) turn.payloadThread = root;
    const slot = String(event.agentIndex ?? "");
    if (kind === "turn_started") {
      turn.partial = false;
      const started = Date.parse(str(event.startedAt));
      turn.startedAt = Number.isFinite(started) ? started : at;
      if (str(payload.source)) turn.source = str(payload.source);
      turn.triggeringEventIds.push(...freshTriggers(turn.triggeringEventIds, payload.triggeringEventIds));
    } else if (kind === "turn_steered") {
      // A message that joined this running turn.
      turn.triggeringEventIds.push(...freshTriggers(turn.triggeringEventIds, payload.triggeringEventIds));
    } else if (kind === "session_resolved") {
      if (str(payload.sessionId)) turn.sessionId = str(payload.sessionId);
      turn.newSession = payload.isNewSession === true;
    } else if (kind === "session_config_captured") {
      turn.config = configLabels(payload.configOptions) ?? turn.config;
    } else if (kind === "turn_completed") {
      if (turn.endedAt === undefined) {
        turn.endedAt = at;
        turn.outcome = terminalOutcome(kind, payload.outcome);
      }
    } else if (kind === "turn_error" || kind === "agent_panic") {
      turn.endedAt ??= at;
      turn.error = str(payload.error).slice(0, 2000) || str(payload.outcome) || kind;
    } else if (kind === "acp_write") {
      const method = str(payload.method);
      const params = object(payload.params) ?? {};
      if (method === "session/new") {
        const meta = object(params._meta)?.systemPrompt;
        const system = str(params.systemPrompt) || str(meta) || str(object(meta)?.replace) || str(object(meta)?.append);
        if (system) turn.items.push({ id, at, type: "system", sections: promptSections(system) });
      } else if (PROMPT_METHODS.has(method) && Array.isArray(params.prompt)) {
        const text = params.prompt
          .map((block) => str(object(block)?.text))
          .filter(Boolean)
          .join("\n");
        const sections = promptSections(text);
        const message = promptMessage(sections);
        const thread = promptThread(sections);
        if (thread !== undefined) turn.promptThread = thread;
        turn.items.push({
          id,
          at,
          type: "prompt",
          // Non-Buzz prompts (heartbeats, other hosts) keep their unframed text.
          text: message.text || sections.find((section) => section.tag === "text")?.body || text,
          ...(message.author ? { author: message.author } : {}),
          ...(message.authorPubkey ? { authorPubkey: message.authorPubkey } : {}),
          sections,
          steer: method !== "session/prompt",
        });
        if (payload.id !== undefined && method === "session/prompt")
          prompts.set(`${slot}:${JSON.stringify(payload.id)}`, turn);
      } else if (!method && payload.id !== undefined) {
        // Our reply to an agent request, e.g. the auto-approved permission.
        const request = permissions.get(`${slot}:${JSON.stringify(payload.id)}`);
        const outcome = object(object(payload.result)?.outcome);
        if (request?.tool.permission && outcome) {
          const option = request.options.find((entry) => entry.optionId === outcome.optionId);
          request.tool.permission.outcome =
            outcome.outcome === "cancelled"
              ? "Cancelled"
              : str(option?.name) || str(option?.kind) || str(outcome.optionId);
        }
      }
    } else if (kind === "acp_read") {
      const method = str(payload.method);
      const params = object(payload.params) ?? {};
      if (!method && payload.id !== undefined) {
        const result = object(payload.result);
        const prompt = prompts.get(`${slot}:${JSON.stringify(payload.id)}`);
        const stop = str(result?.stopReason);
        if (prompt && stop) prompt.stopReason = stop;
        // pi-acp returns its startup banner in the session/new result and then
        // repeats it verbatim as an agent message. It is not a reply.
        const banner = str(object(object(result?._meta)?.piAcp)?.startupInfo);
        if (banner) turn.piStartup = banner;
      } else if (method === "session/request_permission") {
        const call = object(params.toolCall) ?? {};
        const item = tool(turn, str(call.toolCallId) || `permission:${id}`, at, id);
        item.title ||= str(call.title);
        const options = Array.isArray(params.options) ? params.options.map(object).filter(Boolean) : [];
        item.permission = { options: options.map((entry) => str(entry.name) || str(entry.kind)) };
        if (payload.id !== undefined)
          permissions.set(`${slot}:${JSON.stringify(payload.id)}`, { tool: item, options });
      } else if (method === "session/update") {
        const update = object(params.update) ?? {};
        const type = str(update.sessionUpdate);
        if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
          const content = object(update.content);
          const text = str(content?.text);
          if (type === "agent_message_chunk" && text === turn.piStartup) {
            delete turn.piStartup;
            continue;
          }
          if (text && (content?.type ?? "text") === "text")
            chunk(turn, type === "agent_message_chunk" ? "message" : "thought", text, str(update.messageId), id, at);
        } else if (type === "tool_call" || type === "tool_call_update") {
          const callId = str(update.toolCallId);
          if (!callId) continue;
          const item = tool(turn, callId, at, id);
          if (str(update.title)) item.title = str(update.title);
          if (str(update.kind)) item.kind = str(update.kind);
          if (str(update.status)) item.status = str(update.status);
          if (update.rawInput !== undefined) {
            item.input = display(update.rawInput);
            const text = str(object(update.rawInput)?.text);
            if (text.trim()) turn.sent.set(callId, text);
          }
          // MCP application errors can arrive as completed calls.
          if (object(update.rawOutput)?.isError === true) turn.errored.add(callId);
          const { diffs, output } = toolContent(update);
          if (output) item.output = output;
          if (diffs.length) item.diffs = diffs;
          const located = Array.isArray(update.locations)
            ? update.locations.flatMap((value) => str(object(value)?.path) || [])
            : [];
          if (located.length) item.paths = located;
          if ((item.status === "completed" || item.status === "failed") && item.completedAt === undefined)
            item.completedAt = at;
          item.truncated ||= [
            item.input,
            item.output,
            ...item.diffs.flatMap((diff) => [diff.oldText ?? "", diff.newText]),
          ].some((text) => text.includes(ELIDED));
        } else if (type === "plan" && Array.isArray(update.entries)) {
          const entries = update.entries.flatMap((value) => {
            const entry = object(value);
            return entry && str(entry.content) ? [{ content: str(entry.content), status: str(entry.status) }] : [];
          });
          if (turn.plan) turn.plan.entries = entries;
          else {
            turn.plan = { id, at, type: "plan", entries };
            turn.items.push(turn.plan);
          }
        } else if (type === "current_mode_update" && str(update.currentModeId))
          turn.items.push({ id, at, type: "status", text: `Mode: ${str(update.currentModeId)}` });
        else if (type === "config_option_update") {
          const labels = configLabels(update.configOptions);
          if (labels) turn.config = labels;
        } else if (type === "usage_update") {
          const used = number(update.used);
          const size = number(update.size);
          if (used !== undefined && size !== undefined) turn.context = { used, size };
        }
      }
    }
    if (str(payload.elided))
      turn.items.push({ id, at, type: "status", text: `A ${kind} frame was too large and was elided by the agent.` });
  }

  // Harnesses capture config when creating a session and reuse sessions without
  // another capture, so a later turn shows its session's last observed config.
  const drafts = [...turns.values()].sort((a, b) => a.startedAt - b.startedAt);
  const configs = new Map();
  for (const draft of drafts) {
    if (!draft.sessionId) continue;
    if (draft.config.length) configs.set(draft.sessionId, draft.config);
    else draft.config = configs.get(draft.sessionId) ?? [];
  }

  return drafts.map((draft) => {
    const { tools: _tools, sent, errored, plan: _plan, piStartup: _piStartup, payloadThread, promptThread, ...turn } = draft;
    // A Buzz message a tool posted reads as the agent's reply. A failed,
    // erroring or unfinished send stays a tool, with its error.
    turn.items = turn.items.map((item) => {
      const text = item.type === "tool" && sent.get(item.toolCallId);
      return text && item.status === "completed" && !errored.has(item.toolCallId) && postsMessage(item.title)
        ? { id: item.id, at: item.at, type: "message", text, posted: true }
        : item;
    });
    // Older harnesses omit threadRootEventId; the prompt context still names it.
    turn.threadRootId = payloadThread ?? promptThread;
    return turn;
  });
}
