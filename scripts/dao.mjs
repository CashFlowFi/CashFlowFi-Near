// Sputnik DAO governance for insurance covers above the auto-cover threshold.
//   node scripts/dao.mjs approve-cover <pool_id>   propose, then every council member votes
//   node scripts/dao.mjs status <proposal_id>
// The proposal executes approve_cover on the cashflow contract once the vote passes,
// so the contract sees the DAO account as the caller.

import { call, dep, explorer, view, TGAS } from './lib/near.mjs';

const COUNCIL = (process.env.DAO_COUNCIL || 'cashflowfi.testnet,alice.cashflowfi.testnet').split(',');

export async function proposeApproveCover(poolId, { proposer = COUNCIL[0] } = {}) {
  const args = Buffer.from(JSON.stringify({ pool_id: poolId })).toString('base64');
  const policy = await view(dep.dao, 'get_policy');
  const r = await call(proposer, dep.dao, 'add_proposal', {
    proposal: {
      description: `Approve insurance cover for Cashflow Fi pool ${poolId}`,
      kind: { FunctionCall: { receiver_id: dep.contract, actions: [{ method_name: 'approve_cover', args, deposit: '0', gas: (50n * TGAS).toString() }] } },
    },
  }, { deposit: BigInt(policy.proposal_bond) });
  return { id: r.value, tx: r.hash };
}

/** Votes approve from each council member until the proposal leaves InProgress. */
export async function approveByCouncil(id) {
  const votes = [];
  for (const member of COUNCIL) {
    const before = await view(dep.dao, 'get_proposal', { id });
    if (before.status !== 'InProgress') break;
    // The final vote executes the proposal; its cross-contract result is checked below.
    const r = await call(member, dep.dao, 'act_proposal', { id, action: 'VoteApprove', proposal: before.kind }, { gas: 200n * TGAS, allowReceiptFailure: true });
    votes.push({ member, tx: r.hash, explorer: explorer(r.hash), failures: r.failures });
  }
  const after = await view(dep.dao, 'get_proposal', { id });
  return { status: after.status, votes };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'approve-cover') {
    const poolId = Number(arg);
    const p = await proposeApproveCover(poolId);
    console.log(`proposal ${p.id}  ${explorer(p.tx)}`);
    const v = await approveByCouncil(p.id);
    for (const x of v.votes) console.log(`vote ${x.member}  ${x.explorer}${x.failures.length ? `  receipt failure: ${x.failures.join('; ')}` : ''}`);
    console.log(`status ${v.status}`);
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await view(dep.dao, 'get_proposal', { id: Number(arg) }), null, 2));
  } else {
    console.error('usage: node scripts/dao.mjs approve-cover <pool_id> | status <proposal_id>');
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
