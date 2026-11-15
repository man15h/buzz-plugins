// GitHub CI: a CI tab in a channel's side pane showing the linked GitHub
// repo's open pull requests with their checks, and the runs each merge into
// the watched branch started.
//
// The channel stores only the repo and branch, in a kind 30078 event a channel
// owner or admin signs (README.md, "Repo link"). Each viewer reads GitHub with
// their own credential: a token saved in Settings, else their gh sign-in.

export const inject = ["host", "panels", "react", "relay", "settingsCards"];

const API = "https://api.github.com";
const TOKEN_KEY = "buzz-plugins.github-ci.token.v1";
const TOKEN_CHANGED = "buzz-plugins-github-ci-token-changed";
const LINK_KIND = 30078;
const MAX_PRS = 20;
const MAX_MERGES = 5;
const REFRESH_MS = 120_000;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const linkTag = (channelId) => `buzz-plugins.github-ci.link:${channelId}`;

// Worst first: a PR's state is its worst check's.
const ORDER = ["failing", "running", "queued", "passing", "skipped"];
const STATE_LABEL = {
  failing: "failing",
  running: "running",
  queued: "queued",
  passing: "passing",
  skipped: "skipped",
};
const worst = (states) => ORDER.find((state) => states.includes(state)) ?? "none";

// A failed read, by what the viewer can do about it. Messages never carry the
// token or a response body.
class ReadError extends Error {
  constructor(code, login) {
    super(code);
    this.code = code;
    this.login = login;
  }
}

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const relay = ctx.relay;

  // --- Token: one device-local key, unencrypted (README.md, "Token storage").

  function readToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  }
  function writeToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
    tokenState = { token, status: "unchecked" };
    window.dispatchEvent(new Event(TOKEN_CHANGED));
  }
  function subscribeToken(listener) {
    const storage = (event) => {
      if (event.key === TOKEN_KEY || event.key === null) listener();
    };
    window.addEventListener(TOKEN_CHANGED, listener);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(TOKEN_CHANGED, listener);
      window.removeEventListener("storage", storage);
    };
  }

  // What GitHub last said about the saved token: unchecked, ok (with login and
  // expiry) or rejected. Kept per token, so replacing it starts over.
  let tokenState = { token: "", status: "unchecked" };
  const currentTokenState = () => {
    const token = readToken();
    if (tokenState.token !== token) tokenState = { token, status: "unchecked" };
    return tokenState;
  };
  function setTokenState(token, next) {
    if (readToken() !== token) return;
    tokenState = { token, ...next };
    window.dispatchEvent(new Event(TOKEN_CHANGED));
  }
  const useTokenState = () => React.useSyncExternalStore(subscribeToken, currentTokenState);

  // --- Small shared stores: the launcher badge and Settings' repo list.

  function store(initial) {
    let value = initial;
    const listeners = new Set();
    return {
      get: () => value,
      set(next) {
        value = next;
        for (const listener of listeners) listener();
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
  // channelId → failing PR count, from the last read shown in this session.
  const failing = store(new Map());
  // repo → { channels: names, via }, for links seen this session.
  const seen = store(new Map());
  function remember(channel, link, result) {
    const nextFailing = new Map(failing.get());
    if (result) nextFailing.set(channel.id, result.prs.filter((pr) => pr.state === "failing").length);
    else nextFailing.delete(channel.id);
    failing.set(nextFailing);
    if (!link) return;
    const nextSeen = new Map(seen.get());
    const entry = nextSeen.get(link.repo) ?? { channels: [], via: undefined };
    nextSeen.set(link.repo, {
      channels: entry.channels.includes(channel.name) ? entry.channels : [...entry.channels, channel.name],
      via: result?.via ?? entry.via,
    });
    seen.set(nextSeen);
  }

  // --- GitHub with the token: REST through the host's native client.

  async function rest(path, token, signal) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await ctx.host.request({
        url: `${API}${path}`,
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch {
      throw new ReadError("unreachable");
    }
    signal?.throwIfAborted();
    if (response.status === 401) throw new ReadError("rejected");
    if (response.status === 403 && header(response, "x-ratelimit-remaining") === "0")
      throw new ReadError("unreachable");
    if (response.status === 403 || response.status === 404) throw new ReadError("cantSee");
    if (response.status < 200 || response.status >= 300) throw new ReadError("unreachable");
    try {
      return { data: JSON.parse(response.body), response };
    } catch {
      throw new ReadError("unreachable");
    }
  }
  const header = (response, name) =>
    Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];

  // Who the token reads as, and when it expires (fine-grained and classic
  // tokens with an expiry send it as a header).
  async function checkToken(token, signal) {
    try {
      const { data, response } = await rest("/user", token, signal);
      const expires = header(response, "github-authentication-token-expiration");
      setTokenState(token, { status: "ok", login: data.login, expires });
      return data.login;
    } catch (error) {
      if (error.code === "rejected") setTokenState(token, { status: "rejected" });
      throw error;
    }
  }

  async function mapLimit(items, limit, run) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await run(items[index]);
        }
      }),
    );
    return results;
  }

  function restState(status, conclusion) {
    if (status !== "completed") return status === "in_progress" ? "running" : "queued";
    if (conclusion === "success") return "passing";
    if (conclusion === "neutral" || conclusion === "skipped" || conclusion === "stale") return "skipped";
    return "failing";
  }

  // Workflow runs for a commit, newest attempt per workflow, as checks.
  // `jobsFor` picks which runs are expanded to their jobs.
  async function restRuns(repo, sha, token, signal, jobsFor, event) {
    const query = `head_sha=${sha}&per_page=30${event ? `&event=${event}` : ""}`;
    const { data } = await rest(`/repos/${repo}/actions/runs?${query}`, token, signal);
    const latest = new Map();
    for (const run of data.workflow_runs ?? []) if (!latest.has(run.workflow_id)) latest.set(run.workflow_id, run);
    return mapLimit([...latest.values()], 4, async (run) => {
      const check = { name: run.name, state: restState(run.status, run.conclusion), url: run.html_url };
      if (!jobsFor(check)) return check;
      const jobs = await rest(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=50`, token, signal);
      return {
        ...check,
        jobs: (jobs.data.jobs ?? []).map((job) => ({
          name: job.name,
          state: restState(job.status, job.conclusion),
          url: job.html_url,
        })),
      };
    });
  }

  async function readWithToken(link, token, signal) {
    const login = await checkToken(token, signal);
    const repo = link.repo;
    const [open, closed] = await Promise.all([
      rest(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_PRS}`, token, signal),
      rest(
        `/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(link.branch)}&sort=updated&direction=desc&per_page=30`,
        token,
        signal,
      ),
    ]);
    const prs = await mapLimit(open.data, 4, async (pr) => {
      const [runs, status] = await Promise.all([
        restRuns(repo, pr.head.sha, token, signal, (check) => check.state === "failing"),
        rest(`/repos/${repo}/commits/${pr.head.sha}/status`, token, signal),
      ]);
      const statuses = (status.data.statuses ?? []).map((item) => ({
        name: item.context,
        state: item.state === "success" ? "passing" : item.state === "pending" ? "running" : "failing",
        url: item.target_url || undefined,
      }));
      return pullRequest(pr.number, pr.title, pr.html_url, pr.user?.login, [...runs, ...statuses]);
    });
    const merged = closed.data
      .filter((pr) => pr.merged_at && pr.merge_commit_sha)
      .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
      .slice(0, MAX_MERGES);
    const merges = await mapLimit(merged, 2, async (pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      mergedAt: Date.parse(pr.merged_at),
      // The list endpoint has no merged_by; leave it out rather than guess.
      mergedBy: undefined,
      runs: await restRuns(repo, pr.merge_commit_sha, token, signal, () => true, "push"),
    }));
    return { prs: sortPrs(prs), merges, via: { kind: "token", login } };
  }

  // --- GitHub with gh: GraphQL through a declared host command.

  const GH_QUERY = `query($owner: String!, $name: String!, $branch: String!, $prs: Int!, $merges: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: $prs, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title url author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { url workflow { name } } } }
          ... on StatusContext { context state targetUrl }
        } } } } } } }
    }
    merged: pullRequests(states: MERGED, baseRefName: $branch, first: $merges, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title url mergedAt mergedBy { login }
        mergeCommit { checkSuites(first: 20) { nodes { status conclusion app { name }
          workflowRun { url event workflow { name } }
          checkRuns(first: 30) { nodes { name status conclusion detailsUrl } } } } } }
    }
  }
}`;
  const LOOKUP_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { nameWithOwner defaultBranchRef { name } }
}`;

  async function gh(query, variables) {
    const out = await ctx.host.runCommand("graphql", JSON.stringify({ query, variables }));
    if (typeof out !== "string") return null;
    try {
      const parsed = JSON.parse(out);
      return parsed.errors ? null : parsed.data;
    } catch {
      return null;
    }
  }
  async function ghLogin() {
    const out = await ctx.host.runCommand("whoami");
    return typeof out === "string" && out.trim() ? out.trim() : undefined;
  }
  // Tell "gh can't read" apart: not signed in (or no gh), offline, or no access.
  async function ghFailure() {
    const login = await ghLogin();
    if (login) return new ReadError("noAccess", login);
    try {
      await ctx.host.request({ url: `${API}/zen`, method: "GET", timeoutMs: 5000 });
      return new ReadError("noGh");
    } catch {
      return new ReadError("unreachable");
    }
  }

  function graphState(status, conclusion) {
    if (status && status !== "COMPLETED") return status === "IN_PROGRESS" ? "running" : "queued";
    if (conclusion === "SUCCESS") return "passing";
    if (conclusion === "NEUTRAL" || conclusion === "SKIPPED" || conclusion === "STALE") return "skipped";
    return "failing";
  }

  async function readWithGh(link, signal) {
    const [owner, name] = link.repo.split("/");
    const data = await gh(GH_QUERY, { owner, name, branch: link.branch, prs: MAX_PRS, merges: MAX_MERGES });
    signal?.throwIfAborted();
    if (!data) throw await ghFailure();
    if (!data.repository) throw new ReadError("noAccess", data.viewer?.login);
    const prs = data.repository.pullRequests.nodes.map((pr) => {
      const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
      // Group Actions jobs under their workflow run; other checks stand alone.
      const runs = new Map();
      const checks = [];
      for (const item of contexts) {
        if (item.__typename === "StatusContext") {
          checks.push({
            name: item.context,
            state: item.state === "SUCCESS" ? "passing" : item.state === "PENDING" || item.state === "EXPECTED" ? "running" : "failing",
            url: item.targetUrl || undefined,
          });
          continue;
        }
        const job = { name: item.name, state: graphState(item.status, item.conclusion), url: item.detailsUrl || undefined };
        const run = item.checkSuite?.workflowRun;
        if (!run) {
          checks.push(job);
          continue;
        }
        if (!runs.has(run.url)) {
          const check = { name: run.workflow.name, url: run.url, jobs: [] };
          runs.set(run.url, check);
          checks.push(check);
        }
        runs.get(run.url).jobs.push(job);
      }
      for (const check of runs.values()) check.state = worst(check.jobs.map((job) => job.state));
      return pullRequest(pr.number, pr.title, pr.url, pr.author?.login, checks);
    });
    const merges = data.repository.merged.nodes
      .filter((pr) => pr.mergedAt)
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        mergedAt: Date.parse(pr.mergedAt),
        mergedBy: pr.mergedBy?.login,
        runs: (pr.mergeCommit?.checkSuites.nodes ?? [])
          .filter((suite) => suite.checkRuns.nodes.length)
          .map((suite) => ({
            name: suite.workflowRun?.workflow.name ?? suite.app?.name ?? "Checks",
            state: graphState(suite.status, suite.conclusion),
            url: suite.workflowRun?.url,
            jobs: suite.checkRuns.nodes.map((job) => ({
              name: job.name,
              state: graphState(job.status, job.conclusion),
              url: job.detailsUrl || undefined,
            })),
          })),
      }));
    return { prs: sortPrs(prs), merges, via: { kind: "gh", login: data.viewer?.login } };
  }

  function pullRequest(number, title, url, author, checks) {
    return { number, title, url, author, checks, state: worst(checks.map((check) => check.state)) };
  }
  const sortPrs = (prs) =>
    [...prs].sort((a, b) => rank(a.state) - rank(b.state));
  const rank = (state) => (ORDER.includes(state) ? ORDER.indexOf(state) : ORDER.length);

  // Token first, gh as the fallback. `note` says why the token didn't do the read.
  async function readCi(link, signal) {
    const token = readToken();
    let note;
    if (token && currentTokenState().status !== "rejected") {
      try {
        return await readWithToken(link, token, signal);
      } catch (error) {
        signal?.throwIfAborted();
        note = error.code === "rejected" ? "rejected" : error.code === "cantSee" ? "cantSee" : undefined;
      }
    } else if (token) note = "rejected";
    const result = await readWithGh(link, signal);
    return { ...result, via: { ...result.via, note } };
  }

  async function lookupRepo(repo) {
    const token = readToken();
    if (token && currentTokenState().status !== "rejected") {
      try {
        const { data } = await rest(`/repos/${repo}`, token);
        return { repo: data.full_name, branch: data.default_branch };
      } catch {
        // Fall through to gh, as reads do.
      }
    }
    const [owner, name] = repo.split("/");
    const data = await gh(LOOKUP_QUERY, { owner, name });
    if (!data) throw await ghFailure();
    if (!data.repository) throw new ReadError("noAccess");
    return { repo: data.repository.nameWithOwner, branch: data.repository.defaultBranchRef?.name ?? "main" };
  }

  // --- Repo link: a kind 30078 event in the channel, trusted only from a
  // current owner or admin in the relay-signed roster (kind 39001).

  const eventsOf = (result) => (Array.isArray(result) ? result : result?.events ?? []);
  const tagValue = (event, name) => event.tags.find((tag) => tag[0] === name)?.[1];

  async function readLink(session, channelId, signal) {
    const d = linkTag(channelId);
    const [links, roster] = await Promise.all([
      session.read([{ kinds: [LINK_KIND], "#d": [d], "#h": [channelId], limit: 20 }], { signal, fresh: true }),
      session.read([{ kinds: [39001], "#d": [channelId], limit: 1 }], { signal, fresh: true }),
    ]);
    const admins = new Set(
      (eventsOf(roster)[0]?.tags ?? [])
        .filter((tag) => tag[0] === "p" && (tag[2] === "owner" || tag[2] === "admin"))
        .map((tag) => tag[1]),
    );
    const newest = eventsOf(links)
      .filter((event) => event.kind === LINK_KIND && tagValue(event, "d") === d && admins.has(event.pubkey))
      .sort((a, b) => b.created_at - a.created_at)[0];
    return parseLink(newest?.content);
  }
  function parseLink(content) {
    if (!content) return undefined;
    try {
      const { repo, branch } = JSON.parse(content);
      return typeof repo === "string" && REPO.test(repo) && validBranch(branch) ? { repo, branch } : undefined;
    } catch {
      return undefined;
    }
  }
  const validBranch = (branch) => typeof branch === "string" && /^[^\s~^:?*[\\]{1,255}$/.test(branch);
  // An empty content unlinks; readers treat it as no link.
  function writeLink(session, channelId, link) {
    session.outbox.send({
      kind: LINK_KIND,
      content: link ? JSON.stringify({ repo: link.repo, branch: link.branch }) : "",
      tags: [
        ["d", linkTag(channelId)],
        ["h", channelId],
      ],
    });
  }

  // --- Presentation.

  function useSession() {
    return React.useSyncExternalStore(relay.subscribe, relay.snapshot);
  }
  const noSubscribe = () => () => {};
  const noChannels = () => ({ channels: [] });
  function useChannel(session, channelId) {
    const queries = session?.channels;
    const list = React.useSyncExternalStore(queries?.subscribeList ?? noSubscribe, queries?.list ?? noChannels);
    return (list.channels ?? []).find((channel) => channel.id === channelId);
  }
  // Repeats every minute, so "6 min ago" stays true.
  function useNow() {
    const [now, setNow] = React.useState(Date.now);
    React.useEffect(() => {
      const timer = setInterval(() => setNow(Date.now()), 60_000);
      return () => clearInterval(timer);
    }, []);
    return now;
  }
  function ago(then, now) {
    const minutes = Math.max(0, Math.round((now - then) / 60_000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    return `${Math.round(hours / 24)} d ago`;
  }

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
  const STATE_ICON = {
    failing: "circle-x",
    running: "loader-2",
    queued: "clock",
    passing: "circle-check",
    skipped: "circle-minus",
    none: "circle-minus",
  };
  const stateIcon = (state) =>
    icon(STATE_ICON[state], 16, { className: `gci-state`, "data-state": state, role: "img", "aria-label": STATE_LABEL[state] ?? "no checks" });

  // A GitHub link opens in Buzz's own GitHub panel when the host can open it.
  function GitHubLink({ url, host, className, children }) {
    return h(
      "a",
      {
        href: url,
        target: "_blank",
        rel: "noreferrer",
        className,
        onClick: (event) => {
          if (url && host?.canOpen(url) && host.open(url)) event.preventDefault();
        },
      },
      children,
    );
  }

  function CheckRow({ check, host }) {
    const name = check.url ? h(GitHubLink, { url: check.url, host, className: "gci-name" }, check.name) : h("span", { className: "gci-name" }, check.name);
    if (!check.jobs?.length)
      return h("li", { className: "gci-row" }, stateIcon(check.state), name);
    return h(
      "li",
      null,
      h(
        "details",
        { className: "gci-fold", open: check.state === "failing" },
        h("summary", { className: "gci-row" }, icon("chevron-right", 14, { className: "gci-chevron" }), stateIcon(check.state), name),
        h(
          "ul",
          { className: "gci-list gci-nested" },
          check.jobs.map((job, index) => h(CheckRow, { key: `${job.name}:${index}`, check: job, host })),
        ),
      ),
    );
  }

  function PullRow({ pr, host }) {
    return h(
      "li",
      { className: "gci-card" },
      h(
        "details",
        { className: "gci-fold", open: pr.state === "failing" },
        h(
          "summary",
          { className: "gci-row" },
          icon("chevron-right", 14, { className: "gci-chevron" }),
          stateIcon(pr.state),
          h(GitHubLink, { url: pr.url, host, className: "gci-name" }, `#${pr.number} ${pr.title}`),
          pr.author && h("span", { className: "gci-meta" }, pr.author),
        ),
        pr.checks.length
          ? h("ul", { className: "gci-list gci-nested" }, pr.checks.map((check, index) => h(CheckRow, { key: `${check.name}:${index}`, check, host })))
          : h("p", { className: "gci-meta gci-nested" }, "No checks reported."),
        h(GitHubLink, { url: `${pr.url}/checks`, host, className: "gci-more gci-nested" }, "View all checks"),
      ),
    );
  }

  function MergeRow({ merge, host, now }) {
    const who = merge.mergedBy ? `Merged by ${merge.mergedBy} · ` : "Merged · ";
    return h(
      "li",
      { className: "gci-card" },
      h(
        "p",
        { className: "gci-row" },
        stateIcon(worst(merge.runs.map((run) => run.state))),
        h(GitHubLink, { url: merge.url, host, className: "gci-name" }, `#${merge.number} ${merge.title}`),
      ),
      h("p", { className: "gci-meta gci-nested" }, who, ago(merge.mergedAt, now)),
      merge.runs.length
        ? h("ul", { className: "gci-list gci-nested" }, merge.runs.map((run, index) => h(CheckRow, { key: `${run.name}:${index}`, check: run, host })))
        : h("p", { className: "gci-meta gci-nested" }, "No runs for this merge."),
    );
  }

  function summary(prs) {
    const parts = [`${prs.length} open`];
    for (const state of ["failing", "running", "queued", "passing"]) {
      const count = prs.filter((pr) => pr.state === state).length;
      if (count) parts.push(`${count} ${state}`);
    }
    return parts.join(" · ");
  }

  // Which credential did the read, for the footer and Settings.
  function credential(via) {
    if (via.kind === "token") return "Read with token";
    if (via.note === "rejected") return "Token rejected · read with gh";
    return via.login ? `Read as ${via.login} with gh` : "Read with gh";
  }
  const footer = (via, readAt, now) => `${credential(via)} · ${ago(readAt, now)}`;

  function Message({ title, children, action }) {
    return h(
      "div",
      { className: "gci-empty", role: "status" },
      title && h("p", { className: "gci-title" }, title),
      children && h("p", { className: "gci-meta" }, children),
      action,
    );
  }
  const button = (label, onClick, primary) =>
    h("button", { type: "button", className: primary ? "gci-button gci-primary" : "gci-button", onClick }, label);

  // Reads CI for a link: on open, on Refresh and every two minutes. A failed
  // refresh keeps the last read on screen, dimmed.
  function useCi(link, channel) {
    const [state, setState] = React.useState({ status: "loading" });
    const [generation, setGeneration] = React.useState(0);
    const tokenKey = React.useSyncExternalStore(subscribeToken, readToken);
    React.useEffect(() => {
      if (!link) return;
      const controller = new AbortController();
      setState((previous) => (previous.result ? { ...previous, status: "refreshing" } : { status: "loading" }));
      readCi(link, controller.signal).then(
        (result) => {
          if (controller.signal.aborted) return;
          remember(channel, link, result);
          setState({ status: "ready", result, readAt: Date.now() });
        },
        (error) => {
          if (controller.signal.aborted) return;
          setState((previous) => ({ ...previous, status: "error", error: error instanceof ReadError ? error : new ReadError("unreachable") }));
        },
      );
      const timer = setTimeout(() => setGeneration((value) => value + 1), REFRESH_MS);
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    }, [link?.repo, link?.branch, generation, tokenKey]);
    return [state, () => setGeneration((value) => value + 1)];
  }

  function CiView({ link, channel, host, canEdit, onEdit }) {
    const [state, refresh] = useCi(link, channel);
    const now = useNow();
    const { result, error } = state;
    const head = h(
      "div",
      { className: "gci-head" },
      icon("brand-github"),
      h("a", { href: `https://github.com/${link.repo}`, target: "_blank", rel: "noreferrer", className: "gci-name" }, link.repo),
      h("span", { className: "gci-meta" }, link.branch),
      h("button", { type: "button", className: "gci-icon", "aria-label": "Refresh", title: "Refresh", onClick: refresh, disabled: state.status === "loading" || state.status === "refreshing" }, icon("refresh")),
      canEdit && h("button", { type: "button", className: "gci-icon", "aria-label": "Change repo", title: "Change repo", onClick: onEdit }, icon("pencil")),
    );
    if (!result) {
      if (state.status === "loading") return h(React.Fragment, null, head, h(Message, null, `Reading ${link.repo}…`));
      return h(React.Fragment, null, head, h(ErrorMessage, { error, link, refresh }));
    }
    const stale = state.status === "error";
    const lastMerge = result.merges[0];
    return h(
      React.Fragment,
      null,
      head,
      stale && h("p", { className: "gci-banner", role: "status" }, icon("alert-triangle"), `Couldn’t reach GitHub. Showing what was read ${ago(state.readAt, now)}.`),
      result.via.note === "cantSee" &&
        h("p", { className: "gci-banner", role: "status" }, icon("alert-triangle"), `Your token can’t see ${link.repo}. Read with gh instead. To use the token, add this repo to it on GitHub.`),
      h(
        "div",
        { className: stale ? "gci-body gci-stale" : "gci-body" },
        h("h3", { className: "gci-section" }, "Pull requests"),
        result.prs.length
          ? h(React.Fragment, null, h("p", { className: "gci-meta" }, summary(result.prs)), h("ul", { className: "gci-list" }, result.prs.map((pr) => h(PullRow, { key: pr.number, pr, host }))))
          : h(Message, { title: "No open pull requests" }, lastMerge && `Last merge: #${lastMerge.number} ${lastMerge.title}, ${ago(lastMerge.mergedAt, now)}.`),
        h("h3", { className: "gci-section" }, `After merge into ${link.branch}`),
        result.merges.length
          ? h("ul", { className: "gci-list" }, result.merges.map((merge) => h(MergeRow, { key: merge.number, merge, host, now })))
          : h("p", { className: "gci-meta" }, `No recent merges into ${link.branch}.`),
      ),
      h("p", { className: "gci-footer" }, footer(result.via, state.readAt, now)),
    );
  }

  function ErrorMessage({ error, link, refresh }) {
    const again = button("Try again", refresh);
    if (error?.code === "noGh")
      return h(Message, { title: "Sign in to GitHub", action: again }, "Run gh auth login in a terminal, or add a token in Settings → GitHub CI.");
    if (error?.code === "noAccess")
      return h(
        Message,
        { title: `No access to ${link.repo}`, action: again },
        `Your GitHub account${error.login ? ` (${error.login})` : ""} can’t see this repo. Ask its owner for access, then try again.`,
      );
    return h(Message, { title: "Couldn’t reach GitHub.", action: again });
  }

  // Look the repo up first, then ask which branch's merges to watch.
  function LinkDialog({ channel, current, onSave, onUnlink, onClose }) {
    const ref = React.useRef(null);
    const [repo, setRepo] = React.useState(current?.repo ?? "");
    const [found, setFound] = React.useState(current ? { repo: current.repo, branch: current.branch } : undefined);
    const [branch, setBranch] = React.useState(current?.branch ?? "");
    const [status, setStatus] = React.useState({});
    React.useEffect(() => {
      ref.current?.showModal();
    }, []);
    const lookup = (event) => {
      event.preventDefault();
      const name = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
      if (!REPO.test(name)) return setStatus({ error: "Enter a repo as owner/name." });
      setStatus({ busy: true });
      lookupRepo(name).then(
        (next) => {
          setFound(next);
          setBranch(next.branch);
          setStatus({});
        },
        (error) =>
          setStatus({
            error: error.code === "noGh" ? "Couldn’t read with gh. Sign in with gh auth login, or add a token in Settings." : error.code === "unreachable" ? "Couldn’t reach GitHub." : `Couldn’t find ${name}, or your account can’t see it.`,
          }),
      );
    };
    const save = (event) => {
      event.preventDefault();
      if (!validBranch(branch.trim())) return setStatus({ error: "Enter a branch name." });
      onSave({ repo: found.repo, branch: branch.trim() });
    };
    return h(
      "dialog",
      { ref, className: "gci-dialog", onClose, "aria-labelledby": "gci-dialog-title" },
      h(
        "form",
        { onSubmit: found ? save : lookup, className: "gci-form" },
        h("h2", { id: "gci-dialog-title", className: "gci-title" }, `Link a GitHub repo to #${channel.name}`),
        h("p", { className: "gci-meta" }, "The CI tab shows its open pull requests and the runs each merge starts."),
        h(
          "label",
          { className: "gci-field" },
          "Repository",
          h("input", {
            value: repo,
            placeholder: "owner/name",
            autoFocus: true,
            spellCheck: false,
            onChange: (event) => {
              setRepo(event.target.value);
              setFound(undefined);
              setStatus({});
            },
          }),
        ),
        found &&
          h(
            "label",
            { className: "gci-field" },
            "Branch for post-merge runs",
            h("input", { value: branch, spellCheck: false, onChange: (event) => setBranch(event.target.value) }),
          ),
        status.busy && h("p", { className: "gci-meta", role: "status" }, "Looking it up…"),
        status.error && h("p", { className: "gci-error", role: "alert" }, status.error),
        h(
          "div",
          { className: "gci-actions" },
          current && h("button", { type: "button", className: "gci-button gci-danger", onClick: onUnlink }, "Unlink"),
          h("button", { type: "button", className: "gci-button", onClick: () => ref.current?.close() }, "Cancel"),
          h("button", { type: "submit", className: "gci-button gci-primary", disabled: status.busy }, found ? "Link repository" : "Look up"),
        ),
      ),
    );
  }

  function ChannelCi({ session, channel, host }) {
    const [link, setLink] = React.useState({ status: "loading" });
    const [editing, setEditing] = React.useState(false);
    React.useEffect(() => {
      const controller = new AbortController();
      setLink({ status: "loading" });
      readLink(session, channel.id, controller.signal).then(
        (value) => {
          if (controller.signal.aborted) return;
          setLink({ status: "ready", value });
          if (!value) remember(channel);
        },
        () => !controller.signal.aborted && setLink({ status: "error" }),
      );
      return () => controller.abort();
    }, [session, channel.id]);
    const canEdit =
      (channel.viewerRole === "owner" || channel.viewerRole === "admin") &&
      !channel.readOnly &&
      !!session.outbox?.supports(LINK_KIND);
    const save = (next) => {
      writeLink(session, channel.id, next);
      setLink({ status: "ready", value: next });
      if (!next) remember(channel);
      setEditing(false);
    };
    const dialog =
      editing &&
      h(LinkDialog, {
        channel,
        current: link.value,
        onSave: save,
        onUnlink: () => save(undefined),
        onClose: () => setEditing(false),
      });
    if (link.status === "loading") return h(Message, null, "Reading this channel’s repo link…");
    if (link.status === "error")
      return h(Message, { title: "Couldn’t read this channel’s repo link." });
    if (!link.value)
      return h(
        React.Fragment,
        null,
        h(
          Message,
          {
            title: "No repo linked",
            action: canEdit ? button("Link repository", () => setEditing(true), true) : undefined,
          },
          canEdit
            ? "Link a GitHub repo to see its open pull requests and post-merge runs here."
            : "A channel owner or admin can link a GitHub repo to show its pull requests and post-merge runs here.",
        ),
        dialog,
      );
    return h(
      React.Fragment,
      null,
      h(CiView, { key: `${link.value.repo}:${link.value.branch}`, link: link.value, channel, host, canEdit, onEdit: () => setEditing(true) }),
      dialog,
    );
  }

  // The tab. The launcher's eligibility is presentation only, so check the
  // relay session and channel membership before reading anything.
  function Panel({ channelContext, context: host }) {
    const snapshot = useSession();
    const session = snapshot.status === "ready" ? snapshot.session : undefined;
    const channel = useChannel(session, channelContext?.channelId);
    let body;
    if (!channelContext || !session || snapshot.scope !== channelContext.scope)
      body = h(Message, null, "Connect to this channel to see its CI.");
    else if (!channel || channel.cached) body = h(Message, null, "Join this channel to see its CI.");
    else if (typeof session.read !== "function" || !ctx.host.request)
      body = h(Message, null, "GitHub CI needs the Buzz desktop app.");
    else body = h(ChannelCi, { key: `${snapshot.scope}:${snapshot.generation}:${channel.id}`, session, channel, host });
    return h("div", { className: "gci" }, h("style", null, CSS), body);
  }

  function Launcher({ context, toggle, pressed, available }) {
    const counts = React.useSyncExternalStore(failing.subscribe, failing.get);
    const count = counts.get(context.channelId) ?? 0;
    return h(
      "button",
      {
        type: "button",
        className: "gci-launcher",
        "data-channel-panel-toggle": "",
        "aria-label": count ? `GitHub CI, ${count} failing` : "GitHub CI",
        title: "GitHub CI",
        "aria-expanded": pressed,
        onClick: (event) => {
          event.currentTarget.focus();
          if (available()) toggle(context.channelId);
        },
      },
      h("style", null, LAUNCHER_CSS),
      icon("brand-github"),
      count > 0 && h("span", { className: "gci-badge", "aria-hidden": true }, count),
    );
  }

  ctx.panels.register({
    id: "ci",
    title: "CI",
    matches: () => false,
    channelLauncher: Launcher,
    channelPlacement: "tab",
    deferUntilShown: true,
    component: Panel,
  });

  // --- Settings → GitHub CI.

  function TokenSettings() {
    const token = React.useSyncExternalStore(subscribeToken, readToken);
    const state = useTokenState();
    const repos = React.useSyncExternalStore(seen.subscribe, seen.get);
    const [draft, setDraft] = React.useState("");
    const [editing, setEditing] = React.useState(false);
    const [login, setLogin] = React.useState();
    React.useEffect(() => {
      ghLogin().then(setLogin, () => setLogin(undefined));
    }, []);
    React.useEffect(() => {
      if (token && state.status === "unchecked") checkToken(token).catch(() => {});
    }, [token, state.status]);
    const save = (event) => {
      event.preventDefault();
      const next = draft.trim();
      if (!next) return;
      writeToken(next);
      setDraft("");
      setEditing(false);
    };
    let status;
    if (!token)
      status = login
        ? `Reading as ${login} with gh. Add a token if gh is blocked, or can’t see a private repo.`
        : "No token, and gh isn’t signed in. Add a token, or run gh auth login.";
    else if (state.status === "unchecked") status = "Checking the token with GitHub…";
    else if (state.status === "rejected")
      status = `Token rejected, so reads fall back to gh${login ? ` (${login})` : ""}.`;
    else
      status = `Reading with your token (${state.login})${state.expires ? ` · expires ${formatExpiry(state.expires)}` : ""}. gh is the fallback.`;
    return h(
      "div",
      { className: "gci gci-settings" },
      h("style", null, CSS),
      h("h3", { className: "gci-section" }, "How Buzz reads GitHub"),
      h("p", { className: state.status === "rejected" && token ? "gci-error" : "gci-meta", role: "status" }, status),
      token && !editing
        ? h(
            "div",
            { className: "gci-actions gci-start" },
            h("code", { className: "gci-masked" }, `${token.startsWith("github_pat_") ? "github_pat_" : token.slice(0, 4)}••••••••`),
            button("Replace", () => setEditing(true)),
            h("button", { type: "button", className: "gci-button gci-danger", onClick: () => writeToken("") }, "Remove"),
          )
        : h(
            "form",
            { className: "gci-actions gci-start", onSubmit: save },
            h("input", {
              type: "password",
              value: draft,
              placeholder: "github_pat_…",
              autoComplete: "off",
              spellCheck: false,
              "aria-label": "GitHub token",
              onChange: (event) => setDraft(event.target.value),
            }),
            h("button", { type: "submit", className: "gci-button gci-primary" }, "Save"),
            editing && button("Cancel", () => setEditing(false)),
          ),
      h(
        "p",
        { className: "gci-meta" },
        "The token is stored unencrypted on this computer, where other Buzz plugins and anything running as you can read it. It is sent only to api.github.com and never to a channel or the relay. Use a fine-grained, read-only token limited to the repos you need, with an expiry.",
      ),
      h("h3", { className: "gci-section" }, "Minimum permissions (fine-grained token, only the repos you need)"),
      h(
        "ul",
        { className: "gci-perms" },
        ["Metadata", "Pull requests", "Actions", "Commit statuses"].map((name) => h("li", { key: name }, name, h("span", { className: "gci-meta" }, "Read-only"))),
      ),
      h("p", { className: "gci-meta" }, "Checks from apps outside GitHub Actions can’t be read with a fine-grained token. They show only when gh does the read."),
      h("h3", { className: "gci-section" }, "Repos linked in your channels"),
      repos.size
        ? h(
            "ul",
            { className: "gci-perms" },
            [...repos].map(([repo, entry]) =>
              h(
                "li",
                { key: repo },
                h("span", null, repo, h("span", { className: "gci-meta" }, ` · ${entry.channels.map((name) => `#${name}`).join(", ")}`)),
                h("span", { className: "gci-meta" }, entry.via ? credential(entry.via) : "Not read yet"),
              ),
            ),
          )
        : h("p", { className: "gci-meta" }, "Open a channel’s CI tab to list its repo here."),
    );
  }
  function formatExpiry(value) {
    const date = new Date(value.replace(" UTC", "Z").replace(" ", "T"));
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  ctx.settingsCards.register({ id: "github-ci", title: "GitHub CI", component: TokenSettings });
}

// Tabler outline paths, the icon set Buzz itself uses.
const ICONS = {
  "brand-github": [
    "M9 19c-4.3 1.4 -4.3 -2.5 -6 -3m12 5v-3.5c0 -1 .1 -1.4 -.5 -2c2.8 -.3 5.5 -1.4 5.5 -6a4.6 4.6 0 0 0 -1.3 -3.2a4.2 4.2 0 0 0 -.1 -3.2s-1.1 -.3 -3.5 1.3a12.3 12.3 0 0 0 -6.2 0c-2.4 -1.6 -3.5 -1.3 -3.5 -1.3a4.2 4.2 0 0 0 -.1 3.2a4.6 4.6 0 0 0 -1.3 3.2c0 4.6 2.7 5.7 5.5 6c-.6 .6 -.6 1.2 -.5 2v3.5",
  ],
  "circle-check": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M9 12l2 2l4 -4"],
  "circle-x": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M10 10l4 4m0 -4l-4 4"],
  "circle-minus": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M9 12l6 0"],
  clock: ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0", "M12 7v5l3 3"],
  "loader-2": ["M12 3a9 9 0 1 0 9 9"],
  "chevron-right": ["M9 6l6 6l-6 6"],
  "alert-triangle": [
    "M12 9v4",
    "M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z",
    "M12 16h.01",
  ],
  refresh: ["M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4", "M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"],
  pencil: ["M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4", "M13.5 6.5l4 4"],
};

const LAUNCHER_CSS = `
.gci-launcher { position: relative; display: inline-flex; align-items: center; justify-content: center; width: var(--space-7); height: var(--space-7); padding: 0; border: 0; border-radius: var(--radius-row); background: transparent; color: var(--text-secondary); cursor: pointer; }
.gci-launcher[aria-expanded="true"], .gci-launcher:hover { background: var(--interaction-row-hover); color: var(--text-primary); }
.gci-badge { position: absolute; inset-block-start: calc(-1 * var(--space-half)); inset-inline-end: calc(-1 * var(--space-half)); min-width: var(--space-4); padding-inline: var(--space-half); border-radius: 999px; background: var(--text-danger); color: var(--surface-base, #fff); font-size: 10px; line-height: var(--space-4); text-align: center; font-variant-numeric: tabular-nums; }
`;

// Cards and rows never shrink: expanding one pushes the rest down instead of
// squeezing the card above it.
const CSS = `
.gci { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3); min-width: 0; color: var(--text-primary); }
.gci > *, .gci-body > *, .gci-list > li { flex-shrink: 0; }
.gci-head { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.gci-head > .gci-name { font-weight: 600; }
.gci-head > .gci-meta { flex: 1 1 auto; }
.gci-body { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.gci-stale { opacity: 0.6; }
.gci-section { margin: var(--space-2) 0 0; font-size: inherit; font-weight: 600; color: var(--text-secondary); }
.gci-list { display: flex; flex-direction: column; gap: var(--space-1); margin: 0; padding: 0; list-style: none; min-width: 0; }
.gci-card { padding: var(--space-2); border: 1px solid var(--border-standard); border-radius: var(--radius-lg); min-width: 0; }
.gci-row { display: flex; align-items: center; gap: var(--space-2); min-width: 0; margin: 0; min-height: var(--space-6); }
.gci-row > svg { flex-shrink: 0; }
.gci-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; text-decoration: none; }
a.gci-name:hover, .gci-more:hover { text-decoration: underline; }
.gci-meta { margin: 0; color: var(--text-subtle); }
.gci-row > .gci-meta { margin-inline-start: auto; flex-shrink: 0; }
.gci-nested { margin-inline-start: calc(var(--space-4) + var(--space-2)); }
.gci-more { display: inline-block; margin-block-start: var(--space-1); color: var(--text-secondary); text-decoration: none; }
.gci-fold > summary { cursor: pointer; list-style: none; }
.gci-fold > summary::-webkit-details-marker { display: none; }
.gci-chevron { color: var(--text-subtle); }
.gci-fold[open] > summary > .gci-chevron { transform: rotate(90deg); }
.gci-state[data-state="failing"] { color: var(--text-danger); }
.gci-state[data-state="passing"] { color: var(--text-success); }
.gci-state[data-state="running"] { color: var(--text-warning, #d29922); animation: gci-spin 1s linear infinite; }
.gci-state[data-state="queued"], .gci-state[data-state="skipped"], .gci-state[data-state="none"] { color: var(--text-subtle); }
@keyframes gci-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .gci-state[data-state="running"] { animation: none; } }
.gci-banner { display: flex; align-items: flex-start; gap: var(--space-2); margin: 0; padding: var(--space-2); border-radius: var(--radius-lg); background: var(--surface-inset); color: var(--text-secondary); }
.gci-banner > svg { flex-shrink: 0; color: var(--text-warning, #d29922); }
.gci-footer { margin: 0; padding-block-start: var(--space-2); border-block-start: 1px solid var(--border-standard); color: var(--text-subtle); }
.gci-empty { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-2); padding-block: var(--space-4); }
.gci-title { margin: 0; font-size: inherit; font-weight: 600; }
.gci-error { margin: 0; color: var(--text-danger); }
.gci-button { padding: var(--space-1) var(--space-3); border: 1px solid var(--border-standard); border-radius: var(--radius-row); background: transparent; color: var(--text-primary); cursor: pointer; }
.gci-primary { background: var(--text-primary); color: var(--surface-base, #000); border-color: transparent; }
.gci-danger { color: var(--text-danger); }
.gci-icon { display: inline-flex; padding: var(--space-1); border: 0; border-radius: var(--radius-row); background: transparent; color: var(--text-secondary); cursor: pointer; }
.gci-icon:hover { background: var(--interaction-row-hover); }
.gci-dialog { width: min(28rem, calc(100vw - 2 * var(--space-6))); padding: var(--space-5); border: 1px solid var(--border-standard); border-radius: var(--radius-lg); background: var(--surface-base, Canvas); color: var(--text-primary); }
.gci-form { display: flex; flex-direction: column; gap: var(--space-3); }
.gci-field { display: flex; flex-direction: column; gap: var(--space-1); color: var(--text-secondary); }
.gci input { padding: var(--space-1) var(--space-2); border: 1px solid var(--border-standard); border-radius: var(--radius-row); background: var(--surface-inset); color: var(--text-primary); font: inherit; }
.gci-dialog input { padding: var(--space-1) var(--space-2); border: 1px solid var(--border-standard); border-radius: var(--radius-row); background: var(--surface-inset); color: var(--text-primary); font: inherit; }
.gci-actions { display: flex; justify-content: flex-end; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.gci-start { justify-content: flex-start; }
.gci-settings input { flex: 1 1 16rem; }
.gci-masked { font-family: var(--font-mono); color: var(--text-secondary); }
.gci-perms { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--space-1); }
.gci-perms > li { display: flex; justify-content: space-between; gap: var(--space-3); }
`;
