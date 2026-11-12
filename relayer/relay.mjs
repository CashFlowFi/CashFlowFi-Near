// NEP-366 meta-transaction relayer: decode a SignedDelegate, check it against a strict allowlist, then pay
// the gas by wrapping it in a transaction signed by the relayer account.
// Everything external (RPC reads, signing, clock) is injected through `chain` / `now`, so tests never touch
// the network. Node built-ins and near-api-js only.
//
// Modules: decode.mjs (borsh SignedDelegate + signature), policy.mjs (allowlist, key, TTL),
// limits.mjs (rate limit, spend cap, replay guard). This file wires them into the relay flow and HTTP.
import { decodeSignedDelegate, verifyDelegateSignature } from './decode.mjs';
import { RelayError, malformed, reject } from './errors.mjs';
import { createLimits } from './limits.mjs';
import { checkAccessKey, checkBlockHeight, validateDelegate } from './policy.mjs';

export { decodeSignedDelegate, verifyDelegateSignature } from './decode.mjs';
export { RelayError } from './errors.mjs';
export { CONTRACT_METHODS, ONE_YOCTO, TGAS, TOKEN_METHODS, validateDelegate } from './policy.mjs';

const MAX_BODY = 16 * 1024;

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
  const limits = createLimits({ rateLimit, rateWindowMs, spendCapYocto, gasPriceYocto, now });
  let relayed = 0;

  async function relay(base64) {
    if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > MAX_BODY) throw malformed('SIGNED_DELEGATE_BASE64');
    const d = decodeSignedDelegate(new Uint8Array(Buffer.from(base64, 'base64')));
    const totals = validateDelegate(d, { contractId, tokenId, relayerId });
    if (!verifyDelegateSignature(d.signedDelegate)) throw reject('BAD_SIGNATURE');
    const cost = limits.estimateCost(totals);
    limits.precheck(d.senderId, cost);

    let key;
    try { key = await chain.viewAccessKey(d.senderId, d.publicKey); } catch (e) { throw new RelayError(502, 'NEAR_RPC_ERROR', String(e?.message ?? e).slice(0, 200)); }
    checkAccessKey(key, d);
    checkBlockHeight(d, key.block_height, maxTtlBlocks);

    // No await between the reservation and the send (see limits.reserve).
    limits.reserve(d, cost);

    let res;
    try { res = await chain.relay(d.signedDelegate); } catch (e) { throw new RelayError(502, 'RELAY_SUBMIT_FAILED', String(e?.message ?? e).slice(0, 200)); }
    const txHash = res?.transaction_outcome?.id;
    if (typeof txHash !== 'string') throw new RelayError(502, 'RELAY_NO_TX_HASH');
    relayed++;
    const failures = receiptFailures(res);
    return { txHash, status: failures.length ? 'failure' : 'success', ...(failures.length ? { failures: failures.map((f) => JSON.stringify(f).slice(0, 300)) } : {}) };
  }

  function health() {
    const spent = limits.spent();
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
