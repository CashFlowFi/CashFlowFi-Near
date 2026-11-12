// Happy path on testnet: order -> approve -> AI attest -> pool -> invest -> advance -> pay -> claims.
// Keys come from ~/.near-credentials/testnet (near-cli legacy keychain); none are printed.
// Writes every tx hash to evidence/demo-run.json.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account, JsonRpcProvider, getTransactionLastResult } from 'near-api-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = JSON.parse(readFileSync(path.join(ROOT, 'deployments/testnet.json'), 'utf8'));
const RPC = process.env.NEAR_RPC || 'https://test.rpc.fastnear.com';
const provider = new JsonRpcProvider({ url: RPC });
const TGAS = 1_000_000_000_000n;
const UNIT = 1_000_000n; // USDC 6 decimals
const AMOUNT = BigInt(Math.round(Number(process.env.DEMO_USDC || '10') * 1e6)); // receivable
const [investor1, investor2] = dep.investors;

if (!dep.contract.endsWith('.testnet')) throw new Error('testnet only');

const accounts = {};
function account(id) {
  if (!accounts[id]) {
    const cred = JSON.parse(readFileSync(path.join(homedir(), '.near-credentials/testnet', `${id}.json`), 'utf8'));
    accounts[id] = new Account(id, provider, cred.private_key);
  }
  return accounts[id];
}

const run = { network: 'testnet', contract: dep.contract, token: dep.token, started_at: new Date().toISOString(), steps: [] };
const fmt = (u) => `${Number(u) / 1e6} USDC`;

function failures(res) {
  return res.receipts_outcome.filter((r) => r.outcome.status.Failure).map((r) => JSON.stringify(r.outcome.status.Failure));
}

async function call(step, signer, contractId, methodName, args, { deposit = 0n, gas = 100n * TGAS, allowReceiptFailure = false } = {}) {
  const res = await account(signer).callFunctionRaw({ contractId, methodName, args, deposit, gas, waitUntil: 'FINAL' });
  const fails = failures(res);
  if (fails.length && !allowReceiptFailure) throw new Error(`${step}: receipt failed: ${fails.join('; ')}`);
  const hash = res.transaction_outcome.id;
  let value = null;
  try { value = getTransactionLastResult(res); } catch { /* no return value */ }
  run.steps.push({ step, signer, method: `${contractId}.${methodName}`, tx: hash, explorer: `https://testnet.nearblocks.io/txns/${hash}` });
  console.log(`✓ ${step}  ${hash}`);
  return value;
}

const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });
const balance = async (id) => BigInt(await view(dep.token, 'ft_balance_of', { account_id: id }));
const ftCall = (step, signer, amount, msg) =>
  call(step, signer, dep.token, 'ft_transfer_call', { receiver_id: dep.contract, amount: amount.toString(), msg: JSON.stringify(msg) }, { deposit: 1n, gas: 300n * TGAS });

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
    explorer: `https://testnet.nearblocks.io/txns/${ev.tx_hash}`, verdict: ev.verdict, score: ev.score, model: ev.model });
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
  await ftCall('6. customer pays invoice (waterfall)', dep.customer, AMOUNT, { pay: { order_id: orderId } });
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
  writeFileSync(path.join(ROOT, 'evidence/demo-run.json'), JSON.stringify(run, null, 2) + '\n');
  console.log(`evidence/demo-run.json written (ok=${run.ok})`);
}
