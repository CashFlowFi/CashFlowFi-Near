// Static allowlist and access-key checks. Pure: no network, no clock.
//
// Who pays what (nearcore tx_cost): the relayer is the transaction signer, so it pays all gas AND every
// deposit attached inside the delegate. The allowlist therefore caps both.
import { malformed, reject } from './errors.mjs';

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
const MAX_TOTAL_GAS = 300n * TGAS;
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const FT_MSG_KEYS = new Set(['invest', 'pay', 'repay', 'seed_insurance']);

/**
 * Allowlist, checked against the contract methods in contracts/cashflow/src/:
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
export function checkAccessKey(key, d) {
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

/** The delegate must still be valid at the key's block height and expire within `maxTtlBlocks`. */
export function checkBlockHeight(d, blockHeight, maxTtlBlocks) {
  const height = BigInt(blockHeight);
  if (d.maxBlockHeight <= height) throw reject('DELEGATE_EXPIRED', `max_block_height ${d.maxBlockHeight} <= ${height}`);
  if (d.maxBlockHeight > height + BigInt(maxTtlBlocks)) throw reject('DELEGATE_TTL_TOO_LONG', `max ${maxTtlBlocks} blocks ahead`);
}
