'use strict';
// buzz-remote-agents server: one owner, many agents, one container. It starts a
// `buzz-acp` child process per agent, each under its own uid. No Docker socket:
// it spawns processes, not containers.
//
//   GET  /healthz                     -> 200
//   /v1/...                           the Server API (plugin/README.md), on V1_TOKEN
//   GET  /plugin/buzz-remote-agents.json, /plugin/install  the bundled plugin
//
// Everything specific to one installation (extra env, files in an agent's home,
// extra groups, extra routes) lives in an optional hooks module (README §Hooks).
//
// State (agent keys included) is kept 0600 under AGENTS_DIR, root-owned, so
// agents respawn after a restart and no agent can read another's key.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const {
  // The one pubkey (64 hex) that owns this server and every agent on it.
  OWNER_PUBKEY,
  // Bearer for /v1. Unset or empty turns /v1 off (404).
  V1_TOKEN,
  // The one relay agents on this server use.
  RELAY_URL,
  // This server's own https origin, baked into the plugin it serves at
  // /plugin/. Unset or invalid turns /plugin off.
  PUBLIC_ORIGIN,
  // Model credentials, handed to the agents of the matching harness only.
  CLAUDE_CODE_OAUTH_TOKEN,
  ANTHROPIC_API_KEY,
  XAI_API_KEY,
  // Optional upstreams for each harness's model traffic.
  ANTHROPIC_BASE_URL,
  GROK_BASE_URL,
  // Optional path to the hooks module (README §Hooks).
  HOOKS,
  AGENTS_DIR = '/agents',
  // First uid handed to an agent; each new one gets the next free uid.
  AGENT_UID_BASE = '10001',
  PLUGIN_DIR = path.join(__dirname, '..', 'plugin'),
  PORT = '8090',
} = process.env;

if (!/^[0-9a-f]{64}$/.test(OWNER_PUBKEY || '')) {
  console.error('server: OWNER_PUBKEY must be 64 lowercase hex characters');
  process.exit(1);
}
// Root is what lets each child run as its own uid (startChild).
if (process.getuid() !== 0) {
  console.error('server: must run as root to give each agent its own uid');
  process.exit(1);
}
const UID_BASE = Number(AGENT_UID_BASE);
const STATE_PATH = path.join(AGENTS_DIR, 'state.json');
const ARCHIVE_DIR = path.join(AGENTS_DIR, 'archive');

// The ACP agent each harness drives, all shipped in image/.
const HARNESSES = {
  claude: { command: 'claude-agent-acp', args: null },
  // buzz-acp splits the args on commas. --no-auto-update keeps the binary the
  // image pinned by checksum from replacing itself under $HOME.
  grok: { command: 'grok', args: '--no-auto-update,agent,stdio' },
};
const harnessOf = (agent) => (HARNESSES[agent.harness] ? agent.harness : 'claude');

/** slug -> { meta, child } */
const agents = new Map();

const slugFor = (key) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

// ---- hooks --------------------------------------------------------------------
// The module exports a function that gets the api below and returns any of:
//   beforeStart(agent) -> { env, files, groups }  before every start: env may
//                         replace a credential or upstream, never identity or
//                         the owner gate; files are { "path/in/home": body }
//   routes(req, res)   -> true when it answered    before every built-in route
//   onCreate(agent), onRemove(agent)
// It runs in this process, as root: it is the owner's own code, never an agent's.
const hookApi = {
  agentsDir: AGENTS_DIR,
  list: () => [...agents.values()].map(summary),
  restart: (pubkey) => restartAgent(findByPubkey(pubkey)),
  stop: (pubkey) => stopAgent(findByPubkey(pubkey)),
};
const hooks = HOOKS ? require(path.resolve(HOOKS))(hookApi) || {} : {};

// ---- nostr identity (key -> hex pubkey / npub), bech32 per BIP-173 ------------
// No node_modules in this server, so the ~40 lines of bech32 are ours.
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
function bech32HrpExpand(hrp) {
  const ret = [...hrp].map((c) => c.charCodeAt(0) >> 5);
  ret.push(0);
  for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
  return ret;
}
function bech32Decode(bech) {
  bech = bech.toLowerCase();
  const pos = bech.lastIndexOf('1');
  const hrp = bech.slice(0, pos);
  const data = [...bech.slice(pos + 1)].map((c) => BECH32_CHARSET.indexOf(c));
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== 1) throw new Error('bad bech32 checksum');
  return { hrp, words: data.slice(0, -6) };
}
function bech32Encode(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(values) ^ 1;
  const checksum = [];
  for (let p = 0; p < 6; p++) checksum.push((mod >> (5 * (5 - p))) & 31);
  return hrp + '1' + data.concat(checksum).map((d) => BECH32_CHARSET[d]).join('');
}
function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (to - bits)) & maxv);
  return ret;
}
// Keys are stored as hex; an nsec1... key imported from elsewhere also works.
function deriveIdentity(nsecOrHex) {
  try {
    let privHex = nsecOrHex;
    if (nsecOrHex.startsWith('nsec1')) {
      const { hrp, words } = bech32Decode(nsecOrHex);
      if (hrp !== 'nsec') throw new Error('not an nsec');
      privHex = Buffer.from(convertBits(words, 5, 8, false)).toString('hex');
    }
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(privHex, 'hex'));
    // NIP-01 pubkeys are x-only (BIP-340): drop the 02/03 parity prefix byte.
    const pubkey = ecdh.getPublicKey('hex', 'compressed').slice(2);
    const npub = bech32Encode('npub', convertBits([...Buffer.from(pubkey, 'hex')], 8, 5, true));
    return { pubkey, npub };
  } catch (_e) {
    return { pubkey: null, npub: null };
  }
}

function newKeyHex() {
  // setPrivateKey rejects 0 and values >= n; retry until a valid scalar.
  for (;;) {
    const key = crypto.randomBytes(32).toString('hex');
    try {
      crypto.createECDH('secp256k1').setPrivateKey(Buffer.from(key, 'hex'));
      return key;
    } catch (_e) {
      /* out of range, draw again */
    }
  }
}

// ---- per-agent uid --------------------------------------------------------------
// Each agent runs as its own uid and group, so it cannot read state.json, a
// sibling's /proc/<pid>/environ or a sibling's dirs. The uid is allocated once
// and saved in state.json, so it is the same on every start. Archived agents
// keep theirs reserved: one restored from the archive must not share a uid.
function agentIds(meta) {
  if (!Number.isInteger(meta.uid)) {
    const used = [...agents.values()].map((a) => a.meta.uid);
    try {
      for (const f of fs.readdirSync(ARCHIVE_DIR)) {
        used.push(JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')).uid);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    meta.uid = Math.max(UID_BASE - 1, ...used.filter(Number.isInteger)) + 1;
    saveState();
  }
  return { uid: meta.uid, gid: meta.uid };
}

// ssh, whoami and anything else that looks a uid up fail when it has no
// passwd entry. /etc is the container's, so a recreate drops ours: every start
// adds the agent's user and group if they are missing.
function ensureEntry(file, line) {
  const name = line.split(':')[0];
  const body = fs.readFileSync(file, 'utf8');
  if (body.split('\n').some((l) => l.split(':')[0] === name)) return;
  fs.appendFileSync(file, `${body.endsWith('\n') ? '' : '\n'}${line}\n`);
}
function ensureUser(slug, ids) {
  const name = `agent-${slug}`;
  const home = path.join(AGENTS_DIR, slug, 'home');
  ensureEntry('/etc/passwd', `${name}:x:${ids.uid}:${ids.gid}::${home}:/bin/bash`);
  ensureEntry('/etc/group', `${name}:x:${ids.gid}:`);
}

// An agent's dir, owned by it and closed to everyone else (0700). The -R runs
// only while the dir isn't the agent's yet, which is once: its first start under
// its own uid. chown -R changes a directory after its contents, so a run cut
// short is redone on the next start. -h chowns a symlink itself, never its target.
// A symlink in place of the dir is refused: /tmp is shared, and chmod follows it.
function claimDir(p, ids) {
  fs.mkdirSync(p, { recursive: true });
  if (fs.lstatSync(p).isSymbolicLink()) throw new Error(`${p} is a symlink, not a dir`);
  if (fs.statSync(p).uid !== ids.uid) execFileSync('chown', ['-R', '-h', `${ids.uid}:${ids.gid}`, p]);
  fs.chmodSync(p, 0o700);
}

// Write a file into an agent's home as that agent, replacing it atomically.
// rel must stay inside home, and every dir on the way is claimed for the agent.
function writeHomeFile(home, rel, body, ids) {
  const dest = path.resolve(home, rel);
  if (!dest.startsWith(home + path.sep)) throw new Error(`${rel}: outside the agent's home`);
  for (let d = path.dirname(dest); d !== home; d = path.dirname(d)) claimDir(d, ids);
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
  fs.chownSync(tmp, ids.uid, ids.gid);
  fs.renameSync(tmp, dest);
}

// ---- persistence (keys at rest, 0600) -------------------------------------------
function saveState() {
  const metas = [...agents.values()].map((a) => a.meta);
  const tmp = STATE_PATH + '.tmp';
  // A leftover tmp would keep its old owner and mode: always write a new file.
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(metas), { mode: 0o600 });
  fs.renameSync(tmp, STATE_PATH);
}
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (_e) {
    return [];
  }
}

// ---- spawn / supervise a single agent -------------------------------------------
// Two layers: `fixed` is identity, owner and the turn gate, which nothing else
// may change; `defaults` is credentials and upstreams, which a hook may replace
// for one agent (its own key, its own proxy).
function buildEnv(meta) {
  const a = meta.agent;
  const harness = harnessOf(a);
  const fixed = {
    PATH: process.env.PATH,
    HOME: path.join(AGENTS_DIR, meta.slug, 'home'),
    // Every agent is a child of this one container: without this they would
    // share its /tmp.
    TMPDIR: path.join('/tmp', meta.slug),
    BUZZ_PRIVATE_KEY: a.private_key_nsec,
    BUZZ_RELAY_URL: a.relay_url,
    BUZZ_ACP_AGENT_OWNER: OWNER_PUBKEY,
    BUZZ_ACP_AGENT_COMMAND: HARNESSES[harness].command,
    // Only the owner (and the owner's other agents) can start a turn, and
    // ALLOWED makes buzz-acp refuse to start under any other mode.
    BUZZ_ACP_RESPOND_TO: 'owner-only',
    BUZZ_ACP_ALLOWED_RESPOND_TO: 'owner-only',
    BUZZ_ACP_RELAY_OBSERVER: 'true',
    RUST_LOG: 'buzz_acp=info',
  };
  if (process.env.TZ) fixed.TZ = process.env.TZ;
  if (HARNESSES[harness].args) fixed.BUZZ_ACP_AGENT_ARGS = HARNESSES[harness].args;
  if (a.model) fixed.BUZZ_ACP_MODEL = a.model;
  if (a.system_prompt) fixed.BUZZ_ACP_SYSTEM_PROMPT = a.system_prompt;
  if (a.auth_tag) fixed.BUZZ_AUTH_TAG = a.auth_tag;
  const defaults = {};
  if (harness === 'claude') {
    // One or the other, never both: an API key in the env forces API-key mode,
    // and then the OAuth token is never tried.
    if (CLAUDE_CODE_OAUTH_TOKEN) defaults.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_CODE_OAUTH_TOKEN;
    else if (ANTHROPIC_API_KEY) defaults.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
    if (ANTHROPIC_BASE_URL) defaults.ANTHROPIC_BASE_URL = ANTHROPIC_BASE_URL;
  }
  if (harness === 'grok' && XAI_API_KEY) defaults.XAI_API_KEY = XAI_API_KEY;
  return { fixed, defaults };
}

// Grok Build has no env var for its base URL or model, so ~/.grok/config.toml
// is written on every start. With XAI_API_KEY the model entry names the var,
// never the key; without it, the session from `grok login --device-auth` in the
// agent's home authenticates, and GROK_BASE_URL moves the session service.
function grokConfig(env) {
  const model = env.BUZZ_ACP_MODEL || 'grok-4.6';
  const lines = ['# Written by the server on every start; edits here do not survive a restart.'];
  if (GROK_BASE_URL && env.XAI_API_KEY) {
    // Quoted: a model id like grok-4.6 has a dot, which an unquoted TOML key
    // would split into nested tables.
    lines.push(`[model."${model}"]`, `model = "${model}"`, `base_url = "${GROK_BASE_URL}"`,
      `name = "${model}"`, 'env_key = "XAI_API_KEY"', '');
  } else if (GROK_BASE_URL) {
    lines.push('[endpoints]', `cli_chat_proxy_base_url = "${GROK_BASE_URL}"`, '');
  }
  lines.push('[models]', `default = "${model}"`, '', '[cli]', 'auto_update = false', '');
  return lines.join('\n');
}

function startChild(meta) {
  const home = path.join(AGENTS_DIR, meta.slug, 'home');
  const work = path.join(AGENTS_DIR, meta.slug, 'workspace');
  const tmp = path.join('/tmp', meta.slug);
  const ids = agentIds(meta);
  ensureUser(meta.slug, ids);
  claimDir(home, ids);
  claimDir(work, ids);
  claimDir(tmp, ids);
  const { fixed, defaults } = buildEnv(meta);
  let hookEnv = {};
  let files = {};
  let groups = [];
  if (hooks.beforeStart) {
    const extra = hooks.beforeStart(publicAgent(meta)) || {};
    hookEnv = extra.env || {};
    files = { ...(extra.files || {}) };
    groups = (extra.groups || []).filter(Number.isInteger);
  }
  const env = { ...defaults };
  for (const [k, v] of Object.entries(hookEnv)) if (typeof v === 'string') env[k] = v;
  Object.assign(env, fixed);
  if (env.BUZZ_ACP_AGENT_COMMAND === 'grok') files['.grok/config.toml'] = grokConfig(env);
  for (const [rel, body] of Object.entries(files)) writeHomeFile(home, rel, body, ids);
  // setpriv rather than spawn's uid/gid: Node drops every supplementary group,
  // and a hook's groups have to stay. setpriv execs, so the pid is buzz-acp's.
  const child = spawn(
    'setpriv',
    [
      '--reuid', String(ids.uid),
      '--regid', String(ids.gid),
      ...(groups.length ? ['--groups', groups.join(',')] : ['--clear-groups']),
      '--', 'buzz-acp',
    ],
    { cwd: work, env, stdio: ['ignore', 'inherit', 'inherit'] } // agent logs → our stdout
  );
  agents.set(meta.slug, { meta, child });
  console.log(`[${meta.slug}] started buzz-acp pid=${child.pid}`);
  child.on('exit', (code, sig) => {
    console.log(`[${meta.slug}] buzz-acp exited code=${code} sig=${sig}`);
    const cur = agents.get(meta.slug);
    // Only act if THIS child is still the current one. A replaced or removed
    // agent's old child must not null the new child ref or respawn stale config.
    if (!cur || cur.child !== child) return;
    cur.child = null;
    setTimeout(() => {
      const c = agents.get(meta.slug);
      try {
        if (c && !c.child && !c.meta.pending) startChild(c.meta);
      } catch (e) {
        console.error(`[${meta.slug}] not restarted: ${e.message}`);
      }
    }, 5000);
  });
}

function restartAgent(a) {
  if (!a) throw new Error('unknown agent');
  // An agent has no owner tag until activate; starting it would run it ownerless.
  if (a.meta.pending) throw new Error('pending activate');
  if (!a.child) return startChild(a.meta);
  a.child.kill('SIGTERM'); // respawns via the exit handler
}

// Stop and archive, never delete: a removed agent is restorable from the file.
function stopAgent(a) {
  if (!a) return;
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const file = path.join(ARCHIVE_DIR, `${a.meta.slug}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(a.meta), { mode: 0o600 });
  agents.delete(a.meta.slug);
  saveState();
  try {
    if (a.child) a.child.kill('SIGTERM');
  } catch (_e) {
    /* ignore */
  }
  console.log(`[${a.meta.slug}] removed, archived to ${path.basename(file)}`);
  if (hooks.onRemove) hooks.onRemove(publicAgent(a.meta));
}

function findByPubkey(pubkey) {
  for (const a of agents.values()) {
    if (deriveIdentity(a.meta.agent.private_key_nsec).pubkey === pubkey) return a;
  }
  return undefined;
}

// What hooks and lists see: never the key.
function publicAgent(meta) {
  const { private_key_nsec, ...agent } = meta.agent;
  return { ...agent, harness: harnessOf(agent), slug: meta.slug, pubkey: deriveIdentity(private_key_nsec).pubkey };
}
function summary(a) {
  return { ...publicAgent(a.meta), pending: !!a.meta.pending, running: !!a.child, pid: a.child ? a.child.pid : null };
}

// ---- /v1: the Server API (plugin/README.md) -------------------------------------
// The key is made here and no response carries it. An agent made by POST is
// saved `pending` (not started) until activate brings the owner's NIP-OA tag.
// A V1_TOKEN holder can create pending keys, rename, and remove (archive); it
// cannot read keys, edit prompts, or start an agent for anyone but the owner.

// ["auth", owner, conditions, sig]: Buzz sends no conditions. Only the owner
// may be named; the relay verifies the signature when the agent authenticates.
function ownerAuthOk(auth) {
  return (
    Array.isArray(auth) &&
    auth.length === 4 &&
    auth[0] === 'auth' &&
    auth[1] === OWNER_PUBKEY &&
    auth[2] === '' &&
    /^[0-9a-f]{128}$/.test(auth[3])
  );
}

// kind 0, signed with the agent's own key by the image's buzz CLI.
function publishProfile(agent, name, picture) {
  const args = ['users', 'set-profile', '--name', name];
  if (picture) args.push('--avatar', picture);
  return new Promise((resolve, reject) =>
    execFile(
      'buzz',
      args,
      {
        timeout: 20000,
        env: {
          PATH: process.env.PATH,
          HOME: '/tmp',
          BUZZ_PRIVATE_KEY: agent.private_key_nsec,
          BUZZ_RELAY_URL: agent.relay_url,
          ...(agent.auth_tag ? { BUZZ_AUTH_TAG: agent.auth_tag } : {}),
        },
      },
      // stderr only: the error's message holds no env, but keep it short.
      (e, _out, err) => (e ? reject(new Error(`profile: ${String(err).trim().split('\n')[0] || e.code}`)) : resolve())
    )
  );
}

const pictureOf = (body) =>
  typeof body.picture === 'string' && /^https:\/\/\S+$/.test(body.picture) ? body.picture : undefined;
const relayNorm = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '') : '');

const PK = '([0-9a-f]{64})';
async function v1(req, res, body) {
  const { method } = req;
  const url = req.url.split('?')[0];
  let m;
  if (method === 'GET' && url === '/v1/agents') {
    // What provision can adopt: running and pending agents, never a key.
    return json(res, 200, [...agents.values()].map((a) => ({
      pubkey: deriveIdentity(a.meta.agent.private_key_nsec).pubkey,
      name: a.meta.agent.name || null,
    })));
  }
  if (method === 'POST' && url === '/v1/agents') {
    if (body.adopt !== undefined) {
      const a = typeof body.adopt === 'string' && findByPubkey(body.adopt);
      if (!a) return json(res, 404, { error: 'unknown agent' });
      return json(res, 200, { pubkey: body.adopt });
    }
    if (typeof body.name !== 'string' || !body.name.trim()) return json(res, 400, { error: 'name required' });
    if (!RELAY_URL || relayNorm(body.community) !== relayNorm(RELAY_URL)) {
      return json(res, 400, { error: 'community must be this server\'s relay' });
    }
    if (body.harness !== undefined && !HARNESSES[body.harness]) {
      return json(res, 400, { error: `harness must be one of ${Object.keys(HARNESSES).join(', ')}` });
    }
    // A create whose response was lost gets retried under the same name: hand
    // back the still-pending key instead of minting an orphan.
    const name = body.name.trim();
    for (const a of agents.values()) {
      if (a.meta.pending && a.meta.agent.name === name) {
        return json(res, 200, { pubkey: deriveIdentity(a.meta.agent.private_key_nsec).pubkey });
      }
    }
    const key = newKeyHex();
    const agent = { name, relay_url: RELAY_URL, private_key_nsec: key, harness: body.harness || 'claude' };
    if (typeof body.model === 'string' && body.model.trim()) agent.model = body.model.trim();
    if (pictureOf(body)) agent.picture = pictureOf(body);
    const slug = slugFor(key);
    const meta = { slug, agent, created_at: Date.now(), pending: true };
    agents.set(slug, { meta, child: null });
    saveState();
    console.log(`[${slug}] created (pending activate)`);
    if (hooks.onCreate) hooks.onCreate(publicAgent(meta));
    return json(res, 200, { pubkey: deriveIdentity(key).pubkey });
  }
  if ((m = url.match(new RegExp(`^/v1/agents/${PK}(/activate|/profile|/instructions)?$`)))) {
    const [, pubkey, sub] = m;
    const a = findByPubkey(pubkey);
    if (method === 'DELETE' && !sub) {
      // Already gone counts as removed.
      stopAgent(a);
      return json(res, 200, { removed: true });
    }
    if (!a) return json(res, 404, { error: 'unknown agent' });
    const agent = a.meta.agent;
    if (method === 'GET' && sub === '/instructions') {
      return json(res, 200, { instructions: agent.system_prompt || '' });
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : agent.name;
    const picture = pictureOf(body) || agent.picture;
    if (method === 'PUT' && sub === '/profile') {
      if (!name) return json(res, 400, { error: 'name required' });
      await publishProfile(agent, name, picture);
      agent.name = name;
      if (picture) agent.picture = picture;
      saveState();
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && sub === '/activate') {
      if (!ownerAuthOk(body.auth)) return json(res, 403, { error: 'auth must be the owner\'s NIP-OA tag' });
      const tag = JSON.stringify(body.auth);
      // Publishing first doubles as the admission check: until the relay has
      // admitted the agent this fails, nothing is saved, and Buzz retries.
      await publishProfile({ ...agent, auth_tag: tag }, name, picture);
      const changed = agent.auth_tag !== tag || !!a.meta.pending;
      agent.auth_tag = tag;
      delete a.meta.pending;
      saveState();
      // Retries are safe: an unchanged, running agent is left alone. A changed
      // one restarts once (its in-flight turns end) to pick up the new tag.
      if (!a.child) startChild(a.meta);
      else if (changed) a.child.kill('SIGTERM'); // respawns via the exit handler
      console.log(`[${a.meta.slug}] activated`);
      return json(res, 200, { ok: true });
    }
  }
  return json(res, 404, { error: 'not found' });
}

// ---- HTTP -------------------------------------------------------------------------
function bearerOk(req, secret) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return (
    !!secret &&
    token.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))
  );
}
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---- /plugin: the bundled plugin, preconfigured for this server ----------------
// Packed once at start from PLUGIN_DIR in `buzzodz plugin pack`'s JSON shape,
// with networkOrigins set to PUBLIC_ORIGIN. Unauthenticated: Buzz downloads a
// URL artifact without credentials, and it holds public code plus our origin.
const PLUGIN_MAX_BYTES = 8 * 1024 * 1024; // Buzz's artifact limit
const PLUGIN_MAX_README = 256 * 1024;

// Buzz accepts only the exact ascii origin: https, no path, slash or default port.
const PLUGIN_ORIGIN = (() => {
  if (!PUBLIC_ORIGIN) return null;
  try {
    const o = new URL(PUBLIC_ORIGIN).origin;
    if (o === PUBLIC_ORIGIN && o.startsWith('https://')) return o;
  } catch (_e) {
    /* fall through */
  }
  console.error('server: PUBLIC_ORIGIN must be a bare https origin; /plugin is off');
  return null;
})();

function packPlugin() {
  const read = (f) => fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
  const m = JSON.parse(read('manifest.json'));
  const code = read('plugin.js');
  const readme = read('README.md');
  if (!m || typeof m.id !== 'string' || !m.host || typeof m.host !== 'object') throw new Error('bad manifest.json');
  if (Buffer.byteLength(readme) > PLUGIN_MAX_README) throw new Error('README.md too large');
  m.host.networkOrigins = [PLUGIN_ORIGIN];
  const bytes = Buffer.from(JSON.stringify({ manifest: m, code, readme }));
  if (bytes.length > PLUGIN_MAX_BYTES) throw new Error('artifact too large');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const url = `${PLUGIN_ORIGIN}/plugin/buzz-remote-agents.json`;
  const q = (v) => encodeURIComponent(v);
  return { bytes, sha256, link: `buzz://plugin-install?id=${q(m.id)}&url=${q(url)}&sha256=${sha256}` };
}

let PLUGIN = null;
if (PLUGIN_ORIGIN) {
  try {
    PLUGIN = packPlugin();
    console.log(`[plugin] serving ${PLUGIN_DIR}, sha256 ${PLUGIN.sha256}`);
  } catch (e) {
    console.error(`[plugin] not served: ${e.message}`);
  }
}

const server = http.createServer((req, res) => {
  try {
    if (hooks.routes && hooks.routes(req, res)) return;
  } catch (e) {
    console.error(`hook route ${req.method} ${req.url.split('?')[0]} failed: ${e.message}`);
    return json(res, 500, { error: 'hook failed' });
  }
  if (req.method === 'GET' && req.url === '/healthz') return res.end('ok');
  if (req.method === 'GET' && req.url === '/plugin/buzz-remote-agents.json') {
    if (!PLUGIN) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(PLUGIN.bytes);
  }
  if (req.method === 'GET' && req.url === '/plugin/install') {
    if (!PLUGIN) return json(res, 404, { error: 'not found' });
    // A browser opening this hands the link to Buzz; curl shows it in the body.
    res.writeHead(302, { location: PLUGIN.link, 'content-type': 'text/plain' });
    return res.end(`${PLUGIN.link}\n`);
  }
  if (req.url === '/v1' || req.url.startsWith('/v1/')) {
    if (!V1_TOKEN) return json(res, 404, { error: 'not found' });
    if (!bearerOk(req, V1_TOKEN)) return json(res, 401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let parsed = {};
      try {
        if (body) parsed = JSON.parse(body);
      } catch (_e) {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!parsed || typeof parsed !== 'object') parsed = {};
      v1(req, res, parsed).catch((e) => {
        console.error(`v1 ${req.method} ${req.url.split('?')[0]} failed: ${e.message}`);
        json(res, 502, { error: String(e.message || e) });
      });
    });
    return;
  }
  return json(res, 404, { error: 'not found' });
});

// ---- boot: restore saved agents ---------------------------------------------------
// Root's, not an agent's: it holds state.json and the archive.
fs.mkdirSync(AGENTS_DIR, { recursive: true });
fs.chownSync(AGENTS_DIR, 0, 0);
fs.chmodSync(AGENTS_DIR, 0o755);
// Every agent goes in the map before any starts: startChild saves state when
// it allocates a uid, and a save writes only what is in the map.
for (const meta of loadState()) agents.set(meta.slug, { meta, child: null });
for (const { meta } of [...agents.values()]) {
  if (meta.pending) continue; // waiting for activate: restored, not started
  try {
    startChild(meta);
  } catch (e) {
    // One agent's bad start (a hook throwing, a dir that won't claim) must not
    // keep the others down.
    console.error(`[${meta.slug}] not started: ${e.message}`);
  }
}
// Graceful shutdown: stop children so a container restart is clean (they respawn
// from state.json on next boot).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const a of agents.values()) {
      try {
        a.child && a.child.kill('SIGTERM');
      } catch (_e) {
        /* ignore */
      }
    }
    process.exit(0);
  });
}

console.log(`server up on :${PORT}, restored ${agents.size} agent(s)`);
server.listen(Number(PORT), '0.0.0.0');
