// Default path on testnet: short-dated order -> AI attest -> pool -> partial payment -> insurance seeded
// -> collections agent marks default after grace -> cover above threshold -> Sputnik DAO vote -> claims.
// Writes every tx hash to evidence/insurance-run.json. Takes ~7 minutes (grace is 5 minutes on testnet).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, call as rawCall, dep, explorer, fmt, ftBalance as balance, ftCall as rawFtCall, view } from './lib/near.mjs';
import { approveByCouncil, proposeApproveCover } from './dao.mjs';

const AMOUNT = 10_000_000n; // 10 USDC receivable
const PAID = 7_000_000n; // customer pays 7 before going silent
const SEED = 3_000_000n; // insurance seeded by the owner
const [investor1, investor2] = dep.investors;
const run = { scenario: 'default + DAO cover', contract: dep.contract, dao: dep.dao, started_at: new Date().toISOString(), steps: [], checks: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(name, hash, extra = {}) {
  run.steps.push({ step: name, tx: hash, explorer: explorer(hash), ...extra });
  console.log(`✓ ${name}  ${hash}`);
}
const call = async (name, signer, c, m, a, o) => { const r = await rawCall(signer, c, m, a, o); step(name, r.hash); return r; };
const ftCall = async (name, signer, amount, msg) => { const r = await rawFtCall(signer, amount, msg); step(name, r.hash); return r; };
function check(label, got, want) {
  const ok = String(got) === String(want);
  run.checks.push({ label, got: String(got), want: String(want), ok });
  console.log(`${ok ? '  ok ' : '  FAIL'} ${label}: ${got}${ok ? '' : ` (want ${want})`}`);
  if (!ok) throw new Error(`check failed: ${label}`);
}
const runNode = (args) => execFileSync(process.execPath, ['--env-file-if-exists=.env', ...args], { cwd: ROOT, stdio: 'inherit' });

async function main() {
  const cfg = await view(dep.contract, 'get_config');
  const graceMs = Number(BigInt(cfg.grace_ns) / 1_000_000n);
  const due = BigInt(Date.now() + 90_000) * 1_000_000n;

  const { value: orderId } = await call('1. merchant creates short-dated order', dep.merchant, dep.contract, 'create_order', {
    amount: AMOUNT.toString(), currency: 'USDC', due_date: due.toString(), invoice_no: `DFLT-${Date.now()}`, customer_hash: 'sha256:demo-customer',
  });
  await call('2. customer approves receipt', dep.customer, dep.contract, 'approve_receipt', { id: orderId });
  console.log('… 3. underwriter agent scores the order');
  // Judge by this order's evidence, not the exit code: another runner may have raced on someone else's order.
  try { runNode(['agent/run.mjs', '--once']); } catch { /* checked below */ }
  const ev = JSON.parse(readFileSync(path.join(ROOT, 'evidence/attestations', `${orderId}.json`), 'utf8'));
  step(`3. agent attests ${ev.verdict} (score ${ev.score})`, ev.tx_hash);
  if (ev.verdict !== 'Approve') throw new Error(`underwriter verdict ${ev.verdict}; cannot pool`);

  const { value: poolId } = await call('4. merchant opens pool', dep.merchant, dep.contract, 'create_pool', { order_ids: [orderId] });
  const pool = await view(dep.contract, 'get_pool', { id: poolId });
  await ftCall('5a. senior investor funds', investor1, BigInt(pool.senior_target), { invest: { pool_id: poolId, tranche: 'Senior' } });
  await ftCall('5b. junior investor funds (activates, pays advance)', investor2, BigInt(pool.junior_target), { invest: { pool_id: poolId, tranche: 'Junior' } });
  await ftCall(`6. customer pays only ${fmt(PAID)}`, dep.customer, PAID, { pay: { order_id: orderId } });
  await ftCall(`7. owner seeds insurance ${fmt(SEED)}`, dep.owner, SEED, { seed_insurance: {} });

  const cover = [BigInt(pool.junior_face) / 2n, BigInt(pool.receivable) / 10n].reduce((a, b) => (a < b ? a : b));
  console.log(`  expected cover ${fmt(cover)} (min of 50% junior face, 10% receivable); DAO threshold ${fmt(cfg.dao_threshold)}`);

  const waitUntil = Number(due / 1_000_000n) + graceMs + 15_000;
  console.log(`… waiting ${Math.ceil((waitUntil - Date.now()) / 1000)}s for due date + grace`);
  while (Date.now() < waitUntil) await sleep(5_000);

  console.log('… 8. collections agent checks overdue pools');
  try { runNode(['agent/collections.mjs', '--once']); } catch { /* checked below */ }
  const dflt = JSON.parse(readFileSync(path.join(ROOT, 'evidence/defaults', `${poolId}.json`), 'utf8'));
  step('8. collections agent marks default', dflt.tx_hash ?? dflt.txHash, { cover: dflt.cover, needs_dao: dflt.needs_dao });
  let p = await view(dep.contract, 'get_pool', { id: poolId });
  check('pool status', p.status, 'Defaulted');
  check('pending cover (waits for DAO)', p.pending_cover, cover);

  const prop = await proposeApproveCover(poolId);
  step(`9a. council proposes approve_cover (proposal ${prop.id})`, prop.tx);
  const votes = await approveByCouncil(prop.id);
  for (const v of votes.votes) step(`9b. ${v.member} votes approve`, v.tx);
  check('proposal status', votes.status, 'Approved');
  p = await view(dep.contract, 'get_pool', { id: poolId });
  check('cover paid', p.insurance_paid, cover);
  check('pending cover cleared', p.pending_cover, 0);

  // Waterfall by hand: senior is paid first from the 7 received; junior gets the rest plus the cover.
  const seniorWant = PAID < BigInt(pool.senior_face) ? PAID : BigInt(pool.senior_face);
  const want = { [investor1]: seniorWant, [investor2]: PAID - seniorWant + cover };
  for (const [name, who] of [['10a. senior holder claims', investor1], ['10b. junior holder claims (includes cover)', investor2]]) {
    const pos = (await view(dep.contract, 'get_positions_by_owner', { owner: who })).find((x) => x.pool_id === poolId);
    check(`${who} claimable`, pos.claimable, want[who]);
    const before = await balance(who);
    await call(name, who, dep.contract, 'claim', { token_id: pos.token_id });
    check(`${who} received`, (await balance(who)) - before, pos.claimable);
  }
  run.order_id = orderId;
  run.pool_id = poolId;
  run.proposal_id = prop.id;
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
  run.finished_at = new Date().toISOString();
  mkdirSync(path.join(ROOT, 'evidence'), { recursive: true });
  writeFileSync(path.join(ROOT, 'evidence/insurance-run.json'), JSON.stringify(run, null, 2) + '\n');
  console.log(`evidence/insurance-run.json written (ok=${run.ok})`);
}
