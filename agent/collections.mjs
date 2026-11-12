// Collections agent: for every Active pool,
//   - inside the reminder window before an unpaid order's due date, records one reminder with a pay link
//     and a Tidepool quote (dry unless TIDEPOOL_LIVE=1) in evidence/collections/<order_id>.json;
//   - once the pool is past due date + grace (contract: strictly greater), signs mark_default(pool_id)
//     and records evidence/defaults/<pool_id>.json with the tx hash and the pool_defaulted cover.
// Delivery of the reminder (email, SMS, ...) is out of scope: the file is the reminder.
//   node agent/collections.mjs --once        single pass
//   node agent/collections.mjs [--interval 30]
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../api/app.mjs';
import { createReminderWriter } from './reminder.mjs';
import { createAttestedChat } from './tee-quote.mjs';
import { DEFAULT_RPC, PAGE, fetchAll, evidencePath, writeJsonAtomic, assertTestnet, resolvePrivateKey, createView, createSigner } from './near.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COLLECTIONS_DIR = path.join(ROOT, 'evidence', 'collections');
export const DEFAULTS_DIR = path.join(ROOT, 'evidence', 'defaults');
export const DEFAULT_PAY_URL_BASE = 'http://localhost:3000/pay';
export const DEFAULT_WINDOW_SECONDS = 3 * 24 * 3600;
const NS = 1_000_000_000n;
const EVM = /^0x[0-9a-fA-F]{40}$/;

export const payUrl = (base, orderId) => `${base.replace(/\/+$/, '')}/${orderId}`;

/** The `pool_defaulted` event for `poolId` from logs our contract emitted, as { cover, needs_dao }, or null. */
export function poolDefaultedEvent(logs, poolId) {
  for (const l of logs ?? []) {
    if (typeof l !== 'string' || !l.startsWith('EVENT_JSON:')) continue;
    let e; try { e = JSON.parse(l.slice('EVENT_JSON:'.length)); } catch { continue; }
    if (e?.standard !== 'cashflow' || e.event !== 'pool_defaulted' || !Array.isArray(e.data)) continue;
    const d = e.data.find((x) => x?.pool_id === poolId);
    if (d && /^[0-9]+$/.test(d.cover ?? '') && typeof d.needs_dao === 'boolean') return { cover: d.cover, needs_dao: d.needs_dao };
  }
  return null;
}

/**
 * Quotes through the API's own POST /api/pay/quote handler, in-process: same order/pool/owed checks,
 * same signature validation, and in live mode the same evidence/quotes record /api/pay/status relies on.
 */
export function createApiQuoter({ handler, refundTo, originAsset = 'arb-sepolia-usdc' }) {
  return async (orderId) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ order_id: orderId, origin_asset: originAsset, refund_to: refundTo }))]);
    Object.assign(req, { method: 'POST', url: '/api/pay/quote', headers: { 'content-type': 'application/json' } });
    let status = 0; let body = '';
    const res = { setHeader() {}, writeHead(code) { status = code; }, end(chunk = '') { body += chunk; } };
    await handler(req, res);
    let out; try { out = JSON.parse(body); } catch { out = null; }
    if (status !== 200) throw new Error(`quote ${status} ${out?.error ?? 'UNKNOWN'}${out?.detail ? ` (${out.detail})` : ''}`);
    return out;
  };
}

/**
 * One pass. All I/O is injected:
 *   view(method, args) -> parsed JSON
 *   sign(method, args) -> { txHash, logs }         (logs emitted by our contract)
 *   quote(orderId) -> /api/pay/quote response, or null to record reminders without a quote
 *   writeReminder(order, { payUrl, nowNs }) -> message (agent/reminder.mjs); default: the template
 */
export async function runCollections({ view, sign, quote = null, writeReminder = createReminderWriter({ chat: null }), contract, collector,
  remindersDir = COLLECTIONS_DIR, defaultsDir = DEFAULTS_DIR, windowNs = BigInt(DEFAULT_WINDOW_SECONDS) * NS,
  payUrlBase = DEFAULT_PAY_URL_BASE, nowNs = () => BigInt(Date.now()) * 1_000_000n, log = console.log, pageSize = PAGE }) {
  const summary = { reminded: [], defaulted: [], skipped: [], failed: [] };
  const graceNs = BigInt((await view('get_config', {})).grace_ns);
  const pools = (await fetchAll(view, 'get_pools', pageSize)).filter((p) => p.status === 'Active');
  if (!pools.length) return summary;
  const unpaid = new Map();
  for (const o of await fetchAll(view, 'get_orders', pageSize)) {
    if (o.status !== 'Pooled' || BigInt(o.paid) >= BigInt(o.amount)) continue;
    unpaid.set(o.pool_id, [...(unpaid.get(o.pool_id) ?? []), o]);
  }
  const now = nowNs();

  for (const pool of pools) {
    try {
      if (now > BigInt(pool.due_date) + graceNs) {
        const file = evidencePath(defaultsDir, pool.id);
        if (existsSync(file)) { summary.skipped.push({ pool_id: pool.id }); continue; } // defaulted, RPC may lag
        const { txHash, logs } = await sign('mark_default', { pool_id: pool.id });
        const ev = poolDefaultedEvent(logs, pool.id);
        await writeJsonAtomic(file, { pool_id: pool.id, contract, collector, tx_hash: txHash,
          cover: ev?.cover ?? null, needs_dao: ev?.needs_dao ?? null, event_found: !!ev,
          due_date: pool.due_date, grace_ns: graceNs.toString(), timestamp: new Date().toISOString() });
        summary.defaulted.push({ pool_id: pool.id, txHash, cover: ev?.cover ?? null, needs_dao: ev?.needs_dao ?? null });
        log(`pool ${pool.id}: mark_default tx=${txHash} cover=${ev?.cover ?? '?'} needs_dao=${ev?.needs_dao ?? '?'}`);
        continue;
      }
    } catch (e) {
      summary.failed.push({ pool_id: pool.id, error: e.message });
      log(`pool ${pool.id}: FAILED ${e.message}`);
      continue;
    }

    for (const order of unpaid.get(pool.id) ?? []) {
      try {
        const due = BigInt(order.due_date);
        if (!(now >= due - windowNs && now < due)) continue;
        const file = evidencePath(remindersDir, order.id);
        if (existsSync(file)) { summary.skipped.push({ order_id: order.id }); continue; }
        const q = quote ? await quote(order.id) : null;
        const url = payUrl(payUrlBase, order.id);
        const message = await writeReminder(order, { payUrl: url, nowNs: now });
        await writeJsonAtomic(file, {
          order_id: order.id, pool_id: pool.id, invoice_no: order.invoice_no, merchant: order.merchant, customer: order.customer,
          amount_due: (BigInt(order.amount) - BigInt(order.paid)).toString(), currency: order.currency,
          due_date: order.due_date, window_start: (due - windowNs).toString(),
          pay_url: url, message,
          quote: q && { dry: q.dry, depositAddress: q.depositAddress ?? null, amountIn: q.amountIn, minAmountOut: q.minAmountOut, deadline: q.deadline },
          channel: null, contract, collector, reminded_at: new Date().toISOString(),
        });
        summary.reminded.push(order.id);
        log(`order ${order.id}: reminder (${message.source}) ${url}${q ? ` quote=${q.dry ? 'dry' : q.depositAddress}` : ''}`);
      } catch (e) {
        summary.failed.push({ order_id: order.id, error: e.message });
        log(`order ${order.id}: FAILED ${e.message}`);
      }
    }
  }
  return summary;
}

// ---------- real NEAR wiring ----------

export function loadConfig(env = process.env, { home } = {}) {
  const missing = ['CASHFLOW_CONTRACT', 'COLLECTOR_ACCOUNT'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
  const rpcUrl = env.NEAR_RPC || DEFAULT_RPC;
  assertTestnet({ accounts: [env.CASHFLOW_CONTRACT, env.COLLECTOR_ACCOUNT], rpcUrl, network: env.NEAR_NETWORK ?? 'testnet' });
  const windowSec = Number(env.COLLECTIONS_WINDOW_SECONDS || DEFAULT_WINDOW_SECONDS);
  if (!Number.isSafeInteger(windowSec) || windowSec < 0) throw new Error('COLLECTIONS_WINDOW_SECONDS must be a non-negative integer');
  const refundTo = env.COLLECTIONS_REFUND_TO || null;
  if (refundTo && (!EVM.test(refundTo) || /^0x0{40}$/i.test(refundTo))) throw new Error('COLLECTIONS_REFUND_TO must be a non-zero EVM address');
  return {
    rpcUrl, contract: env.CASHFLOW_CONTRACT, collector: env.COLLECTOR_ACCOUNT,
    privateKey: resolvePrivateKey(env.COLLECTOR_ACCOUNT, env.COLLECTOR_PRIVATE_KEY, home ? { home } : {}),
    windowNs: BigInt(windowSec) * NS, payUrlBase: env.PAY_URL_BASE || DEFAULT_PAY_URL_BASE, refundTo,
    apiKey: env.NEARAI_API_KEY || null, model: env.NEARAI_MODEL || null,
    live: env.TIDEPOOL_LIVE === '1', intervalSec: Number(env.COLLECTIONS_POLL_SECONDS || 30),
  };
}

async function main(argv) {
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const cfg = loadConfig();
  const once = argv.includes('--once');
  const i = argv.indexOf('--interval');
  const intervalSec = i >= 0 ? Number(argv[i + 1]) : cfg.intervalSec;
  if (!(intervalSec >= 1)) throw new Error('--interval must be >= 1 second');

  const handler = createApp({ contractId: cfg.contract, rpcUrl: cfg.rpcUrl, live: cfg.live, evidenceDir: path.join(ROOT, 'evidence') });
  const deps = {
    view: createView({ rpcUrl: cfg.rpcUrl, contractId: cfg.contract }),
    sign: createSigner({ rpcUrl: cfg.rpcUrl, accountId: cfg.collector, privateKey: cfg.privateKey, contractId: cfg.contract }),
    quote: cfg.refundTo ? createApiQuoter({ handler, refundTo: cfg.refundTo }) : null,
    writeReminder: createReminderWriter({ chat: cfg.apiKey && cfg.model ? createAttestedChat({ apiKey: cfg.apiKey, model: cfg.model }) : null }),
    contract: cfg.contract, collector: cfg.collector, windowNs: cfg.windowNs, payUrlBase: cfg.payUrlBase,
  };
  console.log(`collections agent ${cfg.collector} -> ${cfg.contract} via ${cfg.rpcUrl}, quotes=${!deps.quote ? 'off (COLLECTIONS_REFUND_TO unset)' : cfg.live ? 'LIVE' : 'dry'}${once ? ' (once)' : ` every ${intervalSec}s`}`);
  for (;;) {
    try {
      const s = await runCollections(deps);
      console.log(`pass: reminded ${s.reminded.length}, defaulted ${s.defaulted.length}, skipped ${s.skipped.length}, failed ${s.failed.length}`);
      if (once) return s.failed.length ? 1 : 0;
    } catch (e) {
      console.error(`pass failed: ${e.message}`);
      if (once) return 1;
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
