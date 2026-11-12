import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTierReasonWriter } from './tier-reason.mjs';

const change = { merchant: 'm.testnet', oldTier: 'B', newTier: 'D', repaidPools: 8, defaults: 3 };
const chatSaying = (reason, verified = true) => async () => ({ text: JSON.stringify({ reason }), privacy: { verified_private: verified } });

test('a verified reason naming the new tier is used, with its sha256', async () => {
  const reason = 'Three defaults move this merchant to tier D, so new pools advance 60%.';
  const r = await createTierReasonWriter({ chat: chatSaying(reason) })(change);
  assert.deepEqual([r.reason, r.source, r.reason_hash], [reason, 'model', createHash('sha256').update(reason).digest('hex')]);
  // the model's actual wording in the live run (2026-11-12)
  const live = 'Your tier is D because you have 3 defaults, which triggers the rule for 2 or more defaults.';
  assert.equal((await createTierReasonWriter({ chat: chatSaying(live) })(change)).source, 'model');
});

test('a reason for another tier, with a link or too long falls back to the template', async () => {
  for (const [reason, code] of [['Upgraded to tier A for loyalty.', 'TIER_REASON_TIER'], ['Your tier is Diamond now.', 'TIER_REASON_TIER'], ['Now tier D, see https://x.example', 'TIER_REASON_LINK'],
    [`tier D ${'x'.repeat(240)}`, 'TEXT_FIELD']]) {
    const r = await createTierReasonWriter({ chat: chatSaying(reason) })(change);
    assert.deepEqual([r.source, r.model_error, r.reason], ['template', code, 'Moved from tier B to tier D: 8 repaid pools and 3 defaults.'], code);
  }
  assert.equal((await createTierReasonWriter({ chat: chatSaying('tier D', false) })(change)).model_error, 'TEE_NOT_VERIFIED');
});
