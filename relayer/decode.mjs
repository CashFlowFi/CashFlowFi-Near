// Borsh decode of a NEP-366 SignedDelegate: only what a relayable delegate may contain, nothing else is parsed.
import { createHash } from 'node:crypto';
import { PublicKey, Signature, actions, buildDelegateAction, encodeDelegateAction, encodeSignedDelegate } from 'near-api-js';
import { RelayError, malformed, reject } from './errors.mjs';

const ACTION_NAMES = ['CreateAccount', 'DeployContract', 'FunctionCall', 'Transfer', 'Stake', 'AddKey', 'DeleteKey',
  'DeleteAccount', 'Delegate', 'DeployGlobalContract', 'UseGlobalContract', 'DeterministicStateInit',
  'TransferToGasKey', 'WithdrawFromGasKey'];
const FUNCTION_CALL = 2;
const ED25519 = 0;
const MAX_ACTIONS = 4;
const MAX_ARGS = 2048;

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
