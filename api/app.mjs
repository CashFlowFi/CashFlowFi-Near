// HTTP API for the frontend (docs/INTERFACE.md, "Off-chain APIs"). Node built-ins only.
// createApp(deps) returns a node:http request handler; every external call goes through injected deps.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as tidepoolModule from '../watcher/tidepool.mjs';
import { reasonHash } from '../agent/underwriter.mjs';
import { DEFAULT_RPC, viewCall, txStatus, lookupTx } from './near.mjs';
import { createFileStore, processDeposit } from '../watcher/forwarder.mjs';
import { loadPools, matchPools, parseMatchRequest } from '../agent/matcher.mjs';
import { DEFAULT_MATCH_MODEL } from '../agent/tee.mjs';
import { createAttestedChat } from '../agent/tee-quote.mjs';
import { verdictVerified } from '../agent/verdict-proof.mjs';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
const bad = (code, detail) => new HttpError(400, code, detail);

// Codes thrown by watcher/tidepool.mjs: caller mistakes are 400, everything else is the provider's fault.
const PAY_INPUT_CODES = new Set(['PAY_UNSUPPORTED_ORIGIN', 'PAY_REFUND_ADDRESS', 'PAY_ORDER_ID', 'PAY_AMOUNT', 'PAY_CONTRACT']);
function mapError(e) {
  if (e instanceof HttpError) return e;
  const code = String(e?.message ?? 'INTERNAL');
  if (PAY_INPUT_CODES.has(code) || code.startsWith('MATCH_')) return new HttpError(400, code);
  if (code === 'PAY_EXECUTION_DISABLED') return new HttpError(403, code);
  if (code.startsWith('PAY_') || code.startsWith('NEAR_') || e?.name === 'SyntaxError' || e?.name === 'TimeoutError')
    return new HttpError(502, code.startsWith('PAY_') || code.startsWith('NEAR_') ? code : 'UPSTREAM_BAD_RESPONSE', e?.detail);
  return new HttpError(500, 'INTERNAL');
}

/** Map the frontend's origin_asset to the watcher's origin key. Accepts the key or the full nep141 asset id. */
function originKey(originAsset, TIDEPOOL) {
  if (typeof originAsset !== 'string') throw bad('ORIGIN_ASSET');
  if (TIDEPOOL.origins[originAsset]) return originAsset;
  const hit = Object.entries(TIDEPOOL.origins).find(([, o]) => o.asset === originAsset);
  if (!hit) throw bad('PAY_UNSUPPORTED_ORIGIN');
  return hit[0];
}

const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const LEDGER_COLUMNS = ['recorded_at', 'order_id', 'amount', 'deposit_address', 'origin_tx', 'near_tx', 'evidence'];
export function toCsv(rows) {
  return [LEDGER_COLUMNS.join(','), ...rows.map((r) => LEDGER_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

export function createApp({
  contractId = process.env.CASHFLOW_CONTRACT,
  forwarder = process.env.FORWARDER_ACCOUNT,
  rpcUrl = process.env.NEAR_RPC || DEFAULT_RPC,
  live = process.env.TIDEPOOL_LIVE === '1',
  evidenceDir = join(import.meta.dirname, '..', 'evidence'),
  corsOrigin = process.env.CORS_ORIGIN || '*',
  fetchImpl = fetch,
  tidepool = tidepoolModule,
  now = () => Math.floor(Date.now() / 1000),
  matchModel = process.env.MATCH_MODEL || DEFAULT_MATCH_MODEL,
  // null -> deterministic fallback ranking. The intent is never stored or logged (agent/matcher.mjs).
  matchChat = process.env.NEARAI_API_KEY ? createAttestedChat({ apiKey: process.env.NEARAI_API_KEY, model: matchModel }) : null,
} = {}) {
  const near = { rpcUrl, fetchImpl };
  const { TIDEPOOL } = tidepool;
  const store = createFileStore(evidenceDir);
  const paths = { attestation: (id) => join(evidenceDir, 'attestations', `${id}.json`) };

  const needContract = () => { if (!contractId) throw new HttpError(503, 'CASHFLOW_CONTRACT_NOT_SET'); };
  const needForwarder = () => { needContract(); if (!forwarder) throw new HttpError(503, 'FORWARDER_ACCOUNT_NOT_SET'); };
  const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  async function getOrder(id) {
    const order = await viewCall(contractId, 'get_order', { id }, near);
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND');
    return order;
  }
  const parseOrderId = (v) => {
    const n = typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : v;
    if (!Number.isSafeInteger(n) || n <= 0) throw bad('ORDER_ID');
    return n;
  };

  // ---- POST /api/pay/quote ----
  // Tidepool testnet ignores customRecipientMsg, so the quote delivers to the forwarder with a plain transfer and
  // the order is bound in our own evidence. watcher/forwarder.mjs forwards it with {"pay":{"order_id":N}}.
  async function quote(body) {
    needForwarder();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('BODY');
    const orderId = parseOrderId(body.order_id);
    const origin = originKey(body.origin_asset, TIDEPOOL);
    if (typeof body.refund_to !== 'string' || !EVM.test(body.refund_to)) throw bad('PAY_REFUND_ADDRESS');
    const order = await getOrder(orderId);
    if (order.status !== 'Pooled' || order.pool_id === null || order.pool_id === undefined) throw new HttpError(409, 'ORDER_NOT_PAYABLE', order.status);
    const pool = await viewCall(contractId, 'get_pool', { id: order.pool_id }, near);
    if (pool?.status !== 'Active') throw new HttpError(409, 'POOL_NOT_ACTIVE', pool?.status ?? null);
    const owed = BigInt(order.amount) - BigInt(order.paid);
    if (owed <= 0n) throw new HttpError(409, 'ORDER_ALREADY_PAID');
    const request = tidepool.forwardQuoteRequest({ forwarder, amount: owed.toString(), refundTo: body.refund_to, origin, dry: !live, now: now() });
    const q = await tidepool.fetchPayQuote(request, { fetchImpl, allowExecution: live, purpose: 'forward' });
    const deadline = q.response?.quote?.deadline ?? request.deadline;
    if (!request.dry) {
      // The binding deposit -> order, saved before any money moves. The forwarder acts only on these.
      await store.saveBinding({ order_id: orderId, depositAddress: q.depositAddress, amountIn: q.amountIn, minAmountOut: q.minAmountOut,
        request, response: q.response, source: 'api', saved_at: new Date(now() * 1000).toISOString() });
    }
    return { depositAddress: q.depositAddress, amountIn: q.amountIn, deadline, dry: request.dry, order_id: orderId, minAmountOut: q.minAmountOut };
  }

  // ---- GET /api/pay/status ----
  // Read-only: provider status + our NEAR receipts + forwarder evidence. Only the forwarder writes.
  const STATUS = { pending: 'pending', ready: 'forwarding', forwarding: 'forwarding', delivered: 'delivered', refunded: 'refunded', failed: 'failed', held: 'failed', ambiguous: 'ambiguous' };
  async function status(params) {
    needForwarder();
    const depositAddress = params.get('depositAddress');
    if (!EVM.test(depositAddress ?? '')) throw bad('PAY_DEPOSIT_ADDRESS');
    const binding = await store.readBinding(depositAddress);
    if (!binding) throw new HttpError(404, 'QUOTE_UNKNOWN');
    const deps = {
      config: { contractId, forwarder, tokenId: TIDEPOOL.destinationToken }, store, now,
      fetchStatus: (addr) => tidepool.fetchStatus(addr, { fetchImpl }),
      txStatus: (h, sender) => txStatus(h, sender, near),
      lookupTx: (h, sender) => lookupTx(h, sender, near),
    };
    let r;
    try { r = await processDeposit(binding, deps, { forward: false, reverify: true }); } catch (e) {
      if (e.message === 'BINDING_INVALID') throw new HttpError(404, 'QUOTE_UNKNOWN');
      throw e;
    }
    const rec = r.record ?? {};
    const st = STATUS[r.outcome] ?? 'ambiguous';
    const reason = r.outcome === 'ready' ? 'AWAITING_FORWARD: delivered to the forwarder, not yet paid into the contract' : rec.reason;
    return {
      status: st, originTx: rec.origin_tx ?? null, destinationTx: rec.delivery_tx ?? rec.destination_hashes?.[0] ?? null,
      nearTx: st === 'delivered' ? rec.forward_tx : null, evidence: rec.evidence ?? 'provider-claim-only', ...(reason ? { reason } : {}),
    };
  }

  // ---- GET /api/agent/verdicts ----
  async function verdicts(params) {
    needContract();
    const orderId = parseOrderId(params.get('order_id'));
    const [order, file] = await Promise.all([getOrder(orderId), readJson(paths.attestation(orderId))]);
    if (!order.verdict) throw new HttpError(404, 'NOT_ATTESTED');
    // Verdict and score come from chain. Off-chain reasons are shown only if they hash to the on-chain reason_hash.
    const reasons = Array.isArray(file?.reasons) && order.reason_hash && reasonHash(file.reasons) === order.reason_hash ? file.reasons : [];
    // verified is recomputed on every request (signature re-check + binding to this on-chain verdict), never read from the file.
    const verified = await verdictVerified(file, order);
    return {
      verdict: order.verdict, score: order.score, reasons,
      attestation: {
        verified,
        model: typeof file?.model === 'string' ? file.model : null,
        report_url: verified ? `evidence/attestations/${orderId}.json` : null,
      },
    };
  }

  // ---- GET /api/ledger/payments ----
  async function ledger(params) {
    const format = params.get('format');
    if (format !== null && format !== 'csv' && format !== 'json') throw bad('FORMAT');
    const rows = await store.readLedger();
    return format === 'csv' ? { csv: toCsv(rows) } : rows;
  }

  // ---- POST /api/invest/match ----
  // Hard filters in code, then a TEE-verified ranking. A suggestion only: investing stays ft_transfer_call.
  async function investMatch(body) {
    needContract();
    const request = parseMatchRequest(body);
    const { pools, scores } = await loadPools((method, args) => viewCall(contractId, method, args, near));
    return matchPools({ ...request, pools, scores, nowNs: BigInt(now()) * 1_000_000_000n, chat: matchChat, model: matchModel });
  }

  async function readBody(req) {
    const ct = req.headers['content-type'] ?? '';
    if (!ct.startsWith('application/json')) throw new HttpError(415, 'CONTENT_TYPE');
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new HttpError(413, 'BODY_TOO_LARGE'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('BODY_NOT_JSON'); }
  }

  const routes = {
    'POST /api/pay/quote': async (req) => quote(await readBody(req)),
    'GET /api/pay/status': (req, url) => status(url.searchParams),
    'GET /api/agent/verdicts': (req, url) => verdicts(url.searchParams),
    'GET /api/ledger/payments': (req, url) => ledger(url.searchParams),
    'POST /api/invest/match': async (req) => investMatch(await readBody(req)),
  };

  return async function handler(req, res) {
    res.setHeader('access-control-allow-origin', corsOrigin);
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('vary', 'origin');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        const known = Object.keys(routes).some((k) => k.endsWith(` ${url.pathname}`));
        throw new HttpError(known ? 405 : 404, known ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND');
      }
      const out = await route(req, url);
      if (out?.csv !== undefined) return send(200, out.csv, 'text/csv; charset=utf-8');
      return send(200, out);
    } catch (e) {
      const h = mapError(e);
      if (h.status >= 500 && h.code === 'INTERNAL') console.error(e);
      return send(h.status, { error: h.code, ...(h.detail !== undefined ? { detail: h.detail } : {}) });
    }
  };
}
