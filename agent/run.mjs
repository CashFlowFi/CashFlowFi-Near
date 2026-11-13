// Underwriter agent runner: finds customer-approved orders, underwrites them, and signs
// attest_receipt with a function-call access key. One evidence file per attestation.
//   node agent/run.mjs --once        single pass (demo scripts)
//   node agent/run.mjs [--interval 15] [--tiers]
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createUnderwriterModel, merchantTier, underwrite } from './underwriter.mjs';
import { createAttestedChat } from './tee-quote.mjs';
import { createTierReasonWriter } from './tier-reason.mjs';
import { DEFAULT_RPC, PAGE, fetchAll, evidencePath, writeJsonAtomic, assertTestnet, createView, createSigner } from './near.mjs';

export { DEFAULT_RPC, PAGE, fetchAll, evidencePath, createView, createSigner };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVIDENCE_DIR = path.join(ROOT, 'evidence', 'attestations');
export const TIERS_DIR = path.join(ROOT, 'evidence', 'tiers');

/** Approved, unpaid receivables per merchant (base units): attested Approve or pooled, minus what is paid. */
export function exposureByMerchant(orders) {
  const m = new Map();
  for (const o of orders) {
    const open = (o.status === 'Attested' && o.verdict === 'Approve') || o.status === 'Pooled';
    if (!open) continue;
    m.set(o.merchant, (m.get(o.merchant) ?? 0n) + BigInt(o.amount) - BigInt(o.paid ?? '0'));
  }
  return m;
}

/**
 * Per-customer record from on-chain orders and pools: paid in full (status Paid), defaulted (in a Defaulted pool
 * and not fully paid) and open (pooled, pool still Active or Funding). The order being scored is CustomerApproved,
 * so it never counts toward its own record.
 */
export function historyByCustomer(orders, pools) {
  const poolStatus = new Map(pools.map((p) => [p.id, p.status]));
  const h = new Map();
  for (const o of orders) {
    if (!o.customer) continue;
    const c = h.get(o.customer) ?? { paid: 0, defaults: 0, open: 0 };
    const ps = o.pool_id === null || o.pool_id === undefined ? null : poolStatus.get(o.pool_id);
    if (o.status === 'Paid') c.paid++;
    else if (ps === 'Defaulted') c.defaults++;
    else if (o.status === 'Pooled') c.open++;
    h.set(o.customer, c);
  }
  return h;
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

/**
 * One pass. All I/O is injected:
 *   view(method, args) -> parsed JSON      sign(method, args) -> { txHash }
 *   complete(context) -> { text, tee }     (underwriter.mjs createUnderwriterModel over the attested TEE chat)
 *   writeReason(change) -> { reason, reason_hash, ... }   (tier-reason.mjs; the rules already chose the tier)
 */
export async function runOnce({ view, sign, complete, model, contract, agent, evidenceDir = EVIDENCE_DIR,
  nowNs = () => BigInt(Date.now()) * 1_000_000n, log = console.log, pageSize = PAGE, tiers = false,
  writeReason = createTierReasonWriter({ chat: null }), tiersDir = TIERS_DIR }) {
  const summary = { attested: [], skipped: [], failed: [], tiers: [] };
  const orders = await fetchAll(view, 'get_orders', pageSize);
  const pools = await fetchAll(view, 'get_pools', pageSize);
  const history = historyByMerchant(pools);
  const exposure = exposureByMerchant(orders);
  const customers = historyByCustomer(orders, pools);

  for (const order of orders) {
    if (order.status !== 'CustomerApproved') continue;
    try {
      const file = evidencePath(evidenceDir, order.id);
      if (existsSync(file)) { summary.skipped.push(order.id); continue; } // attested, RPC may lag
      const outstanding = exposure.get(order.merchant) ?? 0n;
      const { args, evidence } = await underwrite({ order, history: { ...(history.get(order.merchant) ?? {}), outstanding,
        customer: customers.get(order.customer) ?? { paid: 0, defaults: 0, open: 0 } }, complete, nowNs: nowNs() });
      const { txHash } = await sign('attest_receipt', args);
      // Count this approval before the next order of the same merchant is scored.
      if (args.verdict === 'Approve') exposure.set(order.merchant, outstanding + BigInt(order.amount));
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
        const oldTier = await view('get_tier', { merchant });
        if (oldTier === tier) continue;
        const why = await writeReason({ merchant, oldTier, newTier: tier, repaidPools: h.repaidPools, defaults: h.defaults });
        const { txHash } = await sign('set_merchant_tier', { merchant, tier });
        await writeJsonAtomic(path.join(tiersDir, `${merchant}.${tier}.json`), { merchant, old_tier: oldTier, new_tier: tier,
          repaid_pools: h.repaidPools, defaults: h.defaults, ...why, model, contract, agent, tx_hash: txHash, timestamp: new Date().toISOString() });
        summary.tiers.push({ merchant, tier, txHash });
        log(`tier ${merchant} ${oldTier} -> ${tier} (${why.source}) tx=${txHash}`);
      } catch (e) {
        summary.failed.push({ merchant, error: e.message });
        log(`tier ${merchant}: FAILED ${e.message}`);
      }
    }
  }
  return summary;
}

export function loadConfig(env = process.env) {
  const need = ['CASHFLOW_CONTRACT', 'AGENT_ACCOUNT', 'AGENT_PRIVATE_KEY', 'NEARAI_API_KEY', 'NEARAI_MODEL'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env: ${missing.join(', ')}`);
  const rpcUrl = env.NEAR_RPC || DEFAULT_RPC;
  assertTestnet({ accounts: [env.CASHFLOW_CONTRACT, env.AGENT_ACCOUNT], rpcUrl, network: env.NEAR_NETWORK ?? 'testnet' });
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

  const chat = createAttestedChat({ apiKey: cfg.apiKey, model: cfg.model });
  const deps = {
    view: createView({ rpcUrl: cfg.rpcUrl, contractId: cfg.contract }),
    sign: createSigner({ rpcUrl: cfg.rpcUrl, accountId: cfg.agent, privateKey: cfg.privateKey, contractId: cfg.contract }),
    complete: createUnderwriterModel({ chat, maxCalls: cfg.maxInferences }),
    writeReason: createTierReasonWriter({ chat }),
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
