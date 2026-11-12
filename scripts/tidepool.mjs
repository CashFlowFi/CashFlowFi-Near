// Live Tidepool transfers from Arbitrum Sepolia into NEAR testnet.
//   node --env-file=.env scripts/tidepool.mjs fund <near_account> <usdc>   plain delivery (funds demo accounts)
//   node --env-file=.env scripts/tidepool.mjs pay <order_id> <usdc>        deliver to the forwarder, then forward with
//                                                                           ft_transfer_call {"pay":{"order_id":N}}
//   node --env-file=.env scripts/tidepool.mjs recheck <evidence.json>      re-verify a saved fund record or quote
//                                                                           binding; sends nothing
//
// Pay route: Tidepool testnet ignores customRecipientMsg (it delivers with a plain ft_transfer), so the quote delivers
// to the forwarder account and watcher/forwarder.mjs (the same code `npm run forwarder` runs) moves exactly the
// verified delivery into the contract. The quote binding evidence/quotes/<depositAddress>.json is written first.
//
// Safety rules (from the previous Tidepool integration):
// - the quote signature and every field of our request are verified before any money moves;
// - the signed tx and its hash are written to evidence BEFORE broadcast, and there is never an automatic retry;
// - gas price is the network price with a capped 2x buffer;
// - the deposit is reported to /v0/deposit/submit;
// - provider SUCCESS is only a claim: delivery is confirmed from our own NEAR receipt.
// EVM_PRIVATE_KEY comes from .env and is never printed.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { TIDEPOOL, TERMINAL, fetchPayQuote, fetchStatus, forwardQuoteRequest, fundQuoteRequest, nearDestinationHashes } from '../watcher/tidepool.mjs';
import { createLiveDeps, processDeposit } from '../watcher/forwarder.mjs';
import { ftTransfers, txStatus } from '../api/near.mjs';
import { ROOT, RPC, dep, provider } from './lib/near.mjs';

const ARB_RPC = process.env.ARB_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const MAX_USDC = 200n * 1_000_000n; // per transfer; this is a demo, not a treasury
const MAX_GAS_PRICE = 2_000_000_000n; // 2 gwei hard cap on Arbitrum Sepolia
const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const origin = TIDEPOOL.origins['arb-sepolia-usdc'];

const emit = (x) => console.log(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NEAR_RPC_OPTS = { rpcUrl: RPC };
const forwarderDeps = () => createLiveDeps({ contractId: dep.contract, forwarder: dep.forwarder, rpcUrl: RPC,
  evidenceDir: path.join(ROOT, 'evidence'), privateKey: process.env.FORWARDER_PRIVATE_KEY || null, log: (m) => emit({ stage: 'forwarder', msg: m }) });

async function waitProvider(depositAddress) {
  let status = null;
  for (let i = 0; i < 90; i++) {
    status = await fetchStatus(depositAddress).catch(() => null);
    if (status && TERMINAL.includes(status.status)) break;
    await sleep(10000);
  }
  return status;
}

/** Fund mode: wait for the provider, then confirm delivery from our own NEAR receipt. Never moves money. */
async function settleFund(record) {
  const status = await waitProvider(record.quote.depositAddress);
  record.provider_status = status?.status ?? 'unknown';
  record.near_hashes = nearDestinationHashes(status);
  for (const h of record.near_hashes) {
    const tx = await txStatus(h, TIDEPOOL.verifier, NEAR_RPC_OPTS).catch(() => null);
    const t = tx && ftTransfers(tx, TIDEPOOL.destinationToken).find((d) => d.new_owner_id === record.target && d.old_owner_id === TIDEPOOL.verifier);
    if (t) { record.near_tx = h; record.delivered_amount = t.amount; break; }
  }
  record.outcome = record.near_tx ? 'delivered' : (record.provider_status === 'SUCCESS' ? 'ambiguous' : record.provider_status.toLowerCase());
  record.evidence = record.near_tx ? 'provider-linked-near-receipt' : 'provider-claim-only';
  if (record.near_tx) record.near_explorer = `https://testnet.nearblocks.io/txns/${record.near_tx}`;
  record.stage = 'done';
  record.finished_at = new Date().toISOString();
}

/**
 * Pay mode: wait for the provider, then run the forwarder on this one binding until it settles. The forwarder
 * claims the delivery before sending, so this is safe to run while `npm run forwarder` is also running.
 */
async function settlePay(binding, { forward = true } = {}) {
  await waitProvider(binding.depositAddress);
  const deps = forwarderDeps();
  let r;
  for (let i = 0; i < 12; i++) { // the NEAR delivery can trail provider SUCCESS by a few blocks
    r = await processDeposit(binding, deps, { forward, reverify: !forward });
    if (r.outcome !== 'pending') break;
    await sleep(10000);
  }
  return r;
}

function reportPay(r, file) {
  const rec = r.record ?? {};
  emit({ stage: 'done', outcome: r.outcome, provider: rec.provider_status ?? null, delivery_tx: rec.delivery_tx ?? null,
    forward_tx: rec.forward_tx ?? null, applied: rec.applied_amount ?? null, surplus_to_forwarder: rec.surplus_refunded_to_forwarder ?? null,
    reason: rec.reason ?? null, binding: path.relative(ROOT, file) });
  if (r.outcome !== 'delivered') process.exitCode = 1;
}

/** Re-verify a saved fund record or pay binding. Sends nothing. */
async function recheck(file) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.order_id !== undefined) return reportPay(await settlePay(record, { forward: false }), file);
  if (!record.quote?.depositAddress) fail('not a tidepool evidence file');
  await settleFund(record);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  emit({ stage: 'done', outcome: record.outcome, provider: record.provider_status, near_tx: record.near_tx ?? null, evidence: path.relative(ROOT, file) });
  if (record.outcome !== 'delivered') process.exitCode = 1;
}

/** Earlier pay attempts for this order that reached the broadcast step. */
function priorAttempts(orderId) {
  const dir = path.join(ROOT, 'evidence', 'quotes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n))
    .filter((f) => { try { const b = JSON.parse(readFileSync(f, 'utf8')); return b.order_id === orderId && b.origin_tx; } catch { return false; } });
}

async function main() {
  const [mode, target, usdc] = process.argv.slice(2);
  if (mode === 'recheck') return recheck(target);
  if (!['fund', 'pay'].includes(mode) || !target || !usdc) fail('usage: tidepool.mjs fund <near_account> <usdc> | pay <order_id> <usdc>');
  const amount = BigInt(Math.round(Number(usdc) * 1e6));
  if (amount <= 0n || amount > MAX_USDC) fail(`amount must be 0 < x <= ${MAX_USDC / 1_000_000n} USDC`);

  const key = process.env.EVM_PRIVATE_KEY;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key ?? '')) fail('EVM_PRIVATE_KEY missing in .env');
  const evm = privateKeyToAccount(key);
  const source = createPublicClient({ chain: arbitrumSepolia, transport: http(ARB_RPC, { retryCount: 0, timeout: 20000 }) });
  if ((await source.getChainId()) !== 421614) fail('not Arbitrum Sepolia');

  let request;
  let evidenceFile;
  let orderId = null;
  if (mode === 'pay') {
    orderId = Number(target);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) fail('order id must be a positive integer');
    if (!dep.forwarder?.endsWith('.testnet')) fail('deployments/testnet.json has no forwarder');
    const order = await provider.callFunction({ contractId: dep.contract, method: 'get_order', args: { id: orderId } });
    if (!order || order.status !== 'Pooled') fail(`order ${orderId} is not Pooled (status ${order?.status}); the contract would refund`);
    const prior = priorAttempts(orderId);
    if (prior.length) fail(`a payment for order ${orderId} was already sent (${prior.map((f) => path.relative(ROOT, f)).join(', ')}). Check it before sending again.`);
    request = forwardQuoteRequest({ forwarder: dep.forwarder, amount: amount.toString(), refundTo: evm.address, dry: false });
  } else {
    if (!target.endsWith('.testnet')) fail('testnet accounts only');
    request = fundQuoteRequest({ recipient: target, amount: amount.toString(), refundTo: evm.address, dry: false });
    const dir = path.join(ROOT, 'evidence', 'funding');
    mkdirSync(dir, { recursive: true });
    evidenceFile = path.join(dir, `${target}-${Date.now()}.json`);
    if (existsSync(evidenceFile)) fail(`${evidenceFile} exists`);
  }

  const [eth, bal] = await Promise.all([
    source.getBalance({ address: evm.address }),
    source.readContract({ address: origin.token, abi: erc20, functionName: 'balanceOf', args: [evm.address] }),
  ]);
  if (bal < amount) fail(`EVM wallet has ${bal} base units of USDC, needs ${amount}`);
  if (eth === 0n) fail('EVM wallet has no Arbitrum Sepolia ETH for gas');

  const quote = await fetchPayQuote(request, { allowExecution: true, purpose: mode === 'pay' ? 'forward' : 'fund' });
  const depositAddress = quote.depositAddress;
  emit({ stage: 'quote', mode, target, amountIn: quote.amountIn, minAmountOut: quote.minAmountOut, depositAddress, signatureVerified: quote.signatureVerified });

  const data = encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [depositAddress, amount] });
  const sim = await source.simulateContract({ account: evm, address: origin.token, abi: erc20, functionName: 'transfer', args: [depositAddress, amount] });
  if (sim.result !== true) fail('transfer simulation failed');
  const gas = ((await source.estimateGas({ account: evm, to: origin.token, data })) * 13n) / 10n;
  const network = await source.getGasPrice();
  const gasPrice = network * 2n > MAX_GAS_PRICE ? MAX_GAS_PRICE : network * 2n;
  if (gasPrice < network) fail(`network gas price ${network} above cap ${MAX_GAS_PRICE}`);
  if (gas * gasPrice > eth) fail('not enough ETH for gas');

  const wallet = createWalletClient({ account: evm, chain: arbitrumSepolia, transport: http(ARB_RPC, { retryCount: 0 }) });
  const nonce = await source.getTransactionCount({ address: evm.address, blockTag: 'pending' });
  const signed = await wallet.signTransaction({ to: origin.token, data, value: 0n, gas, gasPrice, nonce, type: 'legacy' });
  const hash = keccak256(signed);

  const sent0 = { origin_tx: hash, origin_explorer: `https://sepolia.arbiscan.io/tx/${hash}`, nonce, stage: 'signed' };
  const record = mode === 'pay'
    // The quote binding (same shape the API saves): the forwarder acts only on this file.
    ? { order_id: orderId, depositAddress, amountIn: quote.amountIn, minAmountOut: quote.minAmountOut, request, response: quote.response,
      source: 'cli', saved_at: new Date().toISOString(), network: { origin: 'arbitrum-sepolia', destination: 'near-testnet' }, ...sent0 }
    : { mode, target, network: { origin: 'arbitrum-sepolia', destination: 'near-testnet' },
      request, quote: { depositAddress, amountIn: quote.amountIn, minAmountOut: quote.minAmountOut, signatureVerified: true }, ...sent0, created_at: new Date().toISOString() };
  if (mode === 'pay') {
    evidenceFile = path.join(ROOT, 'evidence', 'quotes', `${depositAddress.toLowerCase()}.json`);
    mkdirSync(path.dirname(evidenceFile), { recursive: true });
    if (existsSync(evidenceFile)) fail(`${evidenceFile} exists`);
  }
  const save = () => writeFileSync(evidenceFile, JSON.stringify(record, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  save(); // durable before broadcast: a crash after this point must be investigated, never blindly resent

  const sent = await source.sendRawTransaction({ serializedTransaction: signed });
  if (sent !== hash) fail('broadcast hash mismatch');
  record.stage = 'broadcast'; save();
  const receipt = await source.waitForTransactionReceipt({ hash, timeout: 180000, pollingInterval: 2000 });
  if (receipt.status !== 'success') { record.stage = 'reverted'; save(); fail('source transfer reverted'); }
  record.stage = 'confirmed'; record.origin_block = receipt.blockNumber; save();
  emit({ stage: 'confirmed', origin_tx: hash });

  const submit = await fetch(`${TIDEPOOL.baseUrl}/v0/deposit/submit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txHash: hash, depositAddress }),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  record.deposit_submit = submit.status; save();

  if (mode === 'pay') return reportPay(await settlePay(record), evidenceFile);
  await settleFund(record);
  save();
  emit({ stage: 'done', outcome: record.outcome, provider: record.provider_status, near_tx: record.near_tx ?? null, evidence: path.relative(ROOT, evidenceFile) });
  if (record.outcome !== 'delivered') process.exitCode = 1;
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
