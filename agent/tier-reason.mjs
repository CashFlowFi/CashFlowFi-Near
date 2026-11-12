// AI-written reason for a merchant tier change. The tier itself comes from underwriter.mjs merchantTier (rules);
// the model only explains it, inside the verified TEE. The reason must name the new tier and contain no link.
// Its sha256 goes into the evidence file next to the set_merchant_tier tx, so a later edit is detectable.
import { createHash } from 'node:crypto';
import { teeText, strictText, onlyLinks } from './tee-text.mjs';

export const SYSTEM_PROMPT = [
  'You explain a merchant credit tier change to the merchant in one or two sentences.',
  'The tier was already decided by fixed rules; do not suggest a different tier. Use only the facts given.',
  'Rules: 2+ defaults -> D, 1 default -> C, 3+ repaid pools and no default -> A, otherwise B. Advance: A 85%, B 80%, C 70%, D 60%.',
  'Answer with JSON only: {"reason": <string, max 240 chars, must state the new tier as "tier <new_tier>">}.',
].join(' ');

export const tierReasonHash = (reason) => createHash('sha256').update(reason).digest('hex');

export function parseTierReason(text, facts) {
  const r = strictText(text, { reason: 240 });
  // "tier D", "tier is D", "tier: D" all name the new tier; a reason that never does is rejected
  if (!new RegExp(`\\btier(\\s+is|:)?\\s+["']?${facts.new_tier}\\b`, 'i').test(r.reason)) throw new Error('TIER_REASON_TIER');
  if (!onlyLinks(r.reason, [])) throw new Error('TIER_REASON_LINK');
  return r;
}

export const templateTierReason = (f) => ({ reason: `Moved from tier ${f.old_tier} to tier ${f.new_tier}: ${f.repaid_pools} repaid pools and ${f.defaults} defaults.` });

/** writeReason({ merchant, oldTier, newTier, repaidPools, defaults }) -> { reason, reason_hash, source, model_error, privacy } */
export const createTierReasonWriter = ({ chat }) => async ({ merchant, oldTier, newTier, repaidPools, defaults }) => {
  const facts = { merchant, old_tier: oldTier, new_tier: newTier, repaid_pools: repaidPools, defaults };
  const r = await teeText({ chat, system: SYSTEM_PROMPT, facts, parse: (t) => parseTierReason(t, facts), fallback: () => templateTierReason(facts), maxTokens: 200 });
  return { ...r, reason_hash: tierReasonHash(r.reason) };
};
