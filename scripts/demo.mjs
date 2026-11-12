// Happy path on testnet: order -> approve -> AI attest -> pool -> invest -> advance -> pay -> claims.
// Keys come from ~/.near-credentials/testnet (near-cli legacy keychain); none are printed.
// Writes every tx hash to evidence/demo-run.json.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, TGAS, call as rawCall, dep, explorer, fmt, ftBalance as balance, view } from './lib/near.mjs';

const AMOUNT = BigInt(Math.round(Number(process.env.DEMO_USDC || '10') * 1e6)); // receivable
const [investor1, investor2] = dep.investors;
// DEMO_PAY=tidepool: the customer pays from Arbitrum Sepolia through Tidepool (needs EVM_PRIVATE_KEY).
const VIA_TIDEPOOL = process.env.DEMO_PAY === 'tidepool';
const OUT = VIA_TIDEPOOL ? 'evidence/demo-run-tidepool.json' : 'evidence/demo-run.json';

const run = { network: 'testnet', contract: dep.contract, token: dep.token, started_at: new Date().toISOString(), steps: [] };

async function call(step, signer, contractId, methodName, args, opts) {
  const r = await rawCall(signer, contractId, methodName, args, opts);
  run.steps.push({ step, signer, method: `${contractId}.${methodName}`, tx: r.hash, explorer: explorer(r.hash) });
  console.log(`✓ ${step}  ${r.hash}`);
  return r.value;
}

const ftCall = (step, signer, amount, msg) =>
  call(step, signer, dep.token, 'ft_transfer_call', { receiver_id: dep.contract, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: 1n, gas: 150n * TGAS });

function check(label, got, want) {
  const ok = got === want;
  run.checks = run.checks || [];
  run.checks.push({ label, got: got.toString(), want: want.toString(), ok });
  console.log(`${ok ? '  ok ' : '  FAIL'} ${label}: ${got}${ok ? '' : ` (want ${want})`}`);
  if (!ok) throw new Error(`check failed: ${label}`);
}

async function main() {
  // Preflight: enough USDC to run the scenario.
  const need = { [dep.customer]: AMOUNT, [investor1]: (AMOUNT * 6n) / 10n, [investor2]: (AMOUNT * 2n) / 10n };
  for (const [id, amt] of Object.entries(need)) {
    const b = await balance(id);
    if (b < amt) throw new Error(`${id} has ${fmt(b)}, needs ${fmt(amt)}. Claim from https://app.usetidepool.tech/faucet (NEAR wallet mode).`);
  }

  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const due = nowNs + 30n * 86_400n * 1_000_000_000n;
  const orderId = await call('1. merchant creates order', dep.merchant, dep.contract, 'create_order', {
    amount: AMOUNT.toString(), currency: 'USDC', due_date: due.toString(), invoice_no: `DEMO-${Date.now()}`, customer_hash: 'sha256:demo-customer',
  });
  await call('2. customer approves receipt', dep.customer, dep.contract, 'approve_receipt', { id: orderId });

  console.log('… 3. underwriter agent (NEAR AI) scores the order');
  execFileSync(process.execPath, ['--env-file-if-exists=.env', 'agent/run.mjs', '--once'], { cwd: ROOT, stdio: 'inherit' });
  const ev = JSON.parse(readFileSync(path.join(ROOT, 'evidence/attestations', `${orderId}.json`), 'utf8'));
  run.steps.push({ step: '3. agent attests verdict on-chain', signer: dep.agent, method: `${dep.contract}.attest_receipt`, tx: ev.tx_hash,
    explorer: explorer(ev.tx_hash), verdict: ev.verdict, score: ev.score, model: ev.model });
  console.log(`✓ 3. verdict ${ev.verdict} (score ${ev.score})  ${ev.tx_hash}`);
  if (ev.verdict !== 'Approve') throw new Error(`underwriter did not approve (verdict ${ev.verdict}); cannot pool`);

  const poolId = await call('4. merchant opens pool', dep.merchant, dep.contract, 'create_pool', { order_ids: [orderId] });
  const pool = await view(dep.contract, 'get_pool', { id: poolId });
  console.log(`  terms: advance ${fmt(pool.advance)}, fee ${fmt(pool.fee)}, senior ${fmt(pool.senior_target)}/${fmt(pool.senior_face)}, junior ${fmt(pool.junior_target)}/${fmt(pool.junior_face)}`);

  const merchant0 = await balance(dep.merchant);
  await ftCall('5a. investor funds senior tranche', investor1, BigInt(pool.senior_target), { invest: { pool_id: poolId, tranche: 'Senior' } });
  await ftCall('5b. investor funds junior tranche (activates pool, pays advance)', investor2, BigInt(pool.junior_target), { invest: { pool_id: poolId, tranche: 'Junior' } });
  check('pool status', (await view(dep.contract, 'get_pool', { id: poolId })).status, 'Active');
  check('merchant received advance - fee', (await balance(dep.merchant)) - merchant0, BigInt(pool.advance) - BigInt(pool.fee));

  const merchant1 = await balance(dep.merchant);
  if (VIA_TIDEPOOL) {
    console.log('… 6. customer pays from Arbitrum Sepolia through Tidepool (delivered to the forwarder, forwarded with ft_transfer_call)');
    try {
      execFileSync(process.execPath, ['--env-file-if-exists=.env', 'scripts/tidepool.mjs', 'pay', String(orderId), String(Number(AMOUNT) / 1e6)], { cwd: ROOT, stdio: 'inherit' });
    } catch { /* outcome is read from the evidence below */ }
    const pe = JSON.parse(readFileSync(path.join(ROOT, 'evidence/payments', `${orderId}.json`), 'utf8')).payments.at(-1);
    run.steps.push({ step: '6a. Tidepool delivers to the forwarder (Arbitrum Sepolia -> NEAR)', origin_tx: pe.origin_tx,
      origin_explorer: pe.origin_tx ? `https://sepolia.arbiscan.io/tx/${pe.origin_tx}` : null, deposit_address: pe.deposit_address,
      tx: pe.delivery_tx ?? null, explorer: pe.delivery_tx ? explorer(pe.delivery_tx) : null, amount: pe.delivered_amount ?? null });
    run.steps.push({ step: '6b. forwarder pays the order (ft_transfer_call {"pay"})', signer: dep.forwarder, method: `${dep.token}.ft_transfer_call`,
      tx: pe.forward_tx ?? null, explorer: pe.forward_tx ? explorer(pe.forward_tx) : null, outcome: pe.stage, applied: pe.applied_amount ?? null,
      surplus_to_forwarder: pe.surplus_refunded_to_forwarder ?? null, evidence: pe.evidence, ...(pe.reason ? { reason: pe.reason } : {}) });
    if (pe.stage !== 'delivered') throw new Error(`Tidepool payment outcome ${pe.stage}${pe.reason ? ` (${pe.reason})` : ''}`);
    console.log(`✓ 6. delivered ${pe.delivery_tx}, forwarded ${pe.forward_tx}  (Arbitrum ${pe.origin_tx})`);
    // Exact-input quotes deliver slightly less than sent (route fee). The customer settles the rest on NEAR.
    const o = await view(dep.contract, 'get_order', { id: orderId });
    const rest = BigInt(o.amount) - BigInt(o.paid);
    run.tidepool_delivered = o.paid;
    if (rest > 0n) await ftCall(`6c. customer settles remaining ${fmt(rest)} on NEAR`, dep.customer, rest, { pay: { order_id: orderId } });
  } else {
    await ftCall('6. customer pays invoice (waterfall)', dep.customer, AMOUNT, { pay: { order_id: orderId } });
  }
  check('order status', (await view(dep.contract, 'get_order', { id: orderId })).status, 'Paid');
  const paid = await view(dep.contract, 'get_pool', { id: poolId });
  check('pool status', paid.status, 'Repaid');
  check('senior repaid', BigInt(paid.senior_repaid), BigInt(pool.senior_face));
  check('junior repaid', BigInt(paid.junior_repaid), BigInt(pool.junior_face));
  check('merchant residual', (await balance(dep.merchant)) - merchant1, AMOUNT - BigInt(pool.senior_face) - BigInt(pool.junior_face));

  for (const [label, who] of [['7a. senior holder claims', investor1], ['7b. junior holder claims', investor2]]) {
    const pos = (await view(dep.contract, 'get_positions_by_owner', { owner: who })).find((p) => p.pool_id === poolId);
    const before = await balance(who);
    await call(label, who, dep.contract, 'claim', { token_id: pos.token_id }, { gas: 100n * TGAS });
    check(`${who} claim`, (await balance(who)) - before, BigInt(pos.claimable));
  }

  run.order_id = orderId;
  run.pool_id = poolId;
  run.finished_at = new Date().toISOString();
}

try {
  await main();
  run.ok = true;
} catch (e) {
  run.ok = false;
  run.error = String(e.message || e);
  console.error(`✗ ${run.error}`);
  process.exitCode = 1;
} finally {
  mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
  writeFileSync(path.join(ROOT, OUT), JSON.stringify(run, null, 2) + '\n');
  console.log(`${OUT} written (ok=${run.ok})`);
}
