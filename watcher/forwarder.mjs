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

import { mkdir, readdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, actions, baseEncode } from 'near-api-js';
import { ftTransfers, forwardResultFromTx, lookupTx, txStatus, viewCall } from '../api/near.mjs';
import { resolvePrivateKey } from '../agent/near.mjs';
import { TIDEPOOL, fetchStatus, nearDestinationHashes, TERMINAL } from './tidepool.mjs';

const EVM = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const FINAL_STAGES = new Set(['delivered', 'failed', 'refunded', 'held']);
const DAY = 86_400;

const fail = (code) => { throw new Error(code); };
const iso = (s) => new Date(s * 1000).toISOString();
export const payMsg = (orderId) => JSON.stringify({ pay: { order_id: orderId } });
export const deliveryId = (txHash, receiptId) => `${txHash}-${receiptId}`;

/** Normalise a saved quote binding. Throws BINDING_INVALID unless it is a forwarder-route quote for one order. */
export function bindingInfo(binding, { forwarder }) {
  const orderId = binding?.order_id;
  const depositAddress = binding?.depositAddress;
  const minAmountOut = binding?.minAmountOut ?? binding?.response?.quote?.minAmountOut;
  const r = binding?.request;
  const ok = Number.isSafeInteger(orderId) && orderId > 0 && EVM.test(depositAddress ?? '')
    && typeof minAmountOut === 'string' && UINT.test(minAmountOut) && BigInt(minAmountOut) > 0n
    && r?.recipient === forwarder && r.recipientType === 'DESTINATION_CHAIN' && r.destinationAsset === TIDEPOOL.destinationAsset
    && r.customRecipientMsg === undefined;
  if (!ok) fail('BINDING_INVALID');
  return { orderId, depositAddress, deposit: depositAddress.toLowerCase(), minAmountOut, originTx: binding.origin_tx ?? null };
}

/**
 * Find the verifier -> forwarder transfer for this deposit in the provider-linked NEAR txs.
 * `txs` = [{hash, tx}]. `taken(id)` is true when another deposit already claimed that delivery.
 */
export function findDelivery(txs, { forwarder, minAmountOut, taken = () => false, verifier = TIDEPOOL.verifier, tokenId = TIDEPOOL.destinationToken }) {
  let short = null;
  for (const { hash, tx } of txs) {
    for (const t of ftTransfers(tx, tokenId)) {
      if (t.old_owner_id !== verifier || t.new_owner_id !== forwarder) continue;
      const id = deliveryId(hash, t.receiptId);
      if (taken(id)) continue;
      if (BigInt(t.amount) >= BigInt(minAmountOut)) return { status: 'found', delivery: { id, txHash: hash, receiptId: t.receiptId, amount: t.amount } };
      short ??= t.amount;
    }
  }
  return short ? { status: 'short', amount: short } : { status: 'none' };
}

/**
 * deps:
 *   config      { contractId, forwarder, tokenId? }
 *   store       createFileStore(...) or a fake with the same methods
 *   fetchStatus(depositAddress) -> Tidepool status
 *   txStatus(hash, senderId)    -> EXPERIMENTAL_tx_status result; lookupTx(hash, senderId) -> same, or null if unknown
 *   viewOrder(id), ftBalance(accountId) -> string
 *   signForward({ amount, msg }) -> { hash, signedBase64, send() }   (send broadcasts the exact signed tx)
 *   now() -> unix seconds, log(msg)
 * opts.forward=false: read-only assessment (the API uses this); nothing is written or sent.
 * opts.reverify=true: a recorded 'delivered' is re-checked on chain before it is reported.
 */
export async function processDeposit(binding, deps, { forward = true, reverify = false } = {}) {
  const { config, store } = deps;
  const tokenId = config.tokenId ?? TIDEPOOL.destinationToken;
  const b = bindingInfo(binding, config);
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const base = { order_id: b.orderId, deposit_address: b.depositAddress, origin_tx: b.originTx, min_amount_out: b.minAmountOut };

  // 1. Our own claim decides first: a delivery in flight is never re-assessed into a second send.
  const claim = await store.findClaimByDeposit(b.deposit);
  if (claim) {
    if (claim.stage === 'forwarding') return forward ? finalize(claim, deps, now) : { outcome: 'forwarding', record: claim };
    if (claim.stage === 'delivered' && reverify) return reverifyDelivered(claim, deps);
    return { outcome: claim.stage, record: claim };
  }
  const entry = await store.findEntry(b.orderId, b.deposit);
  if (entry && FINAL_STAGES.has(entry.stage)) return { outcome: entry.stage, record: entry };

  // 2. Provider status is a pointer, not proof.
  const st = await deps.fetchStatus(b.depositAddress);
  const providerStatus = st?.status ?? 'unknown';
  const originTx = b.originTx ?? (st?.swapDetails?.originChainTxHashes ?? []).map((x) => (typeof x === 'string' ? x : x?.hash)).find((h) => typeof h === 'string') ?? null;
  const ctx = { ...base, origin_tx: originTx, provider_status: providerStatus };
  const hashes = nearDestinationHashes(st);
  const terminal = async (stage, extra = {}) => {
    const record = { ...ctx, stage, ...extra, updated_at: iso(now) };
    if (forward) await store.upsertEntry(b.orderId, record);
    return { outcome: stage, record };
  };
  if (!TERMINAL.includes(providerStatus)) return { outcome: 'pending', record: { ...ctx, evidence: 'provider-claim-only' } };
  if (providerStatus === 'REFUNDED') return terminal('refunded', { evidence: 'provider-claim-only', refund_reason: st.refundReason ?? null });
  if (providerStatus === 'FAILED') return terminal('failed', { evidence: 'provider-claim-only' });

  // 3. SUCCESS: find the delivery in our own NEAR receipts.
  const txs = [];
  for (const h of hashes) {
    const tx = await deps.txStatus(h, TIDEPOOL.verifier).catch(() => null);
    if (tx) txs.push({ hash: h, tx });
  }
  const taken = await store.claimedDeliveries();
  const found = findDelivery(txs, { forwarder: config.forwarder, minAmountOut: b.minAmountOut, tokenId, taken: (id) => taken.has(id) });
  const pendingNoTx = { outcome: 'pending', record: { ...ctx, destination_hashes: hashes, evidence: 'provider-claim-only' } };
  if (found.status === 'short') return { outcome: 'ambiguous', record: { ...ctx, destination_hashes: hashes, reason: `DELIVERY_BELOW_MIN: ${found.amount} < ${b.minAmountOut}` } };
  if (found.status === 'none') {
    if (txs.length === 0) return pendingNoTx;
    return { outcome: 'ambiguous', record: { ...ctx, destination_hashes: hashes, reason: 'NO_VERIFIER_TO_FORWARDER_TRANSFER' } };
  }
  const d = found.delivery;
  const ready = { ...ctx, delivery_id: d.id, delivery_tx: d.txHash, delivery_receipt: d.receiptId, delivered_amount: d.amount, evidence: 'provider-linked-near-receipt' };
  if (!forward) return { outcome: 'ready', record: ready };

  // 4. Forward. Preconditions that would only waste the transfer are checked first; nothing is claimed if they fail.
  const order = await deps.viewOrder(b.orderId);
  if (order?.status !== 'Pooled') return terminal('held', { ...ready, reason: `ORDER_NOT_PAYABLE: ${order?.status ?? 'missing'}; funds stay with the forwarder` });
  const balance = BigInt(await deps.ftBalance(config.forwarder));
  if (balance < BigInt(d.amount)) return { outcome: 'ambiguous', record: { ...ready, reason: `FORWARDER_BALANCE_LOW: ${balance} < ${d.amount}` } };

  const signed = await deps.signForward({ amount: d.amount, msg: payMsg(b.orderId) });
  const marker = { ...ready, stage: 'forwarding', forward_tx: signed.hash, forward_signed_tx: signed.signedBase64, contract: config.contractId, forwarder: config.forwarder, claimed_at: iso(now) };
  if (!(await store.createClaim(d.id, marker))) return { outcome: 'forwarding', record: { ...ready, reason: 'CLAIMED_BY_ANOTHER_RUN' } };
  await store.upsertEntry(b.orderId, marker);
  deps.log?.(`order ${b.orderId}: forwarding ${d.amount} from delivery ${d.txHash} in ${signed.hash}`);
  try { await signed.send(); } catch (e) {
    // The tx may or may not have executed. The claim stays; finalize looks the hash up.
    marker.broadcast_error = String(e?.message ?? e).slice(0, 300);
    await store.saveClaim(d.id, marker);
  }
  return finalize(marker, deps, now);
}

/** Resolve a 'forwarding' claim from its recorded tx hash only. Unknown hash: stays 'forwarding' for a human. */
async function finalize(claim, deps, now) {
  const { config, store } = deps;
  let tx = null; let lookupError = null;
  try { tx = await deps.lookupTx(claim.forward_tx, config.forwarder); } catch (e) { lookupError = String(e?.message ?? e).slice(0, 200); }
  if (!tx) {
    const reason = `FORWARD_TX_NOT_FOUND: ${claim.forward_tx}${lookupError ? ` (${lookupError})` : ''}. Check the forwarder's tx history and order.paid before any manual resend.`;
    return { outcome: 'forwarding', record: { ...claim, reason } };
  }
  const r = forwardResultFromTx(tx, { contractId: claim.contract ?? config.contractId, tokenId: config.tokenId ?? TIDEPOOL.destinationToken,
    forwarder: config.forwarder, orderId: claim.order_id, amount: claim.delivered_amount });
  const done = {
    ...claim, stage: r.ok ? 'delivered' : 'failed', applied_amount: r.applied, surplus_refunded_to_forwarder: r.refunded,
    events: r.events, ft_on_transfer_receipt: r.onTransferReceiptId ?? null,
    forward_explorer: `https://testnet.nearblocks.io/txns/${claim.forward_tx}`, finished_at: iso(now),
    ...(r.ok ? {} : { reason: `FORWARD_${r.reason}; funds are with the forwarder or the contract, check before acting` }),
  };
  delete done.broadcast_error;
  await store.saveClaim(claim.delivery_id, done);
  await store.upsertEntry(claim.order_id, done);
  if (r.ok) {
    await store.appendLedger({ recorded_at: iso(now), order_id: claim.order_id, amount: r.applied, deposit_address: claim.deposit_address,
      origin_tx: claim.origin_tx ?? null, near_tx: claim.forward_tx, evidence: claim.evidence });
  }
  deps.log?.(`order ${claim.order_id}: ${done.stage} (applied ${r.applied}, surplus back to forwarder ${r.refunded}) ${claim.forward_tx}`);
  return { outcome: done.stage, record: done };
}

async function reverifyDelivered(claim, deps) {
  const { config } = deps;
  const tx = await deps.lookupTx(claim.forward_tx, config.forwarder).catch(() => null);
  const r = tx && forwardResultFromTx(tx, { contractId: claim.contract ?? config.contractId, tokenId: config.tokenId ?? TIDEPOOL.destinationToken,
    forwarder: config.forwarder, orderId: claim.order_id, amount: claim.delivered_amount });
  if (r?.ok) return { outcome: 'delivered', record: claim };
  return { outcome: 'ambiguous', record: { ...claim, reason: tx ? `RECORDED_DELIVERY_NOT_ON_CHAIN: ${r.reason}` : 'FORWARD_TX_UNREADABLE' } };
}

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

// ---- file store: evidence/{quotes,forwards,payments,ledger} ----

export function createFileStore(evidenceDir) {
  const dir = { quotes: path.join(evidenceDir, 'quotes'), forwards: path.join(evidenceDir, 'forwards'), payments: path.join(evidenceDir, 'payments') };
  const ledgerFile = path.join(evidenceDir, 'ledger', 'payments.jsonl');
  const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const listJson = async (d) => {
    let names; try { names = await readdir(d); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const n of names.filter((x) => x.endsWith('.json')).sort()) { try { out.push(JSON.parse(await readFile(path.join(d, n), 'utf8'))); } catch { /* skip partial */ } }
    return out;
  };
  const atomic = async (file, data) => {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
    await rename(tmp, file);
  };
  const claimPath = (id) => {
    const [h, r] = String(id).split('-');
    if (!B58.test(h ?? '') || !B58.test(r ?? '')) fail('DELIVERY_ID');
    return path.join(dir.forwards, `${id}.json`);
  };
  const paymentPath = (orderId) => { if (!Number.isSafeInteger(orderId) || orderId <= 0) fail('ORDER_ID'); return path.join(dir.payments, `${orderId}.json`); };
  async function readPayments(orderId) {
    const f = await readJson(paymentPath(orderId));
    if (f && !Array.isArray(f.payments)) fail(`PAYMENT_EVIDENCE_FORMAT: ${paymentPath(orderId)} is not a forwarder record; move it aside`);
    return f;
  }
  return {
    bindingPath: (addr) => path.join(dir.quotes, `${addr.toLowerCase()}.json`),
    readBinding: (addr) => readJson(path.join(dir.quotes, `${addr.toLowerCase()}.json`)),
    saveBinding: (binding) => atomic(path.join(dir.quotes, `${binding.depositAddress.toLowerCase()}.json`), binding),
    listBindings: () => listJson(dir.quotes),
    getClaim: (id) => readJson(claimPath(id)),
    async findClaimByDeposit(deposit) { return (await listJson(dir.forwards)).find((c) => c.deposit_address?.toLowerCase() === deposit.toLowerCase()) ?? null; },
    async claimedDeliveries() { return new Set((await listJson(dir.forwards)).map((c) => c.delivery_id)); },
    /** Exclusive create: false if this delivery is already claimed (by this or any other process). */
    async createClaim(id, data) {
      const p = claimPath(id);
      await mkdir(path.dirname(p), { recursive: true });
      try { await writeFile(p, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    },
    saveClaim: (id, data) => atomic(claimPath(id), data),
    async findEntry(orderId, deposit) {
      const f = await readPayments(orderId);
      return f?.payments.find((p) => p.deposit_address?.toLowerCase() === deposit.toLowerCase()) ?? null;
    },
    readPayments,
    async upsertEntry(orderId, entry) {
      const f = (await readPayments(orderId)) ?? { order_id: orderId, contract: entry.contract ?? null, forwarder: entry.forwarder ?? null, payments: [] };
      const i = f.payments.findIndex((p) => p.deposit_address?.toLowerCase() === entry.deposit_address.toLowerCase());
      const clean = { ...entry }; delete clean.forward_signed_tx;
      if (i >= 0) f.payments[i] = { ...f.payments[i], ...clean }; else f.payments.push(clean);
      await atomic(paymentPath(orderId), f);
    },
    async readLedger() {
      let text; try { text = await readFile(ledgerFile, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },
    async appendLedger(row) {
      if ((await this.readLedger()).some((r) => r.near_tx === row.near_tx)) return false;
      await mkdir(path.dirname(ledgerFile), { recursive: true });
      await appendFile(ledgerFile, JSON.stringify(row) + '\n');
      return true;
    },
  };
}

// ---- live wiring (NEAR RPC + Tidepool + forwarder key) ----

/** Production deps. The forwarder key comes from FORWARDER_PRIVATE_KEY or ~/.near-credentials; never printed. */
export function createLiveDeps({ contractId, forwarder, rpcUrl, evidenceDir, privateKey = null, log = console.log }) {
  if (![contractId, forwarder].every((a) => typeof a === 'string' && a.endsWith('.testnet')) || /mainnet/i.test(rpcUrl)) fail('testnet only');
  const near = { rpcUrl };
  const provider = new JsonRpcProvider({ url: rpcUrl });
  let account = null;
  const signer = () => (account ??= new Account(forwarder, provider, resolvePrivateKey(forwarder, privateKey)));
  return {
    config: { contractId, forwarder, tokenId: TIDEPOOL.destinationToken },
    store: createFileStore(evidenceDir),
    fetchStatus: (addr) => fetchStatus(addr),
    txStatus: (hash, sender) => txStatus(hash, sender, near),
    lookupTx: (hash, sender) => lookupTx(hash, sender, near),
    viewOrder: (id) => viewCall(contractId, 'get_order', { id }, near),
    ftBalance: (id) => viewCall(TIDEPOOL.destinationToken, 'ft_balance_of', { account_id: id }, near),
    async signForward({ amount, msg }) {
      const signed = await signer().createSignedTransaction({ receiverId: TIDEPOOL.destinationToken,
        actions: [actions.functionCall('ft_transfer_call', { receiver_id: contractId, amount, msg }, 150_000_000_000_000n, 1n)] });
      const hash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
      const send = async () => {
        const res = await provider.sendTransactionUntil(signed, 'FINAL');
        const got = res?.transaction_outcome?.id ?? res?.transaction?.hash;
        if (got !== hash) fail(`FORWARD_HASH_MISMATCH: computed ${hash}, node reported ${got}`);
        return res;
      };
      return { hash, signedBase64: Buffer.from(signed.encode()).toString('base64'), send };
    },
    now: () => Math.floor(Date.now() / 1000),
    log,
  };
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
