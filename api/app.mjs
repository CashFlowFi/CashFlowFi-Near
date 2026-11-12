// HTTP API for the frontend (docs/INTERFACE.md, "Off-chain APIs"). Node built-ins only.
// createApp(deps) returns a node:http request handler; every external call goes through injected deps.
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as tidepoolModule from '../watcher/tidepool.mjs';
import { reasonHash } from '../agent/underwriter.mjs';
import { DEFAULT_RPC, viewCall, txStatus, payReceiptFromTx, paymentEvents } from './near.mjs';

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
  if (PAY_INPUT_CODES.has(code)) return new HttpError(400, code);
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
  rpcUrl = process.env.NEAR_RPC || DEFAULT_RPC,
  live = process.env.TIDEPOOL_LIVE === '1',
  evidenceDir = join(import.meta.dirname, '..', 'evidence'),
  corsOrigin = process.env.CORS_ORIGIN || '*',
  fetchImpl = fetch,
  tidepool = tidepoolModule,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const near = { rpcUrl, fetchImpl };
  const { TIDEPOOL } = tidepool;
  const paths = {
    ledger: join(evidenceDir, 'ledger', 'payments.jsonl'),
    quote: (addr) => join(evidenceDir, 'quotes', `${addr.toLowerCase()}.json`),
    payment: (id) => join(evidenceDir, 'payments', `${id}.json`),
    attestation: (id) => join(evidenceDir, 'attestations', `${id}.json`),
  };

  const needContract = () => { if (!contractId) throw new HttpError(503, 'CASHFLOW_CONTRACT_NOT_SET'); };
  const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const writeJson = async (p, v) => { await mkdir(join(p, '..'), { recursive: true }); await writeFile(p, JSON.stringify(v, null, 2) + '\n'); };
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
  async function readLedger() {
    let text; try { text = await readFile(paths.ledger, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // ---- POST /api/pay/quote ----
  async function quote(body) {
    needContract();
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
    const request = tidepool.payQuoteRequest({ contractId, orderId, amount: owed.toString(), refundTo: body.refund_to, origin, dry: !live, now: now() });
    const q = await tidepool.fetchPayQuote(request, { fetchImpl, allowExecution: live });
    const deadline = q.response?.quote?.deadline ?? request.deadline;
    if (!request.dry) {
      // Remembered so /api/pay/status checks the delivery against the exact request we signed off on.
      await writeJson(paths.quote(q.depositAddress), { order_id: orderId, depositAddress: q.depositAddress, request, response: q.response, saved_at: new Date(now() * 1000).toISOString() });
    }
    return { depositAddress: q.depositAddress, amountIn: q.amountIn, deadline, dry: request.dry, order_id: orderId, minAmountOut: q.minAmountOut };
  }

  // ---- GET /api/pay/status ----
  async function status(params) {
    needContract();
    const depositAddress = params.get('depositAddress');
    if (!EVM.test(depositAddress ?? '')) throw bad('PAY_DEPOSIT_ADDRESS');
    const st = await tidepool.fetchStatus(depositAddress, { fetchImpl });
    const saved = await readJson(paths.quote(depositAddress));
    // Prefer our own saved request. The provider's echo is accepted only if it targets our contract; the
    // on-chain check below then verifies receiver and msg independently.
    const request = saved?.request ?? st?.quoteResponse?.quoteRequest;
    if (!request || request.recipient !== contractId || typeof request.customRecipientMsg !== 'string') throw new HttpError(404, 'QUOTE_UNKNOWN');
    let orderId; try { orderId = JSON.parse(request.customRecipientMsg).pay.order_id; } catch { throw new HttpError(404, 'QUOTE_UNKNOWN'); }
    if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new HttpError(404, 'QUOTE_UNKNOWN');

    const originList = (st?.swapDetails?.originChainTxHashes ?? []).map((x) => (typeof x === 'string' ? x : x?.hash)).filter((h) => typeof h === 'string');
    const originTx = originList[0] ?? null;
    const candidates = tidepool.nearDestinationHashes(st);
    let nearReceipt = { found: false }; let nearTx = null;
    if (st?.status === 'SUCCESS') {
      for (const h of candidates) {
        const tx = await txStatus(h, TIDEPOOL.verifier, near);
        const r = payReceiptFromTx(tx, { contractId, tokenId: TIDEPOOL.destinationToken });
        if (r.found) { nearReceipt = r; nearTx = h; break; }
      }
    }
    let c = tidepool.classifyPayment({ status: st, request, nearReceipt });
    const events = nearReceipt.found ? paymentEvents(nearReceipt.logs, orderId) : [];
    if (c.outcome === 'delivered' && events.length === 0) c = { outcome: 'ambiguous', evidence: c.evidence, reason: 'No payment_applied event for this order' };
    const destinationTx = nearTx ?? candidates[0] ?? null;

    if (c.outcome === 'delivered') {
      const amount = events.reduce((s, e) => s + BigInt(e.amount), 0n).toString();
      const row = { recorded_at: new Date(now() * 1000).toISOString(), order_id: orderId, amount, deposit_address: depositAddress, origin_tx: originTx, near_tx: nearTx, evidence: c.evidence };
      const ledger = await readLedger();
      if (!ledger.some((r) => r.near_tx === nearTx)) {
        await mkdir(join(paths.ledger, '..'), { recursive: true });
        await appendFile(paths.ledger, JSON.stringify(row) + '\n');
        const file = (await readJson(paths.payment(orderId))) ?? { order_id: orderId, contract: contractId, payments: [] };
        file.payments.push({ ...row, provider_status: st.status, destination_hashes: candidates, events, ft_on_transfer_receipt: nearReceipt.onTransferReceiptId });
        await writeJson(paths.payment(orderId), file);
      }
    }
    return { status: c.outcome, originTx, destinationTx, nearTx: c.outcome === 'delivered' ? nearTx : null, evidence: c.evidence, ...(c.reason ? { reason: c.reason } : {}) };
  }

  // ---- GET /api/agent/verdicts ----
  async function verdicts(params) {
    needContract();
    const orderId = parseOrderId(params.get('order_id'));
    const [order, file] = await Promise.all([getOrder(orderId), readJson(paths.attestation(orderId))]);
    if (!order.verdict) throw new HttpError(404, 'NOT_ATTESTED');
    // Verdict and score come from chain. Off-chain reasons are shown only if they hash to the on-chain reason_hash.
    const reasons = Array.isArray(file?.reasons) && order.reason_hash && reasonHash(file.reasons) === order.reason_hash ? file.reasons : [];
    const tee = file?.attestation ?? file?.tee_attestation ?? null;
    return {
      verdict: order.verdict, score: order.score, reasons,
      attestation: {
        // Only true when a TEE attestation is recorded as verified with a report. No attestation: no privacy claim.
        verified: tee?.verified === true && typeof tee?.report_url === 'string',
        model: typeof file?.model === 'string' ? file.model : null,
        report_url: typeof tee?.report_url === 'string' ? tee.report_url : null,
      },
    };
  }

  // ---- GET /api/ledger/payments ----
  async function ledger(params) {
    const format = params.get('format');
    if (format !== null && format !== 'csv' && format !== 'json') throw bad('FORMAT');
    const rows = await readLedger();
    return format === 'csv' ? { csv: toCsv(rows) } : rows;
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
