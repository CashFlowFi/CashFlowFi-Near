// Position NFTs carry the payout on testnet: a senior position is sold after a partial claim and a
// junior position is sold with its payout still unclaimed. The new holder (carol) collects exactly
// what is left; the old holders are refused. Writes evidence/nft-transfer-run.json.

import { call, dep, fmt, ftBalance as balance, ftCall, view } from './lib/near.mjs';
import { JUNIOR_INVESTOR, SENIOR_INVESTOR, fundPool, openPool, positionOf } from './lib/flow.mjs';
import { createRun } from './lib/run.mjs';

const AMOUNT = 10_000_000n; // 10 USDC receivable; faces follow the merchant tier
const BUYER = dep.buyer ?? 'carol.cashflowfi.testnet';
const { record, check, execute } = createRun('position NFT transfer mid-payout', 'evidence/nft-transfer-run.json');

const transfer = (from, tokenId) => call(from, dep.contract, 'nft_transfer', { receiver_id: BUYER, token_id: tokenId }, { deposit: 1n });

/** A claim by someone who no longer holds the NFT must fail with the contract's owner check. */
async function expectRefusedClaim(who, tokenId) {
  try {
    await call(who, dep.contract, 'claim', { token_id: tokenId });
  } catch (e) {
    check(`${who} refused`, /Only the position owner can claim/.test(String(e.message)), true);
    return;
  }
  throw new Error(`${who} was able to claim ${tokenId} after selling it`);
}

/** Claims as `who` and checks the exact amount received. */
async function claimExactly(who, tokenId, want, label) {
  const before = await balance(who);
  record(label, (await call(who, dep.contract, 'claim', { token_id: tokenId })).hash);
  check(`${who} received`, (await balance(who)) - before, want);
}

await execute(async (run) => {
  const due = (BigInt(Date.now()) + 30n * 86_400_000n) * 1_000_000n;
  const { orderId, poolId, pool } = await openPool(record, { amount: AMOUNT, dueNs: due, prefix: 'NFT' });
  await fundPool(record, { poolId, pool });
  const senior = (await positionOf(SENIOR_INVESTOR, poolId)).token_id;
  const junior = (await positionOf(JUNIOR_INVESTOR, poolId)).token_id;

  const first = BigInt(pool.senior_face) / 2n; // pays half of the senior face, so the senior position is part-repaid
  record(`customer pays ${fmt(first)}`, (await ftCall(dep.customer, first, { pay: { order_id: orderId } })).hash);
  await claimExactly(SENIOR_INVESTOR, senior, first, 'senior holder claims the first payment');
  record(`senior NFT sold to ${BUYER}`, (await transfer(SENIOR_INVESTOR, senior)).hash);

  record('customer pays the rest', (await ftCall(dep.customer, AMOUNT - first, { pay: { order_id: orderId } })).hash);
  await expectRefusedClaim(SENIOR_INVESTOR, senior);
  await claimExactly(BUYER, senior, BigInt(pool.senior_face) - first, 'new holder claims the senior remainder');
  check('senior claimed in total', (await view(dep.contract, 'get_position', { token_id: senior })).claimed, pool.senior_face);

  const juniorBefore = await balance(JUNIOR_INVESTOR);
  record(`junior NFT sold to ${BUYER} with its payout unclaimed`, (await transfer(JUNIOR_INVESTOR, junior)).hash);
  await expectRefusedClaim(JUNIOR_INVESTOR, junior);
  await claimExactly(BUYER, junior, pool.junior_face, 'new holder claims the whole junior payout');
  check('seller of the junior NFT received nothing more', (await balance(JUNIOR_INVESTOR)) - juniorBefore, 0);
  Object.assign(run, { order_id: orderId, pool_id: poolId, senior_token: senior, junior_token: junior });
});
