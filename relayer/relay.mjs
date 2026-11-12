// NEP-366 meta-transaction relayer: decode a SignedDelegate, check it against a strict allowlist, then pay
// the gas by wrapping it in a transaction signed by the relayer account.
// Everything external (RPC reads, signing, clock) is injected through `chain` / `now`, so tests never touch
// the network. Node built-ins and near-api-js only.
//
// Who pays what (nearcore tx_cost): the relayer is the transaction signer, so it pays all gas AND every
// deposit attached inside the delegate. The allowlist therefore caps both.
import { createHash } from 'node:crypto';
import { PublicKey, Signature, actions, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate } from 'near-api-js';

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
const ACTION_NAMES = ['CreateAccount', 'DeployContract', 'FunctionCall', 'Transfer', 'Stake', 'AddKey', 'DeleteKey',
  'DeleteAccount', 'Delegate', 'DeployGlobalContract', 'UseGlobalContract', 'DeterministicStateInit',
  'TransferToGasKey', 'WithdrawFromGasKey'];
const FUNCTION_CALL = 2;
const ED25519 = 0;
const MAX_ACTIONS = 4;
const MAX_ARGS = 2048;
const MAX_BODY = 16 * 1024;
const MAX_TOTAL_GAS = 300n * TGAS;
// Fixed cost of the outer tx + delegate receipt, counted against the spend cap on top of attached gas.
const OVERHEAD_GAS = 10n * TGAS;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const FT_MSG_KEYS = new Set(['invest', 'pay', 'repay', 'seed_insurance']);

/**
 * Allowlist, checked against contracts/cashflow/src/lib.rs:
 *   - only nft_transfer is #[payable] (NEP-171 asserts exactly 1 yocto); claim and create_pool are not payable,
 *     so any deposit would panic on-chain anyway. ft_transfer_call (NEP-141) asserts exactly 1 yocto.
 *   - gas caps follow docs/INTERFACE.md (30 TGas default, claim 100) and scripts/demo.mjs (ft_transfer_call 300).
 */
export const CONTRACT_METHODS = {
  create_order: { deposit: 0n, maxGas: 30n * TGAS },
  approve_receipt: { deposit: 0n, maxGas: 30n * TGAS },
  create_pool: { deposit: 0n, maxGas: 50n * TGAS },
  claim: { deposit: 0n, maxGas: 100n * TGAS },
  nft_transfer: { deposit: ONE_YOCTO, maxGas: 30n * TGAS },
};
export const TOKEN_METHODS = {
  ft_transfer_call: { deposit: ONE_YOCTO, maxGas: 300n * TGAS },
};

export class RelayError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}
const reject = (code, detail) => new RelayError(403, code, detail);
const malformed = (code, detail) => new RelayError(400, code, detail);

// ---------- borsh decode (only what a relayable SignedDelegate may contain) ----------

class Reader {
  constructor(bytes) { this.b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.o = 0; }
  take(n) {
    if (this.o + n > this.b.length) throw malformed('DECODE_TRUNCATED');
    const s = this.b.subarray(this.o, this.o + n); this.o += n; return s;
  }
  u8() { return this.take(1)[0]; }
  u32() { return this.take(4).readUInt32LE(0); }
  u64() { return this.take(8).readBigUInt64LE(0); }
  u128() { const s = this.take(16); return s.readBigUInt64LE(0) | (s.readBigUInt64LE(8) << 64n); }
  bytes(max) { const n = this.u32(); if (n > max) throw malformed('DECODE_TOO_LONG'); return new Uint8Array(this.take(n)); }
  string(max) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(max)); }
    catch (e) { if (e instanceof RelayError) throw e; throw malformed('DECODE_UTF8'); }
  }
}

/**
 * Decode a borsh SignedDelegate. Any action other than FunctionCall and any non-ed25519 key is rejected here,
 * before its body is parsed. The result is rebuilt with near-api-js and must re-encode to the exact input bytes,
 * so what we validate is byte-for-byte what we submit.
 */
export function decodeSignedDelegate(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw malformed('SIGNED_DELEGATE_EMPTY');
  const r = new Reader(bytes);
  const senderId = r.string(64);
  const receiverId = r.string(64);
  const n = r.u32();
  if (n === 0) throw malformed('NO_ACTIONS');
  if (n > MAX_ACTIONS) throw reject('TOO_MANY_ACTIONS', `max ${MAX_ACTIONS}`);
  const calls = [];
  for (let i = 0; i < n; i++) {
    const tag = r.u8();
    if (tag !== FUNCTION_CALL) throw reject('ACTION_NOT_ALLOWED', ACTION_NAMES[tag] ?? `tag ${tag}`);
    calls.push({ methodName: r.string(256), args: r.bytes(MAX_ARGS), gas: r.u64(), deposit: r.u128() });
  }
  const nonce = r.u64();
  const maxBlockHeight = r.u64();
  if (r.u8() !== ED25519) throw reject('KEY_TYPE_NOT_ALLOWED', 'ed25519 only');
  const pk = new Uint8Array(r.take(32));
  if (r.u8() !== ED25519) throw reject('KEY_TYPE_NOT_ALLOWED', 'ed25519 only');
  const sig = new Uint8Array(r.take(64));
  if (r.o !== bytes.length) throw malformed('DECODE_TRAILING_BYTES');

  const delegateAction = buildDelegateAction({
    senderId, receiverId, nonce, maxBlockHeight,
    publicKey: new PublicKey({ keyType: ED25519, data: pk }),
    actions: calls.map((c) => actions.functionCall(c.methodName, c.args, c.gas, c.deposit)),
  });
  const signedDelegate = actions.signedDelegate({ delegateAction, signature: new Signature({ keyType: ED25519, data: sig }) }).signedDelegate;
  if (!Buffer.from(encodeSignedDelegate(signedDelegate)).equals(Buffer.from(bytes))) throw malformed('DECODE_NOT_CANONICAL');
  return { signedDelegate, senderId, receiverId, calls, nonce, maxBlockHeight, publicKey: delegateAction.publicKey.toString(), signature: sig };
}

/** NEP-366 signature check: ed25519 over sha256(NEP-461 prefix || borsh(DelegateAction)). */
export function verifyDelegateSignature(signedDelegate) {
  const { delegateAction, signature } = signedDelegate;
  const hash = createHash('sha256').update(encodeDelegateAction(delegateAction)).digest();
  return delegateAction.publicKey.verify(new Uint8Array(hash), signature.data);
}

// ---------- static allowlist ----------

function jsonArgs(bytes) {
  let v; try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw malformed('ARGS_NOT_JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw malformed('ARGS_NOT_OBJECT');
  return v;
}

function checkFtTransferCall(args, contractId) {
  const extra = Object.keys(args).filter((k) => !['receiver_id', 'amount', 'msg', 'memo'].includes(k));
  if (extra.length) throw reject('ARGS_NOT_ALLOWED', extra.join(','));
  if (args.receiver_id !== contractId) throw reject('FT_RECEIVER_NOT_ALLOWED', String(args.receiver_id));
  if (typeof args.amount !== 'string' || !/^[1-9][0-9]{0,38}$/.test(args.amount)) throw malformed('FT_AMOUNT');
  let msg; try { msg = JSON.parse(args.msg); } catch { throw reject('FT_MSG_NOT_ALLOWED'); }
  const keys = msg && typeof msg === 'object' && !Array.isArray(msg) ? Object.keys(msg) : [];
  if (keys.length !== 1 || !FT_MSG_KEYS.has(keys[0])) throw reject('FT_MSG_NOT_ALLOWED', keys.join(',') || null);
}

/** Pure checks on a decoded delegate. Chain-dependent checks (key, nonce, block height) live in the relayer. */
export function validateDelegate(d, { contractId, tokenId, relayerId }) {
  if (!ACCOUNT_ID.test(d.senderId)) throw malformed('SENDER_ID');
  if (d.senderId === relayerId || d.senderId === contractId || d.senderId === tokenId) throw reject('SENDER_NOT_ALLOWED', d.senderId);
  const table = d.receiverId === contractId ? CONTRACT_METHODS : d.receiverId === tokenId ? TOKEN_METHODS : null;
  if (!table) throw reject('RECEIVER_NOT_ALLOWED', d.receiverId);
  let totalGas = 0n;
  for (const c of d.calls) {
    const rule = Object.hasOwn(table, c.methodName) ? table[c.methodName] : null;
    if (!rule) throw reject('METHOD_NOT_ALLOWED', `${d.receiverId}.${c.methodName}`);
    if (c.deposit !== rule.deposit) throw reject('DEPOSIT_NOT_ALLOWED', `${c.methodName} needs ${rule.deposit} yocto, got ${c.deposit}`);
    if (c.gas <= 0n || c.gas > rule.maxGas) throw reject('GAS_NOT_ALLOWED', `${c.methodName} max ${rule.maxGas / TGAS} TGas`);
    totalGas += c.gas;
    const args = jsonArgs(c.args);
    if (c.methodName === 'ft_transfer_call') checkFtTransferCall(args, contractId);
  }
  if (totalGas > MAX_TOTAL_GAS) throw reject('GAS_NOT_ALLOWED', 'total gas over 300 TGas');
  return { totalGas, totalDeposit: d.calls.reduce((s, c) => s + c.deposit, 0n) };
}

/** Access key must exist, be fresh (nonce), and, if function-call scoped, cover this receiver and these methods. */
function checkAccessKey(key, d) {
  if (!key) throw reject('ACCESS_KEY_NOT_FOUND', d.publicKey);
  if (d.nonce <= BigInt(key.nonce)) throw reject('NONCE_TOO_LOW', `key nonce ${key.nonce}`);
  const fc = key.permission?.FunctionCall;
  if (key.permission === 'FullAccess' || key.permission?.FullAccess !== undefined) return;
  if (!fc) throw reject('ACCESS_KEY_NOT_ALLOWED', 'unsupported permission');
  if (fc.receiver_id !== d.receiverId) throw reject('ACCESS_KEY_NOT_ALLOWED', 'key is for another receiver');
  const names = fc.method_names ?? [];
  if (names.length && !d.calls.every((c) => names.includes(c.methodName))) throw reject('ACCESS_KEY_NOT_ALLOWED', 'method not on key');
  if (d.calls.some((c) => c.deposit > 0n)) throw reject('ACCESS_KEY_NOT_ALLOWED', 'function-call keys cannot attach a deposit');
}

const receiptFailures = (res) => [
  ...(res?.status?.Failure ? [res.status.Failure] : []),
  ...(res?.receipts_outcome ?? []).map((o) => o?.outcome?.status?.Failure).filter(Boolean),
];

// ---------- relayer ----------

/**
 * chain.viewAccessKey(accountId, publicKey) -> { nonce, permission, block_height } | null (key missing)
 * chain.relay(signedDelegate) -> RPC tx result (FinalExecutionOutcome-like)
 */
export function createRelayer({
  contractId, tokenId, relayerId, chain,
  maxTtlBlocks = 600, rateLimit = 10, rateWindowMs = 10 * 60_000,
  spendCapYocto = 5n * 10n ** 24n, gasPriceYocto = 200_000_000n, now = () => Date.now(),
}) {
  const recent = new Map(); // sender -> timestamps of accepted relays
  const seen = new Map(); // `${sender}|${pk}|${nonce}` -> expiry ms
  let spent = 0n; let relayed = 0;
  const estimateCost = ({ totalGas, totalDeposit }) => (totalGas + OVERHEAD_GAS) * gasPriceYocto + totalDeposit;
  const window = (sender, t) => (recent.get(sender) ?? []).filter((x) => x > t - rateWindowMs);

  async function relay(base64) {
    if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > MAX_BODY) throw malformed('SIGNED_DELEGATE_BASE64');
    const d = decodeSignedDelegate(new Uint8Array(Buffer.from(base64, 'base64')));
    const totals = validateDelegate(d, { contractId, tokenId, relayerId });
    if (!verifyDelegateSignature(d.signedDelegate)) throw reject('BAD_SIGNATURE');
    const cost = estimateCost(totals);
    const t0 = now();
    if (window(d.senderId, t0).length >= rateLimit) throw new RelayError(429, 'RATE_LIMITED', `${rateLimit} per ${rateWindowMs / 1000}s`);
    if (spent + cost > spendCapYocto) throw new RelayError(503, 'SPEND_CAP_REACHED');

    let key;
    try { key = await chain.viewAccessKey(d.senderId, d.publicKey); } catch (e) { throw new RelayError(502, 'NEAR_RPC_ERROR', String(e?.message ?? e).slice(0, 200)); }
    checkAccessKey(key, d);
    const height = BigInt(key.block_height);
    if (d.maxBlockHeight <= height) throw reject('DELEGATE_EXPIRED', `max_block_height ${d.maxBlockHeight} <= ${height}`);
    if (d.maxBlockHeight > height + BigInt(maxTtlBlocks)) throw reject('DELEGATE_TTL_TOO_LONG', `max ${maxTtlBlocks} blocks ahead`);

    // Re-check and reserve synchronously: no await between here and the send, so concurrent requests
    // cannot both pass the rate limit, the spend cap or the replay check.
    const t = now();
    for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
    const id = `${d.senderId}|${d.publicKey}|${d.nonce}`;
    if (seen.has(id)) throw new RelayError(409, 'DUPLICATE_DELEGATE');
    const w = window(d.senderId, t);
    if (w.length >= rateLimit) throw new RelayError(429, 'RATE_LIMITED', `${rateLimit} per ${rateWindowMs / 1000}s`);
    if (spent + cost > spendCapYocto) throw new RelayError(503, 'SPEND_CAP_REACHED');
    recent.set(d.senderId, [...w, t]);
    seen.set(id, t + rateWindowMs + 60 * 60_000);
    // Reserved as an upper bound and never released: a send that errors may still have landed.
    spent += cost;

    let res;
    try { res = await chain.relay(d.signedDelegate); } catch (e) { throw new RelayError(502, 'RELAY_SUBMIT_FAILED', String(e?.message ?? e).slice(0, 200)); }
    const txHash = res?.transaction_outcome?.id;
    if (typeof txHash !== 'string') throw new RelayError(502, 'RELAY_NO_TX_HASH');
    relayed++;
    const failures = receiptFailures(res);
    return { txHash, status: failures.length ? 'failure' : 'success', ...(failures.length ? { failures: failures.map((f) => JSON.stringify(f).slice(0, 300)) } : {}) };
  }

  function health() {
    return { ok: spent < spendCapYocto, relayer: relayerId, contract: contractId, token: tokenId, network: 'testnet',
      relayed, spentYocto: spent.toString(), spendCapYocto: spendCapYocto.toString(),
      rateLimit: { max: rateLimit, windowSec: rateWindowMs / 1000 }, maxTtlBlocks };
  }

  return { relay, health };
}

// ---------- HTTP ----------

/** node:http handler: POST /relay { signedDelegate: base64 } -> { txHash, status }; GET /relay/health. */
export function createRelayHandler(relayer, { corsOrigin = '*' } = {}) {
  async function readBody(req) {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RelayError(415, 'CONTENT_TYPE');
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new RelayError(413, 'BODY_TOO_LARGE'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw malformed('BODY_NOT_JSON'); }
  }
  const routes = {
    'POST /relay': async (req) => {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw malformed('BODY');
      return relayer.relay(body.signedDelegate);
    },
    'GET /relay/health': async () => relayer.health(),
  };
  return async function handler(req, res) {
    res.setHeader('access-control-allow-origin', corsOrigin);
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('vary', 'origin');
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        const known = Object.keys(routes).some((k) => k.endsWith(` ${url.pathname}`));
        throw new RelayError(known ? 405 : 404, known ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND');
      }
      return send(200, await route(req, url));
    } catch (e) {
      const h = e instanceof RelayError ? e : new RelayError(500, 'INTERNAL');
      if (h.code === 'INTERNAL') console.error(e);
      return send(h.status, { error: h.code, ...(h.detail !== undefined && h.detail !== null ? { detail: h.detail } : {}) });
    }
  };
}
