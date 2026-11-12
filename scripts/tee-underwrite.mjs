// Live: the underwriter scores a fresh order inside a verified NEAR AI TEE, and the on-chain verdict is then
// re-proved from the saved evidence the same way GET /api/agent/verdicts does (agent/verdict-proof.mjs).
//   node --env-file=.env scripts/tee-underwrite.mjs
import { attestWithAgent } from './lib/flow.mjs';
import { call, dep, view } from './lib/near.mjs';
import { createRun } from './lib/run.mjs';
import { verdictVerified } from '../agent/verdict-proof.mjs';

const { record, check, execute } = createRun('underwriter verdict from a verified TEE', 'evidence/tee-underwrite-run.json');

await execute(async (run) => {
  const dueNs = (BigInt(Date.now()) + 30n * 86_400_000n) * 1_000_000n;
  const created = await call(dep.merchant, dep.contract, 'create_order', {
    amount: '25000000', currency: 'USDC', due_date: dueNs.toString(), invoice_no: `INV-TEE-${Date.now()}`, customer_hash: 'sha256:demo-customer',
  });
  const orderId = created.value;
  record('merchant creates order (25 USDC, 30 days)', created.hash, { order_id: orderId });
  record('customer approves receipt', (await call(dep.customer, dep.contract, 'approve_receipt', { id: orderId })).hash);

  const ev = attestWithAgent(orderId);
  record(`agent attests ${ev.verdict} (score ${ev.score}) from a TEE completion`, ev.tx_hash, { evidence: `evidence/attestations/${orderId}.json` });
  const p = ev.tee?.privacy ?? {};
  run.privacy = { model: p.model, verified_private: p.verified_private, nonce_bound: p.nonce_bound, tdx_quote_verified: p.tdx_quote_verified,
    gpu_attested: p.gpu_attested, signature_kind: p.signature_kind, signing_address: p.evidence?.signing_address, not_verified: p.not_verified };
  check('TEE completion verified_private', p.verified_private, true);
  check('TDX quote verified before the prompt was sent', p.tdx_quote_verified, true);

  const order = await view(dep.contract, 'get_order', { id: orderId });
  check('on-chain verdict = evidence verdict', order.verdict, ev.verdict);
  check('offline proof: signature re-checks and is bound to this on-chain verdict', await verdictVerified(ev, order), true);
});
