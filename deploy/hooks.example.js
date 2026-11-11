'use strict';
const crypto = require('crypto');
// A hooks module: mount it read-only and set HOOKS=/hooks/index.js.
// It runs inside the server, as root. Key anything per agent on its pubkey,
// not its name: names change on rename.
module.exports = (api) => ({
  beforeStart(agent) {
    return {
      env: { GIT_AUTHOR_NAME: agent.name },
      files: { '.gitconfig': `[user]\n\tname = ${agent.name}\n` },
      groups: [],
    };
  },
  // Answer a route and return true, or return false to let the server answer.
  // A hook route brings its own auth: the server checks nothing before it.
  routes(req, res) {
    if (req.method === 'GET' && req.url === '/hooks/agents') {
      const want = Buffer.from(`Bearer ${process.env.HOOKS_TOKEN || ''}`);
      const got = Buffer.from(req.headers.authorization || '');
      if (!process.env.HOOKS_TOKEN || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
        res.writeHead(401).end();
        return true;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(api.list().map(({ pubkey, name, running }) => ({ pubkey, name, running }))));
      return true;
    }
    return false;
  },
  onCreate(agent) {
    console.log(`[hooks] created ${agent.pubkey}`);
  },
  onRemove(agent) {
    console.log(`[hooks] removed ${agent.pubkey}`);
  },
});
