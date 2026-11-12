// Underwriter agent runner: finds customer-approved orders, underwrites them, and signs
// attest_receipt with a function-call access key. One evidence file per attestation.
//   node agent/run.mjs --once        single pass (demo scripts)
//   node agent/run.mjs [--interval 15] [--tiers]
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Account, JsonRpcProvider } from 'near-api-js';
import { createNearAiClient, merchantTier, underwrite } from './underwriter.mjs';

export const DEFAULT_RPC = 'https://test.rpc.fastnear.com';
export const PAGE = 100; // contract caps get_orders / get_pools at 100 per call
const GAS = 30_000_000_000_000n;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVIDENCE_DIR = path.join(ROOT, 'evidence', 'attestations');

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

/** Per-merchant repayment history from on-chain pools. */
export function historyByMerchant(pools) {
  const h = new Map();
  for (const p of pools) {
    const m = h.get(p.merchant) ?? { repaidPools: 0, defaults: 0 };
    if (p.status === 'Repaid') m.repaidPools++;
    if (p.status === 'Defaulted') m.defaults++;
    h.set(p.merchant, m);
  }
  return h;
}

export const evidencePath = (dir, id) => {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`bad order id ${id}`);
  return path.join(dir, `${id}.json`);
};

async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, file);
}

/**
 * One pass. All I/O is injected:
 *   view(method, args) -> parsed JSON      sign(method, args) -> { txHash }
 *   complete(context) -> { text }          (NEAR AI client from underwriter.mjs)
 */
export async function runOnce({ view, sign, complete, model, contract, agent, evidenceDir = EVIDENCE_DIR,
  nowNs = () => BigInt(Date.now()) * 1_000_000n, log = console.log, pageSize = PAGE, tiers = false }) {
  const summary = { attested: [], skipped: [], failed: [], tiers: [] };
  const orders = await fetchAll(view, 'get_orders', pageSize);
  const history = historyByMerchant(await fetchAll(view, 'get_pools', pageSize));

  for (const order of orders) {
    if (order.status !== 'CustomerApproved') continue;
    try {
      const file = evidencePath(evidenceDir, order.id);
      if (existsSync(file)) { summary.skipped.push(order.id); continue; } // attested, RPC may lag
      const { args, evidence } = await underwrite({ order, history: history.get(order.merchant) ?? {}, complete, nowNs: nowNs() });
      const { txHash } = await sign('attest_receipt', args);
      await writeJsonAtomic(file, { ...evidence, reason_hash: args.reason_hash, model, contract, agent,
        tx_hash: txHash, timestamp: new Date().toISOString() });
      summary.attested.push(order.id);
      log(`order ${order.id}: ${args.verdict} score=${args.score} tx=${txHash}`);
    } catch (e) {
      summary.failed.push({ id: order.id, error: e.message });
      log(`order ${order.id}: FAILED ${e.message}`);
    }
  }

  if (tiers) {
    for (const [merchant, h] of history) {
      try {
        const tier = merchantTier(h);
        if ((await view('get_tier', { merchant })) === tier) continue;
        const { txHash } = await sign('set_merchant_tier', { merchant, tier });
        summary.tiers.push({ merchant, tier, txHash });
        log(`tier ${merchant} -> ${tier} tx=${txHash}`);
      } catch (e) {
        summary.failed.push({ merchant, error: e.message });
        log(`tier ${merchant}: FAILED ${e.message}`);
      }
    }
  }
  return summary;
}

// ---------- real NEAR wiring ----------

export function createView({ rpcUrl, contractId }) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return (method, args) => provider.callFunction({ contractId, method, args });
}

/** Signs as the agent with its function-call key. Throws on on-chain failure (contract panic). */
export function createSigner({ rpcUrl, accountId, privateKey, contractId }) {
  const account = new Account(accountId, new JsonRpcProvider({ url: rpcUrl }), privateKey);
  return async (methodName, args) => {
    const r = await account.callFunctionRaw({ contractId, methodName, args, gas: GAS, deposit: 0n });
    return { txHash: r.transaction_outcome.id };
  };
}

export function loadConfig(env = process.env) {
  const need = ['CASHFLOW_CONTRACT', 'AGENT_ACCOUNT', 'AGENT_PRIVATE_KEY', 'NEARAI_API_KEY', 'NEARAI_MODEL'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
  const rpcUrl = env.NEAR_RPC || DEFAULT_RPC;
  const testnetOnly = [env.CASHFLOW_CONTRACT, env.AGENT_ACCOUNT].every((a) => a.endsWith('.testnet'))
    && !/mainnet/i.test(rpcUrl) && (env.NEAR_NETWORK ?? 'testnet') === 'testnet';
  if (!testnetOnly) throw new Error('testnet only: accounts must end in .testnet and NEAR_RPC must not be mainnet');
  return { rpcUrl, contract: env.CASHFLOW_CONTRACT, agent: env.AGENT_ACCOUNT, privateKey: env.AGENT_PRIVATE_KEY,
    apiKey: env.NEARAI_API_KEY, model: env.NEARAI_MODEL, intervalSec: Number(env.AGENT_POLL_SECONDS || 15), maxInferences: Number(env.AGENT_MAX_INFERENCES || 200) };
}

async function main(argv) {
  const envFile = path.join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const cfg = loadConfig();
  const once = argv.includes('--once');
  const tiers = argv.includes('--tiers');
  const i = argv.indexOf('--interval');
  const intervalSec = i >= 0 ? Number(argv[i + 1]) : cfg.intervalSec;
  if (!(intervalSec >= 1)) throw new Error('--interval must be >= 1 second');

  const deps = {
    view: createView({ rpcUrl: cfg.rpcUrl, contractId: cfg.contract }),
    sign: createSigner({ rpcUrl: cfg.rpcUrl, accountId: cfg.agent, privateKey: cfg.privateKey, contractId: cfg.contract }),
    complete: createNearAiClient({ apiKey: cfg.apiKey, model: cfg.model, maxCalls: cfg.maxInferences }),
    model: cfg.model, contract: cfg.contract, agent: cfg.agent, tiers,
  };
  console.log(`underwriter agent ${cfg.agent} -> ${cfg.contract} via ${cfg.rpcUrl}${once ? ' (once)' : ` every ${intervalSec}s`}`);
  for (;;) {
    try {
      const s = await runOnce(deps);
      console.log(`pass: attested ${s.attested.length}, skipped ${s.skipped.length}, failed ${s.failed.length}`);
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
