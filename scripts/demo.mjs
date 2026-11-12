// Happy path on testnet: order -> customer approval -> AI attestation -> pool -> both tranches
// -> advance -> customer payment -> waterfall -> both NFT holders claim. Every amount is checked on-chain.
//   npm run demo                        customer pays on NEAR      -> evidence/demo-run.json
//   DEMO_PAY=tidepool npm run demo      customer pays from Arbitrum Sepolia through Tidepool
//                                       and the forwarder          -> evidence/demo-run-tidepool.json
// Keys come from ~/.near-credentials/testnet (and EVM_PRIVATE_KEY for Tidepool); none are printed.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, call, dep, fmt, ftBalance as balance, ftCall, view } from './lib/near.mjs';
import { JUNIOR_INVESTOR, SENIOR_INVESTOR, fundPool, openPool, positionOf } from './lib/flow.mjs';
import { createRun } from './lib/run.mjs';

const AMOUNT = BigInt(Math.round(Number(process.env.DEMO_USDC || '10') * 1e6));
const VIA_TIDEPOOL = process.env.DEMO_PAY === 'tidepool';
const { record, check, execute } = createRun(VIA_TIDEPOOL ? 'happy path, cross-chain payment' : 'happy path',
  VIA_TIDEPOOL ? 'evidence/demo-run-tidepool.json' : 'evidence/demo-run.json');

async function preflight() {
  const need = { [dep.customer]: AMOUNT, [SENIOR_INVESTOR]: (AMOUNT * 6n) / 10n, [JUNIOR_INVESTOR]: (AMOUNT * 2n) / 10n };
  if (VIA_TIDEPOOL) need[dep.customer] = AMOUNT / 50n; // only the route-fee remainder is paid on NEAR
  for (const [id, amt] of Object.entries(need)) {
    const b = await balance(id);
    if (b < amt) throw new Error(`${id} has ${fmt(b)}, needs ${fmt(amt)}`);
  }
}

/** Arbitrum Sepolia -> Tidepool -> forwarder -> ft_transfer_call {"pay"}; the customer settles the route fee on NEAR. */
async function payViaTidepool(orderId, run) {
  try {
    execFileSync(process.execPath, ['--env-file-if-exists=.env', 'scripts/tidepool.mjs', 'pay', String(orderId), String(Number(AMOUNT) / 1e6)], { cwd: ROOT, stdio: 'inherit' });
  } catch { /* the outcome is read from the evidence below */ }
  const pe = JSON.parse(readFileSync(path.join(ROOT, 'evidence/payments', `${orderId}.json`), 'utf8')).payments.at(-1);
  record('customer deposits on Arbitrum Sepolia', pe.origin_tx, { deposit_address: pe.deposit_address });
  record('Tidepool delivers to the forwarder on NEAR', pe.delivery_tx, { amount: pe.delivered_amount ?? null });
  record('forwarder pays the order (ft_transfer_call {"pay"})', pe.forward_tx, { outcome: pe.stage, applied: pe.applied_amount ?? null });
  if (pe.stage !== 'delivered') throw new Error(`Tidepool payment outcome ${pe.stage}${pe.reason ? ` (${pe.reason})` : ''}`);
  const o = await view(dep.contract, 'get_order', { id: orderId });
  const rest = BigInt(o.amount) - BigInt(o.paid);
  run.tidepool_delivered = o.paid;
  if (rest > 0n) record(`customer settles remaining ${fmt(rest)} on NEAR`, (await ftCall(dep.customer, rest, { pay: { order_id: orderId } })).hash);
}

await execute(async (run) => {
  await preflight();
  const due = (BigInt(Date.now()) + 30n * 86_400_000n) * 1_000_000n;
  const { orderId, poolId, pool } = await openPool(record, { amount: AMOUNT, dueNs: due, prefix: 'DEMO' });
  console.log(`  terms: advance ${fmt(pool.advance)}, fee ${fmt(pool.fee)}, senior ${fmt(pool.senior_target)}/${fmt(pool.senior_face)}, junior ${fmt(pool.junior_target)}/${fmt(pool.junior_face)}`);

  const merchant0 = await balance(dep.merchant);
  await fundPool(record, { poolId, pool });
  check('pool status', (await view(dep.contract, 'get_pool', { id: poolId })).status, 'Active');
  check('merchant received advance - fee', (await balance(dep.merchant)) - merchant0, BigInt(pool.advance) - BigInt(pool.fee));

  const merchant1 = await balance(dep.merchant);
  if (VIA_TIDEPOOL) await payViaTidepool(orderId, run);
  else record('customer pays invoice (waterfall)', (await ftCall(dep.customer, AMOUNT, { pay: { order_id: orderId } })).hash);

  check('order status', (await view(dep.contract, 'get_order', { id: orderId })).status, 'Paid');
  const paid = await view(dep.contract, 'get_pool', { id: poolId });
  check('pool status', paid.status, 'Repaid');
  check('senior repaid', paid.senior_repaid, pool.senior_face);
  check('junior repaid', paid.junior_repaid, pool.junior_face);
  check('merchant residual', (await balance(dep.merchant)) - merchant1, AMOUNT - BigInt(pool.senior_face) - BigInt(pool.junior_face));

  for (const [label, who] of [['senior holder claims', SENIOR_INVESTOR], ['junior holder claims', JUNIOR_INVESTOR]]) {
    const pos = await positionOf(who, poolId);
    const before = await balance(who);
    record(label, (await call(who, dep.contract, 'claim', { token_id: pos.token_id })).hash);
    check(`${who} received`, (await balance(who)) - before, pos.claimable);
  }
  Object.assign(run, { order_id: orderId, pool_id: poolId });
});
