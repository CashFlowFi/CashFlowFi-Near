import { createHash, createPublicKey, verify } from 'node:crypto';
// Reused from the author's Wavefund project (runtime/intents/signature.mjs); listed as a library in the README.

// 1Click quote-signature verification, re-implemented without new dependencies.
// Source of truth: the official TypeScript SDK `@defuse-protocol/one-click-sdk-typescript@0.1.26`
// (src/quote-signature.ts, ISC licence, NEAR Foundation) and
// https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature.
// Mechanism: message = UTF-8 bytes of base58(sha256(json-stable-stringify({...signedRequest, ...signedQuote, timestamp}))),
// signature = ed25519 over that message by the 1Click manager key.
// The public key below is copied from that SDK release; the public docs page does not publish it (see docs/INTENTS-PROVIDER.md).
export const ONE_CLICK_MANAGER_PUBLIC_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';
const ED25519_PREFIX = 'ed25519:';
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

export function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) { out = BASE58_ALPHABET[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = '1' + out; }
  return out;
}

export function base58Decode(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 128) throw new Error('Invalid base58 length');
  let value = 0n;
  for (const char of text) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) throw new Error('Invalid base58 character');
    value = value * 58n + BigInt(digit);
  }
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value & 0xffn)); value >>= 8n; }
  for (const char of text) { if (char !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

// Equivalent to json-stable-stringify@1.3.0 (the SDK's pinned version) for JSON data: keys sorted by code unit,
// `undefined` object members omitted, no whitespace. Non-JSON values (functions, symbols, cycles) are rejected.
export function stableStringify(value, seen = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value !== 'object') throw new TypeError('Unsupported value in signed payload');
  if (seen.has(value)) throw new TypeError('Cyclic signed payload');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item, seen))).join(',')}]`;
    const members = Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`);
    return `{${members.join(',')}}`;
  } finally { seen.delete(value); }
}

// Field selection mirrors the SDK exactly, including its truthiness rules (e.g. quoteWaitingTimeMs 0 is omitted).
export function signedQuoteRequest(quoteRequest) {
  const r = quoteRequest;
  return {
    dry: r.dry, swapType: r.swapType, slippageTolerance: r.slippageTolerance, originAsset: r.originAsset,
    depositType: r.depositType, destinationAsset: r.destinationAsset, amount: r.amount, refundTo: r.refundTo,
    refundType: r.refundType, recipient: r.recipient, recipientType: r.recipientType, deadline: r.deadline,
    quoteWaitingTimeMs: r.quoteWaitingTimeMs ? r.quoteWaitingTimeMs : undefined,
    referral: r.referral ? r.referral : undefined,
    virtualChainRecipient: r.virtualChainRecipient ? r.virtualChainRecipient : undefined,
    virtualChainRefundRecipient: r.virtualChainRefundRecipient ? r.virtualChainRefundRecipient : undefined,
    customRecipientMsg: r.customRecipientMsg ? r.customRecipientMsg : undefined,
  };
}

export function signedQuote(quote, dry) {
  const q = quote;
  const common = {
    amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn,
    amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut,
  };
  if (dry) return common;
  return {
    ...common,
    depositAddress: q.depositAddress || undefined, depositMemo: q.depositMemo || undefined, deadline: q.deadline || undefined,
    timeWhenInactive: q.timeWhenInactive || undefined, timeEstimate: q.timeEstimate || undefined,
    refundFee: q.refundFee || undefined, withdrawFee: q.withdrawFee || undefined,
  };
}

export function quoteMessage(quoteResponse) {
  const payload = { ...signedQuoteRequest(quoteResponse.quoteRequest), ...signedQuote(quoteResponse.quote, quoteResponse.quoteRequest.dry), timestamp: quoteResponse.timestamp };
  return base58Encode(createHash('sha256').update(stableStringify(payload), 'utf8').digest());
}

function decodeEd25519(value) {
  if (typeof value !== 'string') throw new Error('Missing ed25519 value');
  return base58Decode(value.startsWith(ED25519_PREFIX) ? value.slice(ED25519_PREFIX.length) : value);
}

function ed25519KeyObject(publicKey) {
  const raw = decodeEd25519(publicKey);
  if (raw.length !== 32) throw new Error('ed25519 public key must be 32 bytes');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
}

// Returns a verifier: (quoteResponse) => { valid, scheme, publicKey, message }. It never throws on bad input.
export function createQuoteSignatureVerifier({ publicKey = ONE_CLICK_MANAGER_PUBLIC_KEY } = {}) {
  const key = ed25519KeyObject(publicKey);
  return function verifyQuoteSignature(quoteResponse) {
    const result = { valid: false, scheme: 'ed25519', publicKey, message: null };
    try {
      if (!quoteResponse?.quoteRequest || !quoteResponse?.quote || typeof quoteResponse.timestamp !== 'string') return result;
      const signature = decodeEd25519(quoteResponse.signature);
      if (signature.length !== 64) return result;
      result.message = quoteMessage(quoteResponse);
      result.valid = verify(null, Buffer.from(result.message, 'utf8'), key, Buffer.from(signature));
    } catch { result.valid = false; }
    return result;
  };
}
