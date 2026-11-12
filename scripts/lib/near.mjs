// Shared testnet helpers for the CLI scripts. Keys come from the near-cli legacy keychain
// (~/.near-credentials/testnet/<account>.json) and are never printed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, getTransactionLastResult } from 'near-api-js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const dep = JSON.parse(readFileSync(path.join(ROOT, 'deployments/testnet.json'), 'utf8'));
if (!dep.contract.endsWith('.testnet')) throw new Error('testnet only');

export const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
export const provider = new JsonRpcProvider({ url: RPC });
export const TGAS = 1_000_000_000_000n;
export const explorer = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
export const fmt = (u) => `${Number(u) / 1e6} USDC`;

const accounts = {};
export function account(id) {
  if (!accounts[id]) {
    const cred = JSON.parse(readFileSync(path.join(homedir(), '.near-credentials/testnet', `${id}.json`), 'utf8'));
    accounts[id] = new Account(id, provider, cred.private_key);
  }
  return accounts[id];
}

export function receiptFailures(res) {
  return res.receipts_outcome.filter((r) => r.outcome.status.Failure).map((r) => JSON.stringify(r.outcome.status.Failure));
}

export function logs(res) {
  return res.receipts_outcome.flatMap((r) => r.outcome.logs);
}

/** Signs a function call and waits for FINAL. Throws on any failed receipt unless allowed. */
export async function call(signer, contractId, methodName, args, { deposit = 0n, gas = 100n * TGAS, allowReceiptFailure = false } = {}) {
  const res = await account(signer).callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'FINAL' });
  const failures = receiptFailures(res);
  if (failures.length && !allowReceiptFailure) throw new Error(`${contractId}.${methodName}: receipt failed: ${failures.join('; ')}`);
  let value = null;
  try { value = getTransactionLastResult(res); } catch { /* no return value */ }
  return { hash: res.transaction_outcome.id, value, failures, logs: logs(res), res };
}

export const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
export const ftBalance = async (id) => BigInt(await view(dep.token, 'ft_balance_of', { account_id: id }));

/** ft_transfer_call into the cashflow contract (1 yocto, 300 Tgas). */
export const ftCall = (signer, amount, msg) =>
  call(signer, dep.token, 'ft_transfer_call', { receiver_id: dep.contract, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: 1n, gas: 150n * TGAS });
