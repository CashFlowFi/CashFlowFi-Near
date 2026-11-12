// On-chain attacks against the live testnet contract. Each attack signs a forbidden call and
// passes only if the contract panics with the exact guard message. Costs gas only (30 Tgas each).
// Run manually (not part of npm test):  npm run attacks:onchain
// Writes evidence/attacks/onchain.json. Keys come from ~/.near-credentials/testnet and are never printed.
//
// Guard order (contracts/cashflow/src/lib.rs) decides what each attack needs:
//   attest_receipt, set_merchant_tier, ft_on_transfer, approve_cover check the caller first -> any id works.
//   approve_receipt, create_pool look the order up first -> need a real order (one create_order setup tx).
//   claim looks the position up first -> needs a real position (exists only after a pool is funded).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { actions } from 'near-api-js';
import { ROOT, TGAS, account, dep, explorer, view } from '../lib/near.mjs';

const GAS = 30n * TGAS;
const C = dep.contract;
const [alice, bob] = dep.investors;

/** Send one call without throwing on failure; return tx hash, outcome and the contract panic text. */
async function attempt(signer, methodName, args) {
  const res = await account(signer).signAndSendTransaction({
    receiverId: C, actions: [actions.functionCall(methodName, args, GAS, 0n)], waitUntil: 'FINAL', throwOnFailure: false,
  });
  const failures = [res.status?.Failure, ...res.receipts_outcome.map((r) => r.outcome.status.Failure)].filter(Boolean);
  const raw = failures.map((f) => JSON.stringify(f)).join(' ');
  const panic = raw.match(/Smart contract panicked: ((?:[^"\\]|\\.)*)/)?.[1] ?? (raw || null);
  return { hash: res.transaction_outcome.id, failed: failures.length > 0, panic, value: res.status?.SuccessValue };
}

const results = [];
function record(r) {
  results.push(r);
  const mark = r.result === 'blocked' ? 'BLOCKED' : r.result === 'needs pool' ? 'SKIP   ' : 'FAIL   ';
  console.log(`[${mark}] ${r.attack}`);
  console.log(`          expected "${r.expected_error}"  observed ${r.observed_error ? `"${r.observed_error}"` : '-'}${r.tx ? `  ${r.explorer}` : ''}`);
}

async function run(attack, attacker, method, args, expected, defense) {
  const r = await attempt(attacker, method, args);
  record({ attack, attacker, call: `${C}.${method}`, args, defense, expected_error: expected, observed_error: r.panic,
    result: r.failed && r.panic === expected ? 'blocked' : 'NOT BLOCKED', tx: r.hash, explorer: explorer(r.hash) });
}

async function main() {
  const cfg = await view(C, 'get_config');
  if (cfg.paused) throw new Error('contract is paused: every guard after "Paused" would be masked');
  if (cfg.agent_id !== dep.agent || cfg.dao_id !== dep.dao || cfg.token_id !== dep.token) throw new Error('deployments/testnet.json does not match get_config');

  // Setup (legit call): a Pending order owned by the merchant, so order-level guards are reachable.
  const due = (BigInt(Date.now()) + 30n * 86_400_000n) * 1_000_000n;
  const setup = await attempt(dep.merchant, 'create_order', {
    amount: '1000000', currency: 'USDC', due_date: due.toString(), invoice_no: `ATTACK-${Date.now()}`, customer_hash: 'sha256:attack-demo',
  });
  if (setup.failed) throw new Error(`setup create_order failed: ${setup.panic}`);
  const orderId = Number(Buffer.from(setup.value, 'base64').toString());
  console.log(`setup: merchant created Pending order ${orderId}  ${explorer(setup.hash)}\n`);

  await run('Merchant approves its own invoice (fake customer receipt)', dep.merchant, 'approve_receipt', { id: orderId },
    'Merchant cannot approve own order', 'approve_receipt rejects the order\'s merchant as customer');
  await run('Merchant attests its own order as Approve/100 (bypass the AI)', dep.merchant, 'attest_receipt',
    { id: orderId, verdict: 'Approve', score: 100, reason_hash: '0'.repeat(64) },
    'Only the underwriter agent', 'attest_receipt is callable only by agent_id (function-call key)');
  await run('Merchant upgrades its own risk tier to A (better terms)', dep.merchant, 'set_merchant_tier',
    { merchant: dep.merchant, tier: 'A' }, 'Only the underwriter agent', 'set_merchant_tier is callable only by agent_id');
  await run('Merchant pools an order the underwriter never approved', dep.merchant, 'create_pool', { order_ids: [orderId] },
    'Order not approved by underwriter', 'create_pool requires status Attested and verdict Approve');
  await run('Spoofed deposit: call ft_on_transfer directly with fake 1M USDC', alice, 'ft_on_transfer',
    { sender_id: alice, amount: '1000000000000', msg: JSON.stringify({ seed_insurance: {} }) },
    'Only the configured USDC token', 'ft_on_transfer accepts only predecessor == token_id');
  await run('Non-DAO account releases insurance cover', alice, 'approve_cover', { pool_id: 1 },
    'Only the DAO', 'approve_cover is callable only by dao_id (checked before the pool lookup)');

  // claim: the intended guard is behind "Position not found", so it needs a real position.
  const [tok] = await view(C, 'nft_tokens', { from_index: '0', limit: 1 });
  if (!tok) {
    record({ attack: 'Non-owner claims someone else\'s position payout', attacker: bob, call: `${C}.claim`,
      defense: 'claim pays only the current NFT owner', expected_error: 'Only the position owner can claim', observed_error: null,
      result: 'needs pool', note: 'No position NFT exists yet; a fake token_id would hit "Position not found" first. Re-run after demo.mjs funds a pool.' });
  } else {
    const thief = tok.owner_id === bob ? alice : bob;
    await run('Non-owner claims someone else\'s position payout', thief, 'claim', { token_id: tok.token_id },
      'Only the position owner can claim', 'claim pays only the current NFT owner');
  }
  return orderId;
}

const out = { network: 'testnet', contract: C, started_at: new Date().toISOString(), results };
try {
  out.setup_order_id = await main();
  out.ok = results.every((r) => r.result !== 'NOT BLOCKED');
} catch (e) {
  out.ok = false;
  out.error = String(e.message || e);
  console.error(`error: ${out.error}`);
} finally {
  mkdirSync(path.join(ROOT, 'evidence/attacks'), { recursive: true });
  writeFileSync(path.join(ROOT, 'evidence/attacks/onchain.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`\nevidence/attacks/onchain.json written (ok=${out.ok})`);
  if (!out.ok) process.exitCode = 1;
}
