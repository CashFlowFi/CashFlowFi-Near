// Shared NEAR wiring for the agents (underwriter runner, collections): paginated views, signing,
// testnet guard, key lookup and atomic evidence writes.
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Account, JsonRpcProvider } from 'near-api-js';

export const DEFAULT_RPC = 'https://test.rpc.fastnear.com';
export const PAGE = 100; // contract caps get_orders / get_pools at 100 per call
const GAS = 30_000_000_000_000n;

/** Read every page of a paginated view method. */
export async function fetchAll(view, method, pageSize = PAGE) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const page = await view(method, { from_index: from, limit: pageSize });
    if (!Array.isArray(page)) throw new Error(`${method} returned non-array`);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

/** `<dir>/<id>.json` for a non-negative integer id (order or pool). */
export const evidencePath = (dir, id) => {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`bad id ${id}`);
  return path.join(dir, `${id}.json`);
};

export async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, file);
}

/** Throws unless every account is *.testnet, the RPC is not mainnet and NEAR_NETWORK is testnet. */
export function assertTestnet({ accounts, rpcUrl, network = 'testnet' }) {
  const ok = accounts.every((a) => typeof a === 'string' && a.endsWith('.testnet'))
    && !/mainnet/i.test(rpcUrl) && network === 'testnet';
  if (!ok) throw new Error('testnet only: accounts must end in .testnet and NEAR_RPC must not be mainnet');
}

/**
 * Private key for `accountId`: the env value if set, else the near-cli legacy keychain
 * ~/.near-credentials/testnet/<account>.json. Never logged; errors name the file, not the key.
 */
export function resolvePrivateKey(accountId, envKey, { home = os.homedir() } = {}) {
  if (envKey) return envKey;
  const file = path.join(home, '.near-credentials', 'testnet', `${accountId}.json`);
  let key;
  try { key = JSON.parse(readFileSync(file, 'utf8')).private_key; } catch { key = null; }
  if (typeof key !== 'string' || !key.startsWith('ed25519:')) throw new Error(`no key for ${accountId}: set the env key or provide ${file}`);
  return key;
}

export function createView({ rpcUrl, contractId }) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return (method, args) => provider.callFunction({ contractId, method, args });
}

/**
 * Signs function calls to `contractId`. Throws on on-chain failure (contract panic).
 * Returns the tx hash and the logs emitted by `contractId` itself (not by any other account).
 */
export function createSigner({ rpcUrl, accountId, privateKey, contractId }) {
  const account = new Account(accountId, new JsonRpcProvider({ url: rpcUrl }), privateKey);
  return async (methodName, args) => {
    const r = await account.callFunctionRaw({ contractId, methodName, args, gas: GAS, deposit: 0n });
    const logs = (r.receipts_outcome ?? []).filter((o) => o.outcome?.executor_id === contractId).flatMap((o) => o.outcome.logs ?? []);
    return { txHash: r.transaction_outcome.id, logs };
  };
}
