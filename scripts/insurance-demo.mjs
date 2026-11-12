// Default path on testnet: short-dated order -> AI attestation -> pool -> partial payment -> insurance
// seeded -> collections agent sends a TEE-written reminder -> collections agent marks default after grace -> cover above the threshold -> Sputnik DAO
// vote -> claims. Writes evidence/insurance-run.json. Takes ~7 minutes (grace is 5 minutes on testnet).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, call, dep, fmt, ftBalance as balance, ftCall, view } from './lib/near.mjs';
import { JUNIOR_INVESTOR, SENIOR_INVESTOR, fundPool, openPool, positionOf } from './lib/flow.mjs';
import { createRun } from './lib/run.mjs';
import { approveByCouncil, proposeApproveCover } from './dao.mjs';

const AMOUNT = 10_000_000n; // 10 USDC receivable
const PAID = 7_000_000n; // the customer pays 7, then goes silent
const SEED = 3_000_000n; // insurance seeded by the owner
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { record, check, execute } = createRun('default + DAO cover', 'evidence/insurance-run.json');

/** One collections pass; its evidence is checked by the caller, not its exit code (other pools may fail). */
function collectionsOnce() {
  try {
    execFileSync(process.execPath, ['--env-file-if-exists=.env', 'agent/collections.mjs', '--once'], { cwd: ROOT, stdio: 'inherit' });
  } catch { /* checked by the caller */ }
}
const evidence = (dir, id) => JSON.parse(readFileSync(path.join(ROOT, 'evidence', dir, `${id}.json`), 'utf8'));

/** Before the due date: the collections agent writes a personalised reminder inside the verified TEE. */
function remindViaCollections(orderId, check) {
  collectionsOnce();
  const m = evidence('collections', orderId).message;
  record(`collections agent reminds the customer (${m.source})`, null, { evidence: `evidence/collections/${orderId}.json`, subject: m.subject });
  check('reminder written by the model in a verified TEE', m.source === 'model' && m.privacy?.verified_private === true, true);
}

/** Waits out due date + grace, then lets the collections agent find and default the pool. */
async function defaultViaCollections(poolId, dueNs, graceNs) {
  const waitUntil = Number((dueNs + graceNs) / 1_000_000n) + 15_000;
  console.log(`… waiting ${Math.ceil((waitUntil - Date.now()) / 1000)}s for due date + grace`);
  while (Date.now() < waitUntil) await sleep(5_000);
  collectionsOnce();
  const d = evidence('defaults', poolId);
  record('collections agent marks default', d.tx_hash, { cover: d.cover, needs_dao: d.needs_dao });
}

await execute(async (run) => {
  const cfg = await view(dep.contract, 'get_config');
  const due = BigInt(Date.now() + 150_000) * 1_000_000n; // room for the reminder pass before the due date
  const { orderId, poolId, pool } = await openPool(record, { amount: AMOUNT, dueNs: due, prefix: 'DFLT' });
  await fundPool(record, { poolId, pool });
  record(`customer pays only ${fmt(PAID)}`, (await ftCall(dep.customer, PAID, { pay: { order_id: orderId } })).hash);
  record(`owner seeds insurance ${fmt(SEED)}`, (await ftCall(dep.owner, SEED, { seed_insurance: {} })).hash);

  const cover = [BigInt(pool.junior_face) / 2n, BigInt(pool.receivable) / 10n].reduce((a, b) => (a < b ? a : b));
  console.log(`  expected cover ${fmt(cover)} (min of 50% junior face, 10% receivable); DAO threshold ${fmt(cfg.dao_threshold)}`);

  remindViaCollections(orderId, check);
  await defaultViaCollections(poolId, due, BigInt(cfg.grace_ns));
  let p = await view(dep.contract, 'get_pool', { id: poolId });
  check('pool status', p.status, 'Defaulted');
  check('pending cover (waits for DAO)', p.pending_cover, cover);

  const prop = await proposeApproveCover(poolId);
  record(`council proposes approve_cover (proposal ${prop.id})`, prop.tx);
  const votes = await approveByCouncil(prop.id);
  for (const v of votes.votes) record(`${v.member} votes approve`, v.tx);
  check('proposal status', votes.status, 'Approved');
  p = await view(dep.contract, 'get_pool', { id: poolId });
  check('cover paid', p.insurance_paid, cover);
  check('pending cover cleared', p.pending_cover, 0);

  // Waterfall by hand: senior is paid first from the 7 received; junior gets the rest plus the cover.
  const seniorWant = PAID < BigInt(pool.senior_face) ? PAID : BigInt(pool.senior_face);
  const want = { [SENIOR_INVESTOR]: seniorWant, [JUNIOR_INVESTOR]: PAID - seniorWant + cover };
  for (const [label, who] of [['senior holder claims', SENIOR_INVESTOR], ['junior holder claims (includes cover)', JUNIOR_INVESTOR]]) {
    const pos = await positionOf(who, poolId);
    check(`${who} claimable`, pos.claimable, want[who]);
    const before = await balance(who);
    record(label, (await call(who, dep.contract, 'claim', { token_id: pos.token_id })).hash);
    check(`${who} received`, (await balance(who)) - before, pos.claimable);
  }
  Object.assign(run, { order_id: orderId, pool_id: poolId, proposal_id: prop.id });
});
