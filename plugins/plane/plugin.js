// Plane: a self-hosted Plane workspace in Buzz. A board page in the left dock,
// and a preview and side panel for Plane card links, each with a state you
// can move. It calls Plane's REST API (/api/v1) with an API key kept in the
// macOS Keychain through `security` (manifest commands).
//
// SERVER is the manifest's placeholder origin. A server that serves this
// plugin swaps both for its Plane origin; installing from a folder, change
// both by hand (README.md, "Install").

export const inject = ["conversation", "host", "navigation", "pages", "panels", "react", "settingsCards"];

const SERVER = "https://plane.example.com";
const WORKSPACE_KEY = "buzz-plane.workspace";
const PROJECT_KEY = "buzz-plane.project";
const MINE_KEY = "buzz-plane.assigned-to-me";
// Plane's state groups, in board order. Cancelled is left off the board.
const GROUPS = ["backlog", "unstarted", "started", "completed", "cancelled"];
const EXPAND = "expand=assignees,labels,state,estimate_point";
// Plane allows an API key 60 calls a minute, so lists are shared for a while.
const FRESH_MS = 60 * 1000;
const REASONS = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" };

class PlaneError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const { useState, useEffect, useRef, useSyncExternalStore } = React;
  const { host, origin } = new URL(SERVER);
  const pluginId = "plane";
  // The Settings card's section id is its contribution key.
  const SETTINGS = { version: 1, kind: "settings", section: `${pluginId}/plane` };

  // ---- Shared state: the key and the connection ------------------------------

  let apiKey = "";
  let generation = 0;
  let state = {
    key: "checking", // checking | missing | saved
    connection: { status: "checking" },
    workspace: stored(WORKSPACE_KEY),
    me: undefined, // the Plane user the key belongs to
    moved: 0, // counts moves, so the board reloads its list
  };
  const listeners = new Set();
  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const useStore = () => useSyncExternalStore(subscribe, () => state);

  function stored(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }
  function store(key, value) {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {
      // Without storage the value lasts until Buzz quits.
    }
  }

  // ---- Keychain (manifest commands key-read, key-save, key-clear) -----------

  async function readKey() {
    const out = await ctx.host.runCommand("key-read").catch(() => null);
    return out ? out.trim() : "";
  }

  async function saveKey(value) {
    // `security -i` splits its input on spaces and quotes, so only take the
    // characters an API key has.
    if (!/^[A-Za-z0-9_.~+/=-]{8,512}$/.test(value)) throw new Error("That doesn't look like a Plane API key.");
    await ctx.host.runCommand("key-save", `add-generic-password -U -s buzz-plane -a api-key -w ${value}\n`).catch(() => null);
    if ((await readKey()) !== value) throw new Error("Buzz couldn't save the key in this Mac's Keychain.");
    apiKey = value;
    generation++;
    cards.clear();
    set({ key: "saved" });
    forget();
    void refresh();
  }

  async function clearKey() {
    await ctx.host.runCommand("key-clear").catch(() => null);
    if (await readKey()) throw new Error("Buzz couldn't remove the key from this Mac's Keychain.");
    apiKey = "";
    generation++;
    cards.clear();
    forget();
    set({ key: "missing", connection: { status: "missing" }, me: undefined });
  }

  function saveWorkspace(value) {
    store(WORKSPACE_KEY, value);
    forget();
    set({ workspace: value });
    void refresh();
  }

  // ---- Plane API -------------------------------------------------------------

  const ws = (slug = state.workspace) => `/workspaces/${encodeURIComponent(slug)}`;

  async function api(path, { method = "GET", body } = {}) {
    if (!apiKey) throw new PlaneError("missing", "Add your Plane API key in Settings → Plane.");
    let response;
    try {
      response = await ctx.host.request({
        url: `${origin}/api/v1${path}`,
        method,
        headers: {
          accept: "application/json",
          "x-api-key": apiKey,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        timeoutMs: 20000,
      });
    } catch {
      throw new PlaneError("unreachable", `Couldn't reach ${host}.`);
    }
    let data = null;
    try {
      data = response.body ? JSON.parse(response.body) : null;
    } catch {
      data = null;
    }
    const status = response.status;
    if (status >= 200 && status < 300) return data;
    const answered = `${host} answered ${status}${REASONS[status] ? ` ${REASONS[status]}` : ""}.`;
    // Plane answers 403 to a bad key and to a workspace you're not in alike.
    if (status === 401 || status === 403) throw new PlaneError("refused", answered, status);
    if (status === 404) throw new PlaneError("not-found", answered, status);
    if (status === 429) throw new PlaneError("busy", "Plane is limiting requests. Try again in a minute.", status);
    throw new PlaneError("http", data?.error || data?.detail || answered, status);
  }

  // Every page of a list. Plane wraps lists in {results, next_cursor, …}.
  async function list(path) {
    const rows = [];
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const query = `${path.includes("?") ? "&" : "?"}per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const data = await api(path + query);
      if (Array.isArray(data)) return data;
      rows.push(...(data?.results ?? []));
      if (!data?.next_page_results || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
    return rows;
  }

  const lists = new Map(); // path -> { at, promise }
  function cached(path, fresh) {
    const hit = lists.get(path);
    if (hit && !fresh && Date.now() - hit.at < FRESH_MS) return hit.promise;
    const promise = list(path);
    promise.catch(() => lists.get(path)?.promise === promise && lists.delete(path));
    lists.set(path, { at: Date.now(), promise });
    return promise;
  }
  const forget = () => lists.clear();

  const projectsOf = (slug, fresh) =>
    cached(`${ws(slug)}/projects/`, fresh).then((rows) =>
      rows.filter((p) => !p.archived_at && p.is_member !== false).sort((a, b) => a.name.localeCompare(b.name)),
    );
  const statesOf = (slug, projectId, fresh) =>
    cached(`${ws(slug)}/projects/${projectId}/states/`, fresh).then((rows) =>
      [...rows].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.sequence - b.sequence),
    );
  const issuesOf = (slug, projectId, fresh) =>
    cached(`${ws(slug)}/projects/${projectId}/issues/?${EXPAND}`, fresh).then((rows) =>
      rows.filter((i) => !i.archived_at),
    );

  const nameOf = (user) =>
    user?.display_name || [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email || "Unknown";
  const idOf = (value) => (typeof value === "string" ? value : value?.id);
  const cardId = (project, issue) => `${project?.identifier ?? "?"}-${issue.sequence_id}`;
  const browseUrl = (slug, id) => `${origin}/${encodeURIComponent(slug)}/browse/${id}/`;

  // ---- Connection --------------------------------------------------------------

  async function check() {
    const run = ++generation;
    const current = () => run === generation;
    const workspace = state.workspace;
    if (!apiKey) return set({ connection: { status: "missing" }, me: undefined });
    set({ connection: { status: "checking" } });
    let me;
    try {
      me = await api("/users/me/");
    } catch (error) {
      if (!current()) return;
      return set({ connection: failure(error), me: undefined });
    }
    if (!current()) return;
    const name = nameOf(me);
    if (!workspace) return set({ connection: { status: "no-workspace", name }, me });
    try {
      await api(`${ws(workspace)}/projects/?per_page=1`);
    } catch (error) {
      if (!current()) return;
      const unknown = error.kind === "refused" || error.kind === "not-found";
      return set({ connection: unknown ? { status: "unknown-workspace", name, workspace } : failure(error), me });
    }
    if (current()) set({ connection: { status: "connected", name }, me });
  }

  function failure(error) {
    if (error.kind === "unreachable") return { status: "unreachable" };
    if (error.kind === "refused") return { status: "refused", message: `Not connected: ${error.message}` };
    return { status: "error", message: error.message };
  }

  async function refresh(fresh = false) {
    if (fresh) forget();
    await check();
  }

  ctx.effect(() => {
    let live = true;
    void (async () => {
      apiKey = await readKey();
      if (!live) return;
      set({ key: apiKey ? "saved" : "missing" });
      await refresh();
    })();
    return () => {
      live = false;
    };
  });

  // ---- Shared pieces ---------------------------------------------------------

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

  function stateIcon(stateLite, size = 16) {
    const name = STATE_ICONS[stateLite?.group] ?? "circle";
    return icon(name, size, { style: { color: stateLite?.color || "currentColor", flexShrink: 0 } });
  }

  function Button({ variant = "subtle", size = "sm", disabled, children, ...props }) {
    return h(
      "button",
      {
        type: "button",
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": variant,
        "data-size": size,
        "data-button-shape": "capsule",
        disabled,
        "data-disabled": disabled ? "" : undefined,
        ...props,
      },
      h("span", { className: "buzz-button-label" }, children),
    );
  }

  function IconButton({ label, children, ...props }) {
    return h(
      "button",
      {
        type: "button",
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": "ghost",
        "data-size": "sm",
        "data-icon-variant": "ghost",
        "data-icon-size": "sm",
        "data-icon-shape": "control",
        "aria-label": label,
        title: label,
        ...props,
      },
      children,
    );
  }

  // Opens in the browser: Buzz hands https links with target=_blank to the system.
  const external = (href, children, props) =>
    h("a", { href, target: "_blank", rel: "noopener noreferrer", ...props }, children);

  function Avatar({ user }) {
    if (!user)
      return h("span", { className: "pl-person text-subtle" }, icon("user-circle", 18), h("span", null, "Unassigned"));
    const name = nameOf(user);
    const initials = name
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join("")
      .slice(0, 2)
      .toUpperCase();
    return h(
      "span",
      { className: "pl-person" },
      h("span", { className: "pl-avatar", "aria-hidden": true }, initials),
      h("span", { className: "pl-ellipsis" }, name),
    );
  }

  const estimateOf = (issue) => issue.estimate_point?.value ?? "";

  function Chip({ glyph, children, title }) {
    return h("span", { className: "pl-chip", title }, glyph, h("span", { className: "pl-ellipsis" }, children));
  }

  // A label in its Plane colour. Only a hex colour reaches the style.
  function LabelChip({ label }) {
    const color = /^#[0-9a-f]{3,8}$/i.test(label.color ?? "") ? label.color : "var(--text-subtle)";
    return h(
      Chip,
      { glyph: h("span", { className: "pl-dot", style: { background: color } }), title: label.name },
      label.name,
    );
  }

  function StateChip({ state: s }) {
    return h("span", { className: "pl-chip pl-state" }, stateIcon(s, 14), h("span", null, s?.name ?? "No state"));
  }

  // A menu of states, shown under its trigger. The host's menu component isn't
  // open to plugins, so this keeps its classes and does the rest itself.
  function MoveMenu({ id, states, current, onMove, busy, trigger }) {
    const [open, setOpen] = useState(false);
    const root = useRef(null);
    const items = useRef([]);
    useEffect(() => {
      if (!open) return;
      const away = (event) => !root.current?.contains(event.target) && setOpen(false);
      document.addEventListener("pointerdown", away);
      const first = states.findIndex((s) => s.id === current);
      items.current[first < 0 ? 0 : first]?.focus();
      return () => document.removeEventListener("pointerdown", away);
    }, [open]);
    const keys = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        root.current?.querySelector("button")?.focus();
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const at = items.current.indexOf(document.activeElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items.current[(at + step + states.length) % states.length]?.focus();
    };
    return h(
      "div",
      { ref: root, className: "pl-menuRoot", onKeyDown: keys },
      trigger({ open, busy, toggle: () => setOpen(!open) }),
      open &&
        h(
          "div",
          { className: "buzz-menu-positioner pl-menu" },
          h(
            "div",
            { "data-buzz-ui": "", className: "buzz-menu-popup text-body-sm", "data-size": "compact", role: "menu" },
            h("p", { className: "pl-menuTitle text-caption text-subtle" }, `Move ${id} to`),
            states.map((s, index) =>
              h(
                "button",
                {
                  key: s.id,
                  type: "button",
                  ref: (node) => (items.current[index] = node),
                  role: "menuitemradio",
                  "aria-checked": s.id === current,
                  className: "buzz-menu-item pl-menuItem",
                  "data-tone": "default",
                  onPointerEnter: (event) => event.currentTarget.focus(),
                  onClick: () => {
                    setOpen(false);
                    if (s.id !== current) onMove(s.id);
                  },
                },
                stateIcon(s),
                h("span", { className: "pl-grow" }, s.name),
                s.id === current && icon("check", 16),
              ),
            ),
          ),
        ),
    );
  }

  function Notice({ children, action }) {
    return h(
      "div",
      { className: "pl-notice" },
      h("p", { className: "m-0 text-body-sm text-subtle" }, children),
      action,
    );
  }

  const openSettings = () => void ctx.navigation.open(SETTINGS);

  function connectionText(c) {
    switch (c.status) {
      case "checking":
        return "Checking your Plane connection…";
      case "missing":
        return "Not connected. Add an API key from your Plane profile settings.";
      case "no-workspace":
        return `Connected to ${host} as ${c.name}. Add your workspace below.`;
      case "unknown-workspace":
        return `Connected as ${c.name}, but there is no workspace ${c.workspace}.`;
      case "unreachable":
        return `Couldn't reach ${host}. Check your network, then try again.`;
      case "connected":
        return `Connected to ${host} as ${c.name}.`;
      default:
        return c.message;
    }
  }

  // ---- Board page ------------------------------------------------------------

  function Board({ navigation }) {
    const s = useStore();
    const wanted = navigation?.target?.route?.params?.project;
    const [projects, setProjects] = useState();
    const [project, setProject] = useState(wanted || stored(PROJECT_KEY));
    const [board, setBoard] = useState();
    const [error, setError] = useState("");
    const [tick, setTick] = useState(0);
    const [opened, setOpened] = useState(""); // the card shown in the details pane
    const [mine, setMine] = useState(stored(MINE_KEY) === "1"); // only cards assigned to me
    const connected = s.connection.status === "connected";

    useEffect(() => {
      if (wanted) setProject(wanted);
    }, [wanted]);

    useEffect(() => setOpened(""), [project, s.workspace]);

    useEffect(() => {
      if (!connected) return;
      let live = true;
      projectsOf(s.workspace, tick > 0)
        .then((rows) => {
          if (!live) return;
          setProjects(rows);
          setError("");
          setProject((chosen) => (rows.some((p) => p.id === chosen) ? chosen : (rows[0]?.id ?? "")));
        })
        .catch((failed) => live && setError(failed.message));
      return () => {
        live = false;
      };
    }, [connected, s.workspace, tick]);

    useEffect(() => {
      if (!connected || !project || !projects?.some((p) => p.id === project)) return;
      store(PROJECT_KEY, project);
      let live = true;
      Promise.all([statesOf(s.workspace, project, tick > 0), issuesOf(s.workspace, project, tick > 0)])
        .then(([states, issues]) => {
          if (!live) return;
          setBoard({ project, states, issues });
          setError("");
        })
        .catch((failed) => live && setError(failed.message));
      return () => {
        live = false;
      };
      // A card moved from a preview or panel drops its project's list, so reload.
    }, [connected, s.workspace, project, projects, tick, s.moved]);

    const current = projects?.find((p) => p.id === project);
    const shown = board?.project === project ? board : undefined;
    const columns = shown ? shown.states.filter((st) => st.group !== "cancelled") : [];
    const issues = shown
      ? shown.issues.filter((i) => !mine || (i.assignees ?? []).some((a) => idOf(a) === s.me?.id))
      : [];
    const count = issues.filter((i) => columns.some((c) => c.id === idOf(i.state))).length;

    const header = h(
      "div",
      { "data-buzz-ui": "", className: "buzz-content-header" },
      h(
        "div",
        { className: "buzz-content-header-copy" },
        h("h2", { className: "buzz-content-header-title pl-title" }, icon("layout-kanban", 20), "Plane"),
      ),
      h(
        "div",
        { className: "buzz-content-header-actions pl-actions" },
        h(
          "label",
          { "data-buzz-ui": "", className: "buzz-switch pl-switch text-body-sm" },
          h(
            "button",
            {
              type: "button",
              role: "switch",
              className: "buzz-switch-control",
              "aria-checked": mine,
              "data-checked": mine ? "" : undefined,
              disabled: !connected,
              "data-disabled": connected ? undefined : "",
              onClick: () => {
                store(MINE_KEY, mine ? "" : "1");
                setMine(!mine);
              },
            },
            h("span", { className: "buzz-switch-thumb" }),
          ),
          "Assigned to me",
        ),
        h(IconButton, { label: "Refresh", disabled: !connected, onClick: () => {
          forget();
          setTick((n) => n + 1);
        } }, icon("refresh")),
        s.workspace &&
          external(
            current ? `${origin}/${encodeURIComponent(s.workspace)}/projects/${current.id}/issues/` : `${origin}/${encodeURIComponent(s.workspace)}/`,
            icon("external-link"),
            {
              "data-buzz-ui": "",
              className: "buzz-button",
              "data-variant": "ghost",
              "data-size": "sm",
              "data-icon-variant": "ghost",
              "data-icon-size": "sm",
              "data-icon-shape": "control",
              "aria-label": "Open in Plane",
              title: "Open in Plane",
            },
          ),
      ),
    );

    let body;
    if (!connected)
      body = h(Notice, { action: h(Button, { onClick: openSettings }, "Open Settings") }, connectionText(s.connection));
    else if (error) body = h(Notice, { action: h(Button, { onClick: () => setTick((n) => n + 1) }, "Try again") }, error);
    else if (projects && projects.length === 0) body = h(Notice, null, `You aren't in any project in ${s.workspace}.`);
    else
      body = h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "pl-toolbar" },
          h(
            "label",
            { className: "pl-picker" },
            h("span", { className: "text-subtle" }, "Project"),
            h(
              "select",
              { value: project, onChange: (event) => setProject(event.target.value), disabled: !projects },
              (projects ?? []).map((p) => h("option", { key: p.id, value: p.id }, p.name)),
            ),
            icon("chevron-down", 14),
          ),
          shown && h("span", { className: "text-body-sm text-subtle" }, count === 1 ? "1 card" : `${count} cards`),
        ),
        shown
          ? h(
              "div",
              { className: "pl-board" },
              h(
                "div",
                { className: "pl-columns" },
                columns.map((column) => {
                  const cards = issues.filter((i) => idOf(i.state) === column.id);
                  return h(
                    "section",
                    { key: column.id, className: "pl-column", "aria-label": column.name },
                    h(
                      "h3",
                      { className: "pl-columnTitle text-body" },
                      stateIcon(column),
                      h("span", { className: "pl-ellipsis" }, column.name),
                      h("span", { className: "text-subtle" }, cards.length),
                    ),
                    h(
                      "div",
                      { className: "pl-columnCards" },
                      cards.length === 0 && h("p", { className: "pl-empty text-body-sm text-subtle" }, "No cards"),
                      cards.map((issue) => {
                        const id = cardId(current, issue);
                        return h(BoardCard, {
                          key: issue.id,
                          id,
                          issue,
                          selected: id === opened,
                          onOpen: () => setOpened(id === opened ? "" : id),
                        });
                      }),
                    ),
                  );
                }),
              ),
              opened &&
                h(
                  "aside",
                  {
                    className: "pl-drawer",
                    "aria-label": `${opened} details`,
                    onKeyDown: (event) => event.key === "Escape" && setOpened(""),
                  },
                  h(
                    "div",
                    { className: "pl-drawerBar" },
                    h(IconButton, { label: "Close details", onClick: () => setOpened("") }, icon("x")),
                  ),
                  h(CardDetails, { key: opened, link: parseLink(browseUrl(s.workspace, opened)) }),
                ),
            )
          : h("p", { className: "text-body-sm text-subtle" }, "Loading the board…"),
      );

    return h("div", { className: "pl-page" }, h("style", null, CSS), header, body);
  }

  // The whole card opens its details: the title button's ::after covers it.
  function BoardCard({ id, issue, selected, onOpen }) {
    const assignee = (issue.assignees ?? []).find((a) => typeof a === "object");
    const estimate = estimateOf(issue);
    const labels = (issue.labels ?? []).filter((l) => typeof l === "object");
    const more = labels.slice(3);
    return h(
      "article",
      { className: "pl-card", "data-selected": selected ? "" : undefined },
      h("span", { className: "pl-id" }, id),
      h(
        "button",
        { type: "button", className: "pl-cardTitle text-body", "aria-expanded": selected, onClick: onOpen },
        issue.name,
      ),
      labels.length > 0 &&
        h(
          "div",
          { className: "pl-stack" },
          labels.slice(0, 3).map((label) => h(LabelChip, { key: label.id, label })),
          more.length > 0 &&
            h("span", { className: "pl-chip", title: more.map((l) => l.name).join(", ") }, `+${more.length}`),
        ),
      h(
        "div",
        { className: "pl-cardFoot" },
        h(Avatar, { user: assignee }),
        estimate && h(Chip, { glyph: icon("hourglass", 12), title: "Estimate" }, estimate),
      ),
    );
  }

  ctx.pages.register({
    id: "board",
    title: "Plane",
    layout: "workspace",
    primary: true,
    placement: "dock",
    icon: `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS["layout-kanban"]
        .map((d) => `<path d="${d}"/>`)
        .join("")}</svg>`,
    )}`,
    route: {
      version: 1,
      validate: (params) =>
        params !== null && typeof params === "object" && !Array.isArray(params) && typeof params.project === "string",
    },
    component: Board,
  });

  // ---- Card links: preview and side panel ------------------------------------

  // https://plane/{slug}/browse/{PROJ}-{n}/ and https://plane/{slug}/projects/{uuid}/issues/{uuid}
  function parseLink(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.origin !== origin) return null;
    let parts;
    try {
      parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return null;
    }
    if (parts.length === 3 && parts[1] === "browse" && /^[A-Za-z0-9]+-\d+$/.test(parts[2]))
      return { key: `${parts[0]}/${parts[2].toUpperCase()}`, slug: parts[0], id: parts[2].toUpperCase() };
    const uuid = /^[0-9a-f-]{36}$/i;
    if (parts.length === 5 && parts[1] === "projects" && parts[3] === "issues" && uuid.test(parts[2]) && uuid.test(parts[4]))
      return { key: `${parts[0]}/${parts[4]}`, slug: parts[0], projectId: parts[2], issueId: parts[4] };
    return null;
  }

  // One loaded card per link, shared by its preview and panel.
  const cards = new Map(); // key -> { data?, error?, loading, busy }
  const cardListeners = new Set();
  const setCard = (key, patch) => {
    cards.set(key, { ...cards.get(key), ...patch });
    for (const listener of cardListeners) listener();
  };

  async function loadCard(link) {
    setCard(link.key, { loading: true });
    try {
      const issue = await api(
        link.id
          ? `${ws(link.slug)}/issues/${link.id}/?${EXPAND}`
          : `${ws(link.slug)}/projects/${link.projectId}/issues/${link.issueId}/?${EXPAND}`,
      );
      const projectId = idOf(issue.project);
      const [project, states, links] = await Promise.all([
        projectsOf(link.slug).then((rows) => rows.find((p) => p.id === projectId)),
        statesOf(link.slug, projectId),
        list(`${ws(link.slug)}/projects/${projectId}/issues/${issue.id}/links/`).catch(() => []),
      ]);
      setCard(link.key, { data: { issue, project, states, refs: links.map(ref).filter(Boolean) }, error: "", loading: false });
    } catch (error) {
      setCard(link.key, { error: error.message, loading: false });
    }
  }

  function ref(link) {
    const url = String(link.url ?? "");
    // Anyone on the card can add a link, so only web links are shown.
    try {
      if (!["http:", "https:"].includes(new URL(url).protocol)) return null;
    } catch {
      return null;
    }
    const pull = url.match(/\/pulls?\/(\d+)/);
    if (pull) return { kind: "pull", url, label: `PR #${pull[1]}`, title: link.title ?? "" };
    const commit = url.match(/\/commits?\/([0-9a-f]{7,40})/i);
    if (commit) return { kind: "commit", url, label: commit[1].slice(0, 7), title: link.title ?? "" };
    let label = link.title || url;
    try {
      label = link.title || new URL(url).host;
    } catch {
      // keep the raw url
    }
    return { kind: "link", url, label, title: "" };
  }

  async function moveCard(link, stateId) {
    const card = cards.get(link.key);
    if (!card?.data || card.busy) return;
    const { issue } = card.data;
    const projectId = idOf(issue.project);
    setCard(link.key, { busy: true, error: "" });
    try {
      await api(`${ws(link.slug)}/projects/${projectId}/issues/${issue.id}/`, { method: "PATCH", body: { state: stateId } });
      lists.delete(`${ws(link.slug)}/projects/${projectId}/issues/?${EXPAND}`);
      await loadCard(link);
      if (link.slug === state.workspace) set({ moved: state.moved + 1 });
    } catch (error) {
      setCard(link.key, { error: error.message });
    } finally {
      setCard(link.key, { busy: false });
    }
  }

  function useCard(link) {
    const card = useSyncExternalStore(
      (listener) => {
        cardListeners.add(listener);
        return () => cardListeners.delete(listener);
      },
      () => cards.get(link.key),
    );
    const s = useStore();
    useEffect(() => {
      if (s.key === "saved" && !cards.get(link.key)?.data && !cards.get(link.key)?.loading) void loadCard(link);
    }, [link.key, s.key]);
    return { card, s };
  }

  function Refs({ refs, compact }) {
    if (refs.length === 0) return null;
    if (compact)
      return refs
        .filter((r) => r.kind !== "link")
        .slice(0, 2)
        .map((r) =>
          h(
            "span",
            { key: r.url, className: "pl-meta" },
            icon(r.kind === "pull" ? "git-pull-request" : "git-commit", 14),
            h("span", { className: r.kind === "commit" ? "pl-id" : undefined }, r.label),
          ),
        );
    return h(
      "ul",
      { className: "pl-refs" },
      refs.map((r) =>
        h(
          "li",
          { key: r.url },
          external(
            r.url,
            [
              icon(r.kind === "pull" ? "git-pull-request" : r.kind === "commit" ? "git-commit" : "link", 16, { key: "i" }),
              h("span", { key: "l", className: r.kind === "commit" ? "pl-id" : "pl-refLabel" }, r.label),
              r.title && h("span", { key: "t", className: "pl-ellipsis text-subtle" }, r.title),
            ],
            { className: "pl-ref text-body-sm" },
          ),
        ),
      ),
    );
  }

  function CardPreview({ url, open }) {
    const link = parseLink(url);
    const { card, s } = useCard(link);
    if (s.key !== "saved") return null;
    const data = card?.data;
    const source = h("p", { className: "pl-source text-caption text-subtle" }, icon("layout-kanban", 12), `Plane · ${host}`);
    if (!data)
      return h(
        "div",
        { className: "pl-preview" },
        h("style", null, CSS),
        source,
        h("p", { className: "m-0 text-body-sm text-subtle" }, card?.error || "Loading the card…"),
      );
    const { issue, project, states } = data;
    const id = link.id ?? cardId(project, issue);
    const assignee = (issue.assignees ?? []).find((a) => typeof a === "object");
    return h(
      "div",
      { className: "pl-preview" },
      h("style", null, CSS),
      source,
      h(
        "a",
        { href: url, className: "pl-previewTitle text-body", onClick: (event) => (event.preventDefault(), open()) },
        h("span", { className: "pl-id" }, id),
        " ",
        issue.name,
      ),
      h(
        "div",
        { className: "pl-metaRow" },
        h(StateChip, { state: issue.state }),
        assignee && h(Avatar, { user: assignee }),
        h(Refs, { refs: data.refs, compact: true }),
      ),
      card.error && h("p", { role: "alert", className: "m-0 text-body-sm text-danger" }, card.error),
      h(
        "div",
        { className: "pl-metaRow" },
        h(MoveMenu, {
          id,
          states: states.filter((st) => st.group !== "cancelled" || st.id === idOf(issue.state)),
          current: idOf(issue.state),
          busy: card.busy,
          onMove: (stateId) => void moveCard(link, stateId),
          trigger: ({ open: shown, busy, toggle }) =>
            h(
              Button,
              { "aria-haspopup": "menu", "aria-expanded": shown, disabled: busy, onClick: toggle },
              icon("arrows-exchange"),
              busy ? "Moving…" : "Move",
              icon("chevron-down", 14),
            ),
        }),
        h(Button, { onClick: () => open() }, icon("layout-kanban"), "Details"),
      ),
    );
  }

  // Plane's description as plain text blocks. The HTML is only parsed, never
  // rendered, so nothing in it runs or loads.
  const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, pre, blockquote";
  function blocksOf(issue) {
    const html = issue.description_html ?? "";
    if (!html.trim()) {
      const text = (issue.description_stripped ?? "").trim();
      return text ? [{ tag: "p", text }] : [];
    }
    const body = new DOMParser().parseFromString(html, "text/html").body;
    const leaves = [...body.querySelectorAll(BLOCKS)].filter((node) => !node.querySelector(BLOCKS));
    const blocks = (leaves.length ? leaves : [body]).map((node) => {
      const tag = node.localName === "pre" ? "pre" : "p";
      const text = tag === "pre" ? node.textContent : node.textContent.trim();
      return { tag, text: node.localName === "li" ? `• ${text}` : text };
    });
    return blocks.filter((block) => block.text.trim());
  }

  function CardPanel({ target }) {
    const link = parseLink(target);
    const { card } = useCard(link);
    const data = card?.data;
    const id = link.id ?? (data ? cardId(data.project, data.issue) : "");
    if (typeof ctx.panels.useTabTitle === "function") ctx.panels.useTabTitle(id || "Plane card");
    return h(CardDetails, { link });
  }

  // A card's details, in its side panel and in the board's details pane.
  function CardDetails({ link }) {
    const { card, s } = useCard(link);
    const data = card?.data;
    const id = link.id ?? (data ? cardId(data.project, data.issue) : "");
    if (s.key !== "saved")
      return h(
        "div",
        { className: "pl-panel" },
        h("style", null, CSS),
        h(Notice, { action: h(Button, { onClick: openSettings }, "Open Settings") }, connectionText(s.connection)),
      );
    if (!data)
      return h(
        "div",
        { className: "pl-panel" },
        h("style", null, CSS),
        h(
          Notice,
          { action: card?.error && h(Button, { onClick: () => void loadCard(link) }, "Try again") },
          card?.error || "Loading the card…",
        ),
      );
    const { issue, project, states } = data;
    const assignees = (issue.assignees ?? []).filter((a) => typeof a === "object");
    const labels = (issue.labels ?? []).filter((l) => typeof l === "object");
    const description = blocksOf(issue);
    const row = (label, value) =>
      h(
        React.Fragment,
        { key: label },
        h("dt", { className: "text-body-sm text-subtle" }, label),
        h("dd", { className: "text-body-sm" }, value),
      );
    return h(
      "div",
      { className: "pl-panel" },
      h("style", null, CSS),
      h("p", { className: "pl-id m-0" }, id),
      h("h2", { "data-buzz-ui": "", className: "m-0 text-title" }, issue.name),
      card.error && h("p", { role: "alert", className: "m-0 text-body-sm text-danger" }, card.error),
      h(
        "dl",
        { className: "pl-fields" },
        row(
          "State",
          h(MoveMenu, {
            id,
            states,
            current: idOf(issue.state),
            busy: card.busy,
            onMove: (stateId) => void moveCard(link, stateId),
            trigger: ({ open, busy, toggle }) =>
              h(
                "button",
                {
                  type: "button",
                  className: "pl-chip pl-state pl-stateButton",
                  "aria-haspopup": "menu",
                  "aria-expanded": open,
                  disabled: busy,
                  onClick: toggle,
                },
                stateIcon(issue.state, 14),
                h("span", null, busy ? "Moving…" : (issue.state?.name ?? "No state")),
                icon("chevron-down", 14),
              ),
          }),
        ),
        row(
          "Assignee",
          assignees.length
            ? h("span", { className: "pl-stack" }, assignees.map((a) => h(Avatar, { key: a.id, user: a })))
            : h(Avatar, { user: undefined }),
        ),
        row("Estimate", estimateOf(issue) || h("span", { className: "text-subtle" }, "None")),
        row(
          "Labels",
          labels.length
            ? h("span", { className: "pl-stack" }, labels.map((l) => h(LabelChip, { key: l.id, label: l })))
            : h("span", { className: "text-subtle" }, "None"),
        ),
        row("Project", project?.name ?? h("span", { className: "text-subtle" }, "Unknown")),
      ),
      description.length > 0 &&
        h(
          "div",
          { className: "pl-description text-body-sm" },
          description.map((block, index) => h(block.tag, { key: index }, block.text)),
        ),
      data.refs.length > 0 && h("h3", { className: "m-0 text-body-sm text-subtle" }, "Refs"),
      h(Refs, { refs: data.refs }),
      external(browseUrl(link.slug, id), [icon("external-link", 16, { key: "i" }), h("span", { key: "t" }, "Open in Plane")], {
        className: "pl-open text-body-sm",
      }),
    );
  }

  // Older hosts have no link previews; the panel and Settings still register.
  if (typeof ctx.conversation.registerLinkPreview === "function")
    ctx.conversation.registerLinkPreview({
      id: "card",
      title: "Plane card",
      matches: (url) => parseLink(url) !== null,
      component: CardPreview,
    });

  ctx.panels.register({
    id: "card",
    title: "Plane card",
    matches: (target) => parseLink(target) !== null,
    component: CardPanel,
  });

  // ---- Settings --------------------------------------------------------------

  function Field({ id, label, description, error, children }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-field", "data-invalid": error ? "" : undefined },
      h("label", { className: "buzz-field-label", htmlFor: id }, label),
      children,
      error
        ? h(
            "div",
            { className: "buzz-field-error-track" },
            h("div", { className: "buzz-field-error", role: "alert" }, error),
          )
        : description && h("p", { className: "buzz-field-description" }, description),
    );
  }

  function Input({ invalid, ...props }) {
    return h("input", {
      "data-buzz-ui": "",
      className: "buzz-input",
      "data-size": "md",
      "aria-invalid": invalid ? true : undefined,
      autoComplete: "off",
      spellCheck: false,
      ...props,
    });
  }

  function InputGroup({ trailing, children }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-input-group", "data-surface": "inset" },
      children,
      trailing && h("span", { className: "buzz-input-trailing" }, trailing),
    );
  }

  function Settings({ active }) {
    const s = useStore();
    const [draft, setDraft] = useState("");
    const [replacing, setReplacing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [keyError, setKeyError] = useState("");
    const [workspace, setWorkspace] = useState(s.workspace);
    const [menu, setMenu] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const menuRoot = useRef(null);
    const saved = s.key === "saved";
    const c = s.connection;

    useEffect(() => setWorkspace(s.workspace), [s.workspace]);
    useEffect(() => {
      if (!menu) return;
      const away = (event) => !menuRoot.current?.contains(event.target) && setMenu(false);
      document.addEventListener("pointerdown", away);
      return () => document.removeEventListener("pointerdown", away);
    }, [menu]);

    const run = async (action) => {
      if (!active() || busy) return;
      setBusy(true);
      setKeyError("");
      try {
        await action();
        setDraft("");
        setReplacing(false);
        setConfirm(false);
      } catch (failed) {
        setKeyError(failed.message);
        setConfirm(false);
      } finally {
        setBusy(false);
      }
    };
    const submitKey = () => {
      const value = draft.trim();
      if (value) void run(() => saveKey(value));
    };

    const good = c.status === "connected";
    const bad = ["refused", "unknown-workspace", "unreachable", "error"].includes(c.status);
    const status = h(
      "div",
      { className: "pl-status" },
      h(
        "p",
        { role: "status", className: `m-0 text-body-sm pl-statusText ${good ? "text-success" : bad ? "text-danger" : "text-subtle"}` },
        icon(good ? "circle-check" : bad ? "alert-circle" : c.status === "missing" ? "key" : "loader-2"),
        h("span", null, connectionText(c)),
      ),
      c.status === "unreachable" && h(Button, { disabled: busy, onClick: () => void refresh(true) }, "Try again"),
    );

    const serverUrl = h(
      Field,
      { id: "plane-server", label: "Server URL", description: "Set when Buzz was installed. You can't change it here yet." },
      h("p", { id: "plane-server", className: "pl-fixed text-body-sm" }, icon("lock", 14), h("span", { className: "pl-id" }, SERVER)),
    );

    const refused = c.status === "refused" && "Plane did not accept your key. Replace it to keep using Plane.";
    const keyField =
      saved && !replacing
        ? h(
            Field,
            {
              id: "plane-key",
              label: "Plane API key",
              description: "Saved in this Mac's Keychain.",
              error: keyError || refused,
            },
            h(
              InputGroup,
              {
                trailing: h(
                  "div",
                  { ref: menuRoot, className: "pl-menuRoot" },
                  h(IconButton, {
                    label: "API key actions",
                    "aria-haspopup": "menu",
                    "aria-expanded": menu,
                    disabled: busy,
                    onClick: () => setMenu(!menu),
                  }, icon("chevron-down")),
                  menu &&
                    h(
                      "div",
                      { className: "buzz-menu-positioner pl-menu" },
                      h(
                        "div",
                        { "data-buzz-ui": "", className: "buzz-menu-popup text-body-sm", "data-size": "compact", role: "menu" },
                        h("button", {
                          type: "button",
                          role: "menuitem",
                          className: "buzz-menu-item pl-menuItem",
                          "data-tone": "default",
                          onClick: () => {
                            setMenu(false);
                            setKeyError("");
                            setReplacing(true);
                          },
                        }, "Replace"),
                        h("button", {
                          type: "button",
                          role: "menuitem",
                          className: "buzz-menu-item pl-menuItem",
                          "data-tone": "danger",
                          onClick: () => {
                            setMenu(false);
                            setConfirm(true);
                          },
                        }, "Remove"),
                      ),
                    ),
                ),
              },
              h(Input, { id: "plane-key", type: "password", readOnly: true, value: "•".repeat(48), invalid: Boolean(refused), tabIndex: -1 }),
            ),
          )
        : h(
            Field,
            {
              id: "plane-key",
              label: "Plane API key",
              description: s.key === "checking" ? "Checking for a saved key…" : "Your key will be stored in this Mac's Keychain.",
              error: keyError,
            },
            h(
              InputGroup,
              {
                trailing: h(
                  "span",
                  { className: "pl-row" },
                  replacing && h(Button, { variant: "ghost", disabled: busy, onClick: () => (setReplacing(false), setDraft(""), setKeyError("")) }, "Cancel"),
                  h(Button, { variant: "prominent", disabled: busy || !draft.trim() || s.key === "checking", onClick: submitKey }, busy ? "Saving…" : "Save"),
                ),
              },
              h(Input, {
                id: "plane-key",
                type: "password",
                value: draft,
                readOnly: busy,
                invalid: Boolean(keyError),
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  submitKey();
                },
              }),
            ),
          );

    const slug = workspace.trim();
    const unknown = c.status === "unknown-workspace" && slug === s.workspace && `No workspace ${s.workspace} on ${host}.`;
    const workspaceField = h(
      Field,
      {
        id: "plane-workspace",
        label: "Workspace",
        description: h(
          React.Fragment,
          null,
          `The slug after the host in your Plane address: ${host}/`,
          h("strong", null, slug || "your-workspace"),
          "/",
        ),
        error: unknown,
      },
      h(Input, {
        id: "plane-workspace",
        value: workspace,
        placeholder: "your-workspace",
        invalid: Boolean(unknown),
        onChange: (event) => setWorkspace(event.target.value),
      }),
    );

    return h(
      "section",
      { "aria-label": "Plane settings" },
      h("style", null, CSS),
      h(
        "div",
        { "data-buzz-ui": "", className: "buzz-content-header" },
        h(
          "div",
          { className: "buzz-content-header-copy" },
          h("h2", { className: "buzz-content-header-title" }, "Plane"),
          h("p", { className: "buzz-content-header-subtitle" }, "Show your Plane board, your cards and card links in Buzz."),
        ),
      ),
      h(
        "div",
        { className: "grid grid-cols-1 gap-section-gap" },
        h(
          "div",
          { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": "" },
          h("div", { className: "buzz-content-header-copy" }, h("h3", { className: "buzz-content-header-title" }, "Connection")),
        ),
        h(
          "div",
          { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "form" },
          status,
          serverUrl,
          keyField,
          workspaceField,
          h(
            "div",
            { className: "pl-actions" },
            h(
              Button,
              {
                variant: "prominent",
                disabled: !active() || slug === s.workspace || !/^[a-z0-9_-]*$/i.test(slug),
                onClick: () => active() && saveWorkspace(slug),
              },
              "Save",
            ),
          ),
        ),
      ),
      confirm &&
        h(
          React.Fragment,
          null,
          h("div", { "data-buzz-ui": "", className: "buzz-dialog-backdrop", "data-alert-dialog": "" }),
          h(
            "div",
            {
              "data-buzz-ui": "",
              className: "buzz-dialog gap-0",
              role: "alertdialog",
              "aria-modal": true,
              "aria-labelledby": "plane-remove-title",
              "data-size": "compact",
              "data-height": "content",
              onKeyDown: (event) => event.key === "Escape" && !busy && setConfirm(false),
            },
            h(
              "header",
              { className: "buzz-dialog-header" },
              h(
                "div",
                { className: "buzz-dialog-heading" },
                h("h2", { id: "plane-remove-title", className: "text-label" }, "Remove Plane API key?"),
                h(
                  "p",
                  { className: "buzz-dialog-description" },
                  "This removes the key from this Mac's Keychain. Add a key again to keep using Plane.",
                ),
              ),
            ),
            h(
              "div",
              { className: "buzz-dialog-actions" },
              h(Button, { variant: "ghost", disabled: busy, autoFocus: true, onClick: () => setConfirm(false) }, "Cancel"),
              h(Button, { variant: "destructive", disabled: busy, onClick: () => void run(clearKey) }, busy ? "Removing…" : "Remove key"),
            ),
          ),
        ),
    );
  }

  ctx.settingsCards.register({
    id: "plane",
    title: "Plane",
    group: "Plugins",
    component: ({ active }) => h(Settings, { active }),
  });
}

const STATE_ICONS = {
  backlog: "circle-dashed",
  unstarted: "circle",
  started: "circle-half-2",
  completed: "circle-check",
  cancelled: "circle-x",
};

// Tabler Icons (MIT), outline paths.
const ICONS = {
  "alert-circle": ["M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0", "M12 8v4", "M12 16h.01"],
  "arrows-exchange": ["M7 10h14l-4 -4", "M17 14h-14l4 4"],
  check: ["M5 12l5 5l10 -10"],
  "chevron-down": ["M6 9l6 6l6 -6"],
  "circle-check": ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M9 12l2 2l4 -4"],
  "circle-dashed": [
    "M8.56 3.69a9 9 0 0 0 -2.92 1.95",
    "M3.69 8.56a9 9 0 0 0 -.69 3.44",
    "M3.69 15.44a9 9 0 0 0 1.95 2.92",
    "M8.56 20.31a9 9 0 0 0 3.44 .69",
    "M15.44 20.31a9 9 0 0 0 2.92 -1.95",
    "M20.31 15.44a9 9 0 0 0 .69 -3.44",
    "M20.31 8.56a9 9 0 0 0 -1.95 -2.92",
    "M15.44 3.69a9 9 0 0 0 -3.44 -.69",
  ],
  "circle-half-2": ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M12 3v18", "M12 14l7 -7", "M12 19l8.5 -8.5", "M12 9l4.5 -4.5"],
  "circle-x": ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M10 10l4 4m0 -4l-4 4"],
  circle: ["M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"],
  "external-link": ["M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6", "M11 13l9 -9", "M15 4h5v5"],
  "git-commit": ["M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0", "M12 3l0 6", "M12 15l0 6"],
  "git-pull-request": [
    "M6 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M18 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0",
    "M6 8l0 8",
    "M11 6h5a2 2 0 0 1 2 2v8",
    "M14 9l-3 -3l3 -3",
  ],
  hourglass: [
    "M6.5 7h11",
    "M6.5 17h11",
    "M6 20v-2a6 6 0 1 1 12 0v2a1 1 0 0 1 -1 1h-10a1 1 0 0 1 -1 -1z",
    "M6 4v2a6 6 0 1 0 12 0v-2a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1z",
  ],
  key: [
    "M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0z",
    "M15 9h.01",
  ],
  "layout-kanban": [
    "M4 4l6 0",
    "M14 4l6 0",
    "M4 8m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z",
    "M14 8m0 2a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2z",
  ],
  link: [
    "M9 15l6 -6",
    "M11 6l.463 -.536a5 5 0 0 1 7.071 7.072l-.534 .464",
    "M13 18l-.397 .534a5.068 5.068 0 0 1 -7.127 0a4.972 4.972 0 0 1 0 -7.071l.524 -.463",
  ],
  "loader-2": ["M12 3a9 9 0 1 0 9 9"],
  lock: [
    "M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z",
    "M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0",
    "M8 11v-4a4 4 0 1 1 8 0v4",
  ],
  refresh: ["M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4", "M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"],
  "user-circle": [
    "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
    "M12 10m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
    "M6.168 18.849a4 4 0 0 1 3.832 -2.849h4a4 4 0 0 1 3.834 2.855",
  ],
  x: ["M18 6l-12 12", "M6 6l12 12"],
};

// Host tokens only, so light and dark themes both work. Classes are prefixed "pl-".
const CSS = `
.pl-page { display: flex; flex-direction: column; gap: var(--space-3); height: 100%; min-height: 0; padding: var(--space-panel-inset); box-sizing: border-box; }
.pl-title { display: flex; align-items: center; gap: var(--space-2); }
.pl-actions { align-items: center; }
.pl-switch { margin-inline-end: var(--space-2); }
.pl-toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
.pl-picker { position: relative; display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3); border: 1px solid var(--border-standard); border-radius: var(--radius-pill); font-size: var(--text-body-sm); }
.pl-picker select { appearance: none; background: transparent; border: 0; color: var(--text); font: inherit; padding-inline-end: var(--space-1); cursor: pointer; }
.pl-picker select:focus-visible { outline: none; }
.pl-picker:focus-within { border-color: var(--border-focus); }
.pl-board { display: flex; gap: var(--space-3); flex: 1; min-height: 0; }
.pl-columns { display: flex; gap: var(--space-3); flex: 1; min-width: 0; min-height: 0; overflow-x: auto; padding-bottom: var(--space-2); }
.pl-column { display: flex; flex-direction: column; flex: 1 0 16rem; max-width: 22rem; min-height: 0; border-radius: var(--radius-card); background: var(--surface-panel); }
.pl-columnTitle { display: flex; align-items: center; gap: var(--space-2); margin: 0; padding: var(--space-3) var(--space-3) var(--space-2); font-weight: 600; }
.pl-columnTitle > svg { flex-shrink: 0; }
.pl-columnCards { display: flex; flex-direction: column; gap: var(--space-2); flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--space-2) var(--space-2); }
.pl-empty { margin: 0; padding: var(--space-2) var(--space-1); }
.pl-card { position: relative; display: flex; flex-direction: column; gap: var(--space-2); flex-shrink: 0; padding: var(--space-3); border: 1px solid var(--border-standard); border-radius: var(--radius-card-compact, var(--radius-card)); background: var(--surface-elevated); }
.pl-card:hover { border-color: var(--border-prominent); }
.pl-card[data-selected] { border-color: var(--border-focus); }
.pl-card:has(.pl-cardTitle:focus-visible) { outline: 2px solid var(--border-focus); outline-offset: 2px; }
.pl-cardFoot { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); min-width: 0; }
.pl-cardTitle { padding: 0; border: 0; background: none; color: var(--text); font: inherit; text-align: start; overflow-wrap: anywhere; cursor: pointer; }
.pl-cardTitle:focus-visible { outline: none; }
.pl-cardTitle::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
.pl-id { font-family: var(--buzz-mono-family, var(--font-system-mono)); font-size: var(--text-body-sm); color: var(--text-subtle); white-space: nowrap; }
.pl-chip { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 0; max-width: 100%; padding: 0 var(--space-2); border-radius: var(--radius-chip); background: var(--surface-hover); color: var(--text); font-size: var(--text-body-sm); line-height: 1.6; white-space: nowrap; }
.pl-chip > svg { flex-shrink: 0; color: var(--text-subtle); }
.pl-dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; }
.pl-drawer { display: flex; flex-direction: column; flex: 0 0 26rem; min-height: 0; overflow-y: auto; border: 1px solid var(--border-standard); border-radius: var(--radius-card); background: var(--surface-elevated); }
.pl-drawerBar { position: sticky; top: 0; display: flex; justify-content: flex-end; padding: var(--space-2) var(--space-2) 0; background: inherit; }
.pl-drawer .pl-panel { padding: 0 var(--space-4) var(--space-4); }
.pl-description { display: flex; flex-direction: column; gap: var(--space-2); overflow-wrap: anywhere; }
.pl-description p, .pl-description pre { margin: 0; }
.pl-description pre { white-space: pre-wrap; font-family: var(--buzz-mono-family, var(--font-system-mono)); }
.pl-state { border-radius: var(--radius-pill); }
.pl-stateButton { border: 0; cursor: pointer; font: inherit; }
.pl-stateButton:disabled { cursor: progress; }
.pl-person { display: inline-flex; align-items: center; gap: var(--space-1h, var(--space-2)); min-width: 0; font-size: var(--text-body-sm); color: var(--text-subtle); }
.pl-avatar { display: inline-grid; place-items: center; flex-shrink: 0; width: 18px; height: 18px; border-radius: 50%; background: var(--surface-accent); color: var(--text); font-size: 9px; font-weight: 600; }
.pl-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-notice { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3); padding: var(--space-4); }
.pl-preview { display: flex; flex-direction: column; gap: var(--space-2); max-width: 36rem; padding: var(--space-3); border: 1px solid var(--border-standard); border-radius: var(--radius-card); background: var(--surface-elevated); }
.pl-source { display: flex; align-items: center; gap: var(--space-1); margin: 0; }
.pl-previewTitle { color: var(--text); text-decoration: none; font-weight: 600; overflow-wrap: anywhere; }
.pl-previewTitle:hover { text-decoration: underline; }
.pl-metaRow { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.pl-meta { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-body-sm); color: var(--text-subtle); }
.pl-menuRoot { position: relative; display: inline-flex; }
.pl-menu { position: absolute; top: calc(100% + 4px); left: 0; min-width: 13rem; }
.pl-menuTitle { margin: 0; padding: var(--space-1) var(--space-2); }
.pl-menuItem { display: flex; align-items: center; gap: var(--space-2); width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.pl-menuItem:hover, .pl-menuItem:focus-visible { background: var(--surface-hover); outline: none; }
.pl-grow { flex: 1; }
.pl-panel { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-panel-inset); }
.pl-fields { display: grid; grid-template-columns: max-content 1fr; align-items: center; gap: var(--space-2) var(--space-6); margin: var(--space-2) 0; }
.pl-fields dd { margin: 0; min-width: 0; }
.pl-stack { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.pl-refs { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.pl-ref { display: flex; align-items: center; gap: var(--space-2); min-width: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-card-compact, var(--radius-card)); background: var(--surface-panel); color: var(--text); text-decoration: none; }
.pl-ref > svg { flex-shrink: 0; color: var(--text-subtle); }
.pl-ref:hover { background: var(--surface-hover); }
.pl-refLabel { white-space: nowrap; }
.pl-open { display: inline-flex; align-items: center; gap: var(--space-1); align-self: flex-start; color: var(--text-subtle); text-decoration: none; }
.pl-open:hover { color: var(--text); }
.pl-status { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.pl-statusText { display: flex; align-items: center; gap: var(--space-2); }
.pl-statusText > svg { flex-shrink: 0; }
.pl-fixed { display: flex; align-items: center; gap: var(--space-2); margin: 0; color: var(--text-subtle); }
.pl-row { display: flex; align-items: center; gap: var(--space-1); }
.pl-actions { display: flex; justify-content: flex-end; }
`;
