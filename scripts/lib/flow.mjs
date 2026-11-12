// Shared on-chain flow for the testnet scripts: order -> customer approval -> AI attestation
// -> pool -> both tranches funded. Each step is reported through `record(step, txHash, extra)`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, call, dep, ftCall, view } from './near.mjs';

const [SENIOR_INVESTOR, JUNIOR_INVESTOR] = dep.investors;

/** Runs the underwriter once and returns this order's attestation evidence. */
export function attestWithAgent(orderId) {
  // Judge by this order's evidence, not the exit code: another runner may have failed on a different order.
  try {
    execFileSync(process.execPath, ['--env-file-if-exists=.env', 'agent/run.mjs', '--once'], { cwd: ROOT, stdio: 'inherit' });
  } catch { /* checked below */ }
  return JSON.parse(readFileSync(path.join(ROOT, 'evidence/attestations', `${orderId}.json`), 'utf8'));
}

/** Creates an approved, attested order and opens its pool. Returns { orderId, poolId, pool }. */
export async function openPool(record, { amount, dueNs, prefix = 'INV' }) {
  const created = await call(dep.merchant, dep.contract, 'create_order', {
    amount: amount.toString(), currency: 'USDC', due_date: dueNs.toString(), invoice_no: `${prefix}-${Date.now()}`, customer_hash: 'sha256:demo-customer',
  });
  const orderId = created.value;
  record('merchant creates order', created.hash, { order_id: orderId });
  record('customer approves receipt', (await call(dep.customer, dep.contract, 'approve_receipt', { id: orderId })).hash);

  const ev = attestWithAgent(orderId);
  record(`agent attests ${ev.verdict} (score ${ev.score})`, ev.tx_hash, { verdict: ev.verdict, score: ev.score, model: ev.model });
  if (ev.verdict !== 'Approve') throw new Error(`underwriter verdict ${ev.verdict}; cannot pool`);

  const opened = await call(dep.merchant, dep.contract, 'create_pool', { order_ids: [orderId] });
  record('merchant opens pool', opened.hash, { pool_id: opened.value });
  return { orderId, poolId: opened.value, pool: await view(dep.contract, 'get_pool', { id: opened.value }) };
}

/** Funds senior then junior to their targets; the junior deposit activates the pool and pays the advance. */
export async function fundPool(record, { poolId, pool }) {
  const senior = await ftCall(SENIOR_INVESTOR, BigInt(pool.senior_target), { invest: { pool_id: poolId, tranche: 'Senior' } });
  record('senior investor funds', senior.hash);
  const junior = await ftCall(JUNIOR_INVESTOR, BigInt(pool.junior_target), { invest: { pool_id: poolId, tranche: 'Junior' } });
  record('junior investor funds (activates pool, pays advance)', junior.hash);
}

/** The position a holder has in a pool, or throws. */
export async function positionOf(owner, poolId) {
  const pos = (await view(dep.contract, 'get_positions_by_owner', { owner })).find((p) => p.pool_id === poolId);
  if (!pos) throw new Error(`${owner} holds no position in pool ${poolId}`);
  return pos;
}

export { SENIOR_INVESTOR, JUNIOR_INVESTOR };
