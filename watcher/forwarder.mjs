// Payment forwarder. Tidepool testnet ignores customRecipientMsg and delivers with a plain ft_transfer, so a pay
// quote delivers USDC to a forwarder account, and this module moves exactly that delivery into the contract:
//
//   1. binding  evidence/quotes/<depositAddress>.json  {order_id, depositAddress, minAmountOut, request}
//               written before any money moves (by the API or scripts/tidepool.mjs)
//   2. verify   provider SUCCESS is only a pointer: the delivery counts only if OUR NEAR receipt shows a
//               nep141 ft_transfer verifier -> forwarder of >= minAmountOut, in a NEAR tx the provider linked
//               to this deposit
//   3. forward  forwarder signs ft_transfer_call(contract, delivered amount, {"pay":{"order_id":N}}).
//               The signed tx's hash is claimed in evidence/forwards/<delivery>.json (exclusive create) BEFORE
//               broadcast, so one delivery is forwarded at most once, across processes and crashes.
//               A claim without a result is resolved only by looking up that exact hash; it is never re-signed.
//   4. result   'delivered' only when the forward tx's contract logs payment_applied for that order.
//               Surplus over the amount owed comes back to the forwarder and is recorded.
//
// Pure logic takes injected deps (tests use fakes). Runnable:
//   node --env-file-if-exists=.env watcher/forwarder.mjs --once | --interval <seconds>
//
// Modules: forwarder/verify.mjs (binding + delivery check), forwarder/store.mjs (evidence files, exclusive claim),
// forwarder/forward.mjs (sign / reserve / broadcast / confirm), forwarder/live.mjs (RPC + key wiring).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindingInfo } from './forwarder/verify.mjs';
import { FINAL_STAGES, processDeposit } from './forwarder/forward.mjs';
import { createLiveDeps } from './forwarder/live.mjs';

export { bindingInfo, deliveryId, findDelivery, payMsg } from './forwarder/verify.mjs';
export { processDeposit } from './forwarder/forward.mjs';
export { createFileStore } from './forwarder/store.mjs';
export { createLiveDeps } from './forwarder/live.mjs';

const DAY = 86_400;
const fail = (code) => { throw new Error(code); };

/** Process every pending binding once. Bindings older than `maxAgeDays` without a claim are skipped. */
export async function runOnce(deps, { maxAgeDays = 3 } = {}) {
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const results = [];
  for (const binding of await deps.store.listBindings()) {
    let info; try { info = bindingInfo(binding, deps.config); } catch { continue; } // other routes / dry / legacy
    const entry = await deps.store.findEntry(info.orderId, info.deposit);
    if (entry && FINAL_STAGES.has(entry.stage)) continue;
    const claim = await deps.store.findClaimByDeposit(info.deposit);
    const saved = Date.parse(binding.saved_at ?? '') / 1000;
    if (!claim && Number.isFinite(saved) && now - saved > maxAgeDays * DAY) continue;
    try {
      const r = await processDeposit(binding, deps);
      results.push({ deposit: info.depositAddress, order_id: info.orderId, outcome: r.outcome, reason: r.record?.reason ?? null });
    } catch (e) {
      results.push({ deposit: info.depositAddress, order_id: info.orderId, outcome: 'error', reason: String(e?.message ?? e).slice(0, 200) });
    }
  }
  return results;
}

async function main(argv) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dep = JSON.parse(await readFile(path.join(ROOT, 'deployments/testnet.json'), 'utf8'));
  const once = argv.includes('--once');
  const i = argv.indexOf('--interval');
  const interval = i >= 0 ? Number(argv[i + 1]) : Number(process.env.FORWARDER_POLL_SECONDS || 15);
  if (!once && !(interval >= 5)) fail('usage: forwarder.mjs --once | --interval <seconds >= 5>');
  const deps = createLiveDeps({
    contractId: process.env.CASHFLOW_CONTRACT || dep.contract,
    forwarder: process.env.FORWARDER_ACCOUNT || dep.forwarder,
    rpcUrl: process.env.NEAR_RPC || 'https://test.rpc.fastnear.com',
    evidenceDir: path.join(ROOT, 'evidence'),
    privateKey: process.env.FORWARDER_PRIVATE_KEY || null,
  });
  console.log(`forwarder ${deps.config.forwarder} -> ${deps.config.contractId}${once ? ' (once)' : ` every ${interval}s`}`);
  for (;;) {
    for (const r of await runOnce(deps)) console.log(JSON.stringify(r));
    if (once) return;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
}
