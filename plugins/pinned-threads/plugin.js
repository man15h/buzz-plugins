// Pinned threads: keep threads and channels one click away.
// "Pin thread" leads a thread tab's right-click menu, "Pin channel" is in a
// message's menu, and pins show as tabs on their own row below the title bar,
// with the sidebar's unread and agent-working marks. A pinned tab's own menu
// renames, colours or unpins it.
//
// That needs a Buzz with `titleBarRow` on panels and
// `conversation.registerThreadTabAction`. Without them, the tabs sit in the
// title bar right of Search and Pin thread is in a message's menu as well
// (README.md, "Requirements"). Pins are kept in this Mac's localStorage, per
// community and account.

export const inject = ["conversation", "navigation", "panels", "react", "relay"];

const PINS_KEY = "buzz-pinned-threads.pins";
// Tabs shrink to this width before the rest go behind +N (rem).
const MIN_TAB_REM = 9;
// Beside Search, the tabs leave it this much of the half width (rem).
const SEARCH_ROOM_REM = 16;
const COLORS = [
  ["red", "Red", "var(--red-9)"],
  ["orange", "Orange", "var(--orange-9)"],
  ["yellow", "Yellow", "var(--amber-9)"],
  ["green", "Green", "var(--green-9)"],
  ["teal", "Teal", "var(--cyan-9)"],
  ["blue", "Blue", "var(--blue-9)"],
  ["purple", "Purple", "var(--purple-9)"],
  // The host has no pink scale; this is the Radix pink 9 its others follow.
  ["pink", "Pink", "#d6409f"],
];
const colorValue = (id) => COLORS.find(([key]) => key === id)?.[2];

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const { useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore } = React;

  // ---- Pins: { scope, channelId, rootId, title, name?, color? } -----------
  // A channel pin has `channel: true` and `private?` in place of `rootId`.

  let pins = load();
  const listeners = new Set();
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  function load() {
    try {
      const value = JSON.parse(localStorage.getItem(PINS_KEY) || "[]");
      return Array.isArray(value)
        ? value.filter((pin) => pin && pin.scope && pin.channelId && (pin.rootId || pin.channel))
        : [];
    } catch {
      return [];
    }
  }
  function save(next) {
    pins = next;
    try {
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
    } catch {
      // Without storage the pins last until Buzz quits.
    }
    for (const listener of listeners) listener();
  }
  const same = (pin, scope, rootId) => pin.scope === scope && !pin.channel && pin.rootId === rootId;
  const find = (scope, rootId) => pins.find((pin) => same(pin, scope, rootId));
  const findChannel = (scope, channelId) =>
    pins.find((pin) => pin.scope === scope && pin.channel && pin.channelId === channelId);
  const pinKey = (pin) => (pin.channel ? `channel:${pin.channelId}` : pin.rootId);
  const update = (pin, patch) => save(pins.map((item) => (item === pin ? { ...item, ...patch } : item)));
  const unpin = (pin) => save(pins.filter((item) => item !== pin));
  const pin = (scope, channelId, rootId, title) =>
    find(scope, rootId) || save([...pins, { scope, channelId, rootId, title }]);
  const pinChannel = (scope, channel) =>
    findChannel(scope, channel.id) ||
    save([...pins, { scope, channelId: channel.id, channel: true, private: isPrivate(channel) || undefined, title: channel.name }]);

  const relaySnapshot = () => ctx.relay.snapshot();
  const currentScope = () => relaySnapshot()?.scope;

  // ---- Pin / Unpin in a thread tab's menu ---------------------------------

  const threadTabs = typeof ctx.conversation.registerThreadTabAction === "function";
  if (threadTabs) {
    ctx.conversation.registerThreadTabAction({
      id: "pin",
      label: (thread) => (find(currentScope(), thread.rootId) ? "Unpin thread" : "Pin thread"),
      run(thread) {
        const scope = currentScope();
        if (!scope) return;
        const pinned = find(scope, thread.rootId);
        if (pinned) unpin(pinned);
        else pin(scope, thread.channelId, thread.rootId, thread.label);
      },
    });
  } else {
    // Older Buzz: Pin / Unpin in a message's menu, for the thread it's in. The
    // host reads `matches` when the row renders, so each item only does what
    // its name says, even if a pin changed since.
    const rootOf = (message) => message.threadRootId || message.id;
    const messageAction = (id, title, pinned, run) =>
      ctx.conversation.registerMessageAction({
        id,
        title,
        icon: () => icon(PIN, 16),
        matches: (message) => !!find(currentScope(), rootOf(message)) === pinned,
        component: function PinAction({ message, session, close }) {
          useEffect(() => {
            const scope = currentScope();
            if (scope) run(scope, message, session);
            close();
          }, []);
          return null;
        },
      });
    messageAction("pin", "Pin thread", false, (scope, message, session) =>
      pin(scope, message.channelId, rootOf(message), threadTitle(session, message.channelId, rootOf(message))),
    );
    messageAction("unpin", "Unpin thread", true, (scope, message) => {
      const pinned = find(scope, rootOf(message));
      if (pinned) unpin(pinned);
    });
  }

  // ---- Pin / Unpin channel in a message's menu ------------------------------

  // Buzz has no plugin item in a channel's sidebar menu, so this is the one
  // place to pin a channel. A channel with no messages can't be pinned yet.
  const channelOf = (session, channelId) => {
    try {
      return session.channels.list().channels.find((channel) => channel.id === channelId);
    } catch {
      return undefined;
    }
  };
  const isPrivate = (channel) => !!channel.private || channel.visibility === "private";
  // DMs, Solo chats and system channels aren't channels to pin.
  const pinnable = (channel) => !!channel && !["dm", "solo", "system"].includes(channel.channelType);
  const channelAction = (id, title, pinned, run) =>
    ctx.conversation.registerMessageAction({
      id,
      title,
      icon: () => icon(PIN, 16),
      matches: (message, session) =>
        pinnable(channelOf(session, message.channelId)) && !!findChannel(currentScope(), message.channelId) === pinned,
      component: function PinChannelAction({ message, session, close }) {
        useEffect(() => {
          const scope = currentScope();
          const channel = channelOf(session, message.channelId);
          if (scope && channel) run(scope, channel);
          close();
        }, []);
        return null;
      },
    });
  channelAction("pin-channel", "Pin channel", false, pinChannel);
  channelAction("unpin-channel", "Unpin channel", true, (scope, channel) => {
    const pinned = findChannel(scope, channel.id);
    if (pinned) unpin(pinned);
  });

  // The thread tab's own title: the root's text, else "Thread · channel".
  function threadTitle(session, channelId, rootId) {
    try {
      const root = session.channels.window(channelId).rows.find((row) => row.id === rootId);
      const text = root?.content
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~>#]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      if (text) return text;
      const name = session.channels.list().channels.find((channel) => channel.id === channelId)?.name;
      return name ? `Thread · ${name}` : "Thread";
    } catch {
      return "Thread";
    }
  }

  // ---- Opening a pinned thread --------------------------------------------

  function open(pin) {
    const { viewer } = relaySnapshot() ?? {};
    if (!viewer || !pin.scope.endsWith(`:${viewer}`)) return;
    void ctx.navigation.open({
      version: 1,
      kind: "conversation",
      scope: { viewer, communityOrigin: pin.scope.slice(0, -(viewer.length + 1)) },
      channelId: pin.channelId,
      ...(pin.channel ? {} : { messageId: pin.rootId, threadRootId: pin.rootId }),
    });
  }

  // ---- Marks: unread and agent working, as the sidebar shows them ---------

  function useSession() {
    return useSyncExternalStore(ctx.relay.subscribe, () => {
      const snapshot = relaySnapshot();
      return snapshot?.status === "ready" ? snapshot.session : undefined;
    });
  }

  // "unread" | "attention" | "", from the thread's or channel's read state.
  function useUnread(session, pin) {
    const target = pin.channel
      ? { kind: "channel", channelId: pin.channelId }
      : { kind: "thread", channelId: pin.channelId, rootId: pin.rootId };
    const read = () => {
      try {
        const snapshot = session?.unread?.snapshot(target);
        if (snapshot?.attentionCount) return "attention";
        return snapshot?.observedCount ? "unread" : "";
      } catch {
        return "";
      }
    };
    return useSyncExternalStore(
      (listener) => session?.unread?.subscribe(target, listener) ?? (() => {}),
      read,
    );
  }

  function useWorking(session, pin) {
    const read = () => {
      const snapshot = session?.agentActivity?.snapshot();
      if (!snapshot) return false;
      // A channel pin counts an agent working anywhere in the channel.
      const here = (row) => row.channelId === pin.channelId && (pin.channel || row.threadRootId === pin.rootId);
      return (
        (snapshot.local ?? []).some(
          (row) => (pin.channel || row.thread) && here(row) && (row.state === "working" || row.state === "waiting"),
        ) ||
        (snapshot.status === "listening" &&
          (snapshot.turns.some((turn) => here(turn) && turn.state === "working") || snapshot.typing.some(here)))
      );
    };
    return useSyncExternalStore((listener) => session?.agentActivity?.subscribe(listener) ?? (() => {}), read);
  }

  // ---- The row -------------------------------------------------------------

  // `bar` puts the tabs in the title bar beside Search instead of their row.
  function PinnedRow({ bar }) {
    const all = useSyncExternalStore(subscribe, () => pins);
    const session = useSession();
    const scope = relaySnapshot()?.scope;
    const shown = all.filter((pin) => pin.scope === scope);
    const row = useRef(null);
    const [width, setWidth] = useState(0);
    const [menu, setMenu] = useState(); // { pin, x, y } | { more: true, x, y }
    const [renaming, setRenaming] = useState();

    // Agent activity only streams while something asks for it.
    useEffect(() => (shown.length ? session?.agentActivity?.activate?.() : undefined), [session, shown.length > 0]);
    useLayoutEffect(() => {
      const element = row.current;
      if (!element) return;
      // In the title bar the nav is as wide as its tabs, so count against the
      // room the bar allows it (the CSS max-width), not its own width.
      if (bar) {
        const measure = () => {
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
          setWidth(Math.max((MIN_TAB_REM + 4) * rem, window.innerWidth / 2 - SEARCH_ROOM_REM * rem));
        };
        window.addEventListener("resize", measure);
        measure();
        return () => window.removeEventListener("resize", measure);
      }
      const observer = new ResizeObserver(() => setWidth(element.clientWidth));
      observer.observe(element);
      setWidth(element.clientWidth);
      return () => observer.disconnect();
    }, [bar, shown.length > 0]);

    if (!shown.length) return null;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    // Each tab after the first also takes the row's gap.
    const gap = parseFloat(getComputedStyle(row.current ?? document.documentElement).columnGap) || 0;
    const count = (room) => Math.max(1, Math.floor((room + gap) / (MIN_TAB_REM * rem + gap)));
    // Room for the +N button comes out of the last tab's space.
    const visible = shown.length <= count(width) ? shown : shown.slice(0, count(width - 4 * rem - gap));
    const hidden = shown.slice(visible.length);
    const at = (event) => {
      const box = event.currentTarget.getBoundingClientRect();
      return event.type === "contextmenu" && event.clientX
        ? { x: event.clientX, y: event.clientY }
        : { x: box.left, y: box.bottom + 4 };
    };

    return h(
      "nav",
      { ref: row, className: "pt-row", "data-bar": bar ? "" : undefined, "aria-label": "Pinned threads" },
      h("style", null, CSS),
      visible.map((pin) =>
        renaming === pin
          ? h(Rename, { key: pinKey(pin), pin, done: () => setRenaming(undefined) })
          : h(PinnedTab, {
              key: pinKey(pin),
              pin,
              session,
              onOpen: () => open(pin),
              onMenu: (event) => {
                event.preventDefault();
                setMenu({ pin, ...at(event) });
              },
            }),
      ),
      hidden.length > 0 &&
        h(
          "button",
          {
            type: "button",
            className: "pt-more",
            "aria-haspopup": "menu",
            "aria-expanded": !!menu?.more,
            "aria-label": `${hidden.length} more pinned threads`,
            onClick: (event) => setMenu({ more: true, ...at(event) }),
          },
          `+${hidden.length}`,
          icon(CHEVRON, 12),
        ),
      menu?.pin &&
        h(TabMenu, {
          ...menu,
          close: () => setMenu(undefined),
          rename: () => setRenaming(menu.pin),
        }),
      menu?.more &&
        h(
          Menu,
          { x: menu.x, y: menu.y, label: "More pinned threads", close: () => setMenu(undefined) },
          hidden.map((pin) =>
            h(
              MenuItem,
              {
                key: pinKey(pin),
                onClick: () => {
                  setMenu(undefined);
                  open(pin);
                },
              },
              h(PinLabel, { pin, session }),
            ),
          ),
        ),
    );
  }

  function PinnedTab({ pin, session, onOpen, onMenu }) {
    return h(
      "button",
      {
        type: "button",
        className: "pt-tab",
        title: pin.name || pin.title,
        onClick: onOpen,
        onContextMenu: onMenu,
        onKeyDown: (event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) onMenu(event);
        },
      },
      h(PinLabel, { pin, session }),
    );
  }

  // Icon in the pin's colour (# or a lock for a channel), title (bold while
  // unread), then the marks.
  function PinLabel({ pin, session }) {
    const unread = useUnread(session, pin);
    const working = useWorking(session, pin);
    const color = colorValue(pin.color);
    return h(
      React.Fragment,
      null,
      icon(pin.channel ? (pin.private ? LOCK : HASH) : THREAD, 16, { style: color ? { color } : undefined }),
      h("span", { className: "pt-label", "data-unread": unread ? "" : undefined }, pin.name || pin.title),
      unread === "attention" && h("span", { className: "pt-dot", role: "img", "aria-label": "Mentions or replies" }),
      working &&
        h(
          "span",
          { className: "pt-working", role: "img", "aria-label": "Agent working" },
          h("span", null),
          h("span", null),
          h("span", null),
        ),
    );
  }

  function Rename({ pin, done }) {
    const input = useRef(null);
    const finished = useRef(false);
    useEffect(() => {
      input.current?.focus();
      input.current?.select();
    }, []);
    const finish = (value) => {
      if (finished.current) return;
      finished.current = true;
      // A blank name restores the thread's or channel's own title.
      if (value !== undefined) update(pin, { name: value.trim() || undefined });
      done();
    };
    return h("input", {
      ref: input,
      className: "pt-rename",
      "aria-label": "Pinned tab name",
      defaultValue: pin.name || pin.title,
      onKeyDown: (event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish();
      },
      onBlur: (event) => finish(event.currentTarget.value),
    });
  }

  function TabMenu({ pin, x, y, close, rename }) {
    const [colors, setColors] = useState(false);
    return h(
      Menu,
      { x, y, label: `Actions for ${pin.name || pin.title}`, close },
      h(MenuItem, { onClick: () => (close(), rename()) }, "Rename"),
      h(
        MenuItem,
        { "aria-haspopup": "menu", "aria-expanded": colors, onClick: () => setColors(!colors) },
        h("span", { className: "pt-grow" }, "Color"),
        icon(CHEVRON_RIGHT, 14),
      ),
      colors &&
        h(
          "div",
          { className: "pt-swatches", role: "group", "aria-label": "Color" },
          [["", "None"], ...COLORS].map(([id, label, value]) =>
            h(
              MenuItem,
              {
                key: id || "none",
                role: "menuitemradio",
                "aria-checked": (pin.color || "") === id,
                onClick: () => (close(), update(pin, { color: id || undefined })),
              },
              h("span", { className: "pt-swatch", "data-none": id ? undefined : "", style: value ? { background: value } : undefined }),
              h("span", { className: "pt-grow" }, label),
              (pin.color || "") === id && icon(CHECK, 14),
            ),
          ),
        ),
      h(MenuItem, { onClick: () => (close(), unpin(pin)) }, pin.channel ? "Unpin channel" : "Unpin thread"),
    );
  }

  // A small popup menu: Escape or a click outside closes it, arrows move, and
  // focus goes back to what opened it.
  function Menu({ x, y, label, close, children }) {
    const ref = useRef(null);
    useEffect(() => {
      const trigger = document.activeElement;
      const first = ref.current?.querySelector('[role^="menuitem"]');
      first?.focus();
      const outside = (event) => ref.current && !ref.current.contains(event.target) && close();
      document.addEventListener("pointerdown", outside, true);
      return () => {
        document.removeEventListener("pointerdown", outside, true);
        if (trigger?.isConnected && (!document.activeElement || document.activeElement === document.body || ref.current?.contains(document.activeElement))) trigger.focus();
      };
    }, []);
    return h(
      "div",
      {
        ref,
        role: "menu",
        "aria-label": label,
        className: "pt-menu",
        style: { left: Math.min(x, window.innerWidth - 240), top: y },
        onKeyDown: (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
            return;
          }
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const items = [...ref.current.querySelectorAll('[role^="menuitem"]')];
          const next = items.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1);
          items[(next + items.length) % items.length]?.focus();
        },
      },
      children,
    );
  }

  function MenuItem({ children, ...props }) {
    return h("button", { type: "button", role: "menuitem", tabIndex: -1, className: "pt-item", ...props }, children);
  }

  // Tabler outline paths, the icon set Buzz itself uses.
  function icon(paths, size, props) {
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
        className: "pt-icon",
        ...props,
      },
      ...paths.map((d) => h("path", { key: d, d })),
    );
  }

  ctx.panels.register({
    id: "pinned-threads",
    title: "Pinned threads",
    matches: () => false,
    ...(threadTabs ? { titleBarRow: PinnedRow } : { toolbar: () => h(PinnedRow, { bar: true }) }),
    component: () => null,
  });
}

// message-reply, hash, lock, chevron-down, chevron-right, check, pin
const THREAD = [
  "M18 4a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-5l-5 3v-3h-2a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3h12z",
  "M11 8l-3 3l3 3",
  "M16 11h-8",
];
const HASH = ["M5 9l14 0", "M5 15l14 0", "M11 4l-4 16", "M17 4l-4 16"];
const LOCK = [
  "M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6z",
  "M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0",
  "M8 11v-4a4 4 0 1 1 8 0v4",
];
const CHEVRON = ["M6 9l6 6l6 -6"];
const CHEVRON_RIGHT = ["M9 6l6 6l-6 6"];
const CHECK = ["M5 12l5 5l10 -10"];
const PIN = ["M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4", "M9 15l-4.5 4.5", "M14.5 4l5.5 5.5"];

const CSS = `
.pt-row { display: flex; align-items: center; gap: var(--space-1); min-width: 0; padding-block: var(--space-1); }
/* The title bar sizes its actions to their content, so the tabs set their own
   limit there and Search keeps ${SEARCH_ROOM_REM}rem of its half. */
.pt-row[data-bar] { width: max-content; max-width: max(${MIN_TAB_REM + 4}rem, calc(50vw - ${SEARCH_ROOM_REM}rem)); padding-block: 0; }
.pt-tab, .pt-more { display: inline-flex; align-items: center; gap: var(--space-2); height: var(--size-control-sm); padding: 0 var(--space-3); border: 0; border-radius: var(--radius-pill); background: transparent; color: var(--text-subtle); font: inherit; font-size: var(--text-body-sm); cursor: pointer; }
.pt-tab { flex: 0 1 14rem; min-width: ${MIN_TAB_REM}rem; }
.pt-more { flex: none; gap: var(--space-1); }
.pt-tab:hover, .pt-more:hover, .pt-more[aria-expanded="true"] { background: var(--affordance-subtle-hover); color: var(--text-standard); }
.pt-tab:focus-visible, .pt-more:focus-visible, .pt-item:focus-visible, .pt-rename:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 1px; }
.pt-icon { flex: none; }
.pt-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pt-label[data-unread] { color: var(--text-navigation-unread); font-weight: var(--type-weight-semibold); }
.pt-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--text-navigation-unread); }
.pt-working { flex: none; display: inline-flex; align-items: center; gap: 2px; }
.pt-working > span { width: 3px; height: 3px; border-radius: 50%; background: currentColor; animation: pt-pulse 1.2s ease-in-out infinite; }
.pt-working > span:nth-child(2) { animation-delay: 0.2s; }
.pt-working > span:nth-child(3) { animation-delay: 0.4s; }
@keyframes pt-pulse { 0%, 80%, 100% { opacity: 0.3; } 40% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .pt-working > span { animation: none; opacity: 0.7; } }
.pt-rename { flex: 0 1 14rem; min-width: ${MIN_TAB_REM}rem; height: var(--size-control-sm); padding: 0 var(--space-3); border: 1px solid var(--border-focus); border-radius: var(--radius-pill); background: var(--surface-popover); color: var(--text-standard); font: inherit; font-size: var(--text-body-sm); }
.pt-menu { position: fixed; z-index: 50; display: flex; flex-direction: column; min-width: 11rem; padding: var(--space-1); border: 1px solid var(--border-standard); border-radius: var(--space-3); background: var(--surface-popover); box-shadow: var(--shadow-sm); }
.pt-item { display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: 1.75rem; padding: 0 var(--space-2); border: 0; border-radius: var(--space-2); background: transparent; color: var(--text-standard); font: inherit; font-size: var(--text-body-sm); text-align: start; cursor: pointer; }
.pt-item:hover, .pt-item:focus-visible { background: var(--affordance-subtle-hover); }
.pt-grow { flex: 1; }
.pt-swatches { display: flex; flex-direction: column; margin-inline-start: var(--space-3); }
.pt-swatch { flex: none; width: 10px; height: 10px; border-radius: 50%; }
.pt-swatch[data-none] { border: 1px solid var(--text-subtle); }
`;
