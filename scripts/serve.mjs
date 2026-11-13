// One-process host for the whole backend (used by the Render deployment):
// starts the API, the NEP-366 relayer, the underwriter agent, the collections agent and the payment forwarder,
// restarts any that exit, and serves the API and the relayer on a single public port:
//   /relay, /relay/health  -> relayer   everything else -> API     /healthz -> process status
//   PORT=10000 node scripts/serve.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 10000);
const API_PORT = 8787;
const RELAYER_PORT = 8788;

/** Which backend processes run, with the env each one needs on top of the shared env. */
export const PROCESSES = [
  { name: 'api', args: ['api/server.mjs'], env: { PORT: String(API_PORT) } },
  { name: 'relayer', args: ['relayer/server.mjs'], env: { RELAYER_PORT: String(RELAYER_PORT) }, needs: ['RELAYER_ACCOUNT'] },
  { name: 'agent', args: ['agent/run.mjs'], needs: ['AGENT_ACCOUNT', 'AGENT_PRIVATE_KEY'] },
  { name: 'collections', args: ['agent/collections.mjs'], needs: ['COLLECTOR_ACCOUNT'] },
  { name: 'forwarder', args: ['watcher/forwarder.mjs', '--interval', '15'], needs: ['FORWARDER_PRIVATE_KEY'] },
];

/** The upstream port for a request path. */
export const routeFor = (url) => (url === '/relay' || url.startsWith('/relay/') || url.startsWith('/relay?') ? RELAYER_PORT : API_PORT);

const state = new Map();
const children = new Set();

function start(p, attempt = 0) {
  const missing = (p.needs ?? []).filter((k) => !process.env[k]);
  if (missing.length) {
    state.set(p.name, { status: 'off', reason: `missing ${missing.join(', ')}` });
    console.log(`[serve] ${p.name} not started: missing ${missing.join(', ')}`);
    return;
  }
  const child = spawn(process.execPath, p.args, { cwd: ROOT, env: { ...process.env, ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const since = Date.now();
  state.set(p.name, { status: 'running', since: new Date(since).toISOString(), restarts: attempt });
  const tag = (stream) => stream.on('data', (b) => process.stdout.write(b.toString().replace(/^(?=.)/gm, `[${p.name}] `)));
  tag(child.stdout);
  tag(child.stderr);
  child.on('exit', (code) => {
    children.delete(child);
    // Back off on quick crashes, reset after a stable run.
    const next = Date.now() - since > 60_000 ? 0 : attempt + 1;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(next, 5));
    state.set(p.name, { status: 'restarting', exitCode: code, restarts: next, inMs: delay });
    console.log(`[serve] ${p.name} exited ${code}; restart in ${delay} ms`);
    setTimeout(() => start(p, next), delay);
  });
}

function proxy(req, res) {
  const port = routeFor(req.url ?? '/');
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json', 'access-control-allow-origin': process.env.CORS_ORIGIN || '*' });
    res.end(JSON.stringify({ error: 'UPSTREAM_STARTING' }));
  });
  req.pipe(up);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const p of PROCESSES) start(p);
  http
    .createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Object.fromEntries(state)));
        return;
      }
      proxy(req, res);
    })
    .listen(PORT, () => console.log(`[serve] backend on :${PORT} (api :${API_PORT}, relayer :${RELAYER_PORT})`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const c of children) c.kill('SIGTERM'); process.exit(0); });
}
