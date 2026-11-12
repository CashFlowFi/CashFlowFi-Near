// Live Tidepool transfers from Arbitrum Sepolia into NEAR testnet.
//   node --env-file=.env scripts/tidepool.mjs fund <near_account> <usdc>   plain delivery (funds demo accounts)
//   node --env-file=.env scripts/tidepool.mjs pay <order_id> <usdc>        ft_transfer_call {"pay":{"order_id":N}}
//   node --env-file=.env scripts/tidepool.mjs recheck <evidence.json>      re-verify a saved transfer; sends nothing
//
// Safety rules (from the previous Tidepool integration):
// - the quote signature and every field of our request are verified before any money moves;
// - the signed tx and its hash are written to evidence BEFORE broadcast, and there is never an automatic retry;
// - gas price is the network price with a capped 2x buffer;
// - the deposit is reported to /v0/deposit/submit;
// - provider SUCCESS is only a claim: delivery is confirmed from our own NEAR receipt.
// EVM_PRIVATE_KEY comes from .env and is never printed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia } from 'viem/chains';
import { TIDEPOOL, fetchPayQuote, fetchStatus, fundQuoteRequest, nearDestinationHashes, payQuoteRequest, classifyPayment } from '../watcher/tidepool.mjs';
import { payReceiptFromTx, txStatus } from '../api/near.mjs';
import { ROOT, dep, provider } from './lib/near.mjs';

const ARB_RPC = process.env.ARB_SEPOLIA_RPC || 'https://sepolia-rollup.arbitrum.io/rpc';
const MAX_USDC = 200n * 1_000_000n; // per transfer; this is a demo, not a treasury
const MAX_GAS_PRICE = 2_000_000_000n; // 2 gwei hard cap on Arbitrum Sepolia
const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const origin = TIDEPOOL.origins['arb-sepolia-usdc'];

const emit = (x) => console.log(JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const fail = (m) => { throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function evidencePath(kind, id) {
  const dir = path.join(ROOT, 'evidence', kind === 'pay' ? 'payments' : 'funding');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${id}.json`);
}

const NEAR_RPC_OPTS = { rpcUrl: process.env.NEAR_RPC || undefined };

/** USDC ft_transfer events on the token in this tx (NEP-297 logs). */
function ftTransfers(tx) {
  return (tx.receipts_outcome ?? [])
    .filter((o) => o.outcome.executor_id === TIDEPOOL.destinationToken && o.outcome.status?.SuccessValue !== undefined)
    .flatMap((o) => o.outcome.logs)
    .filter((l) => l.startsWith('EVENT_JSON:'))
    .map((l) => { try { return JSON.parse(l.slice(11)); } catch { return null; } })
    .filter((e) => e?.standard === 'nep141' && e.event === 'ft_transfer')
    .flatMap((e) => e.data);
}

/** Wait for the provider, then confirm delivery from our own NEAR receipt. Never moves money. */
async function settle(record, request) {
  let status;
  for (let i = 0; i < 90; i++) {
    status = await fetchStatus(record.quote.depositAddress).catch(() => null);
    if (status && ['SUCCESS', 'REFUNDED', 'FAILED'].includes(status.status)) break;
    await sleep(10000);
  }
  record.provider_status = status?.status ?? 'unknown';
  record.near_hashes = nearDestinationHashes(status);
  let nearReceipt = { found: false };
  for (const h of record.near_hashes) {
    const tx = await txStatus(h, TIDEPOOL.verifier, NEAR_RPC_OPTS).catch(() => null);
    if (!tx) continue;
    if (record.mode === 'pay') {
      const r = payReceiptFromTx(tx, { contractId: dep.contract, tokenId: TIDEPOOL.destinationToken });
      if (r?.found) { nearReceipt = r; record.near_tx = h; break; }
    } else {
      const t = ftTransfers(tx).find((d) => d.new_owner_id === record.target && d.old_owner_id === TIDEPOOL.verifier);
      if (t) { nearReceipt = { found: true }; record.near_tx = h; record.delivered_amount = t.amount; break; }
    }
  }
  if (record.mode === 'pay') {
    const c = classifyPayment({ status, request, nearReceipt });
    record.outcome = c.outcome; record.evidence = c.evidence;
  } else {
    record.outcome = nearReceipt.found ? 'delivered' : (record.provider_status === 'SUCCESS' ? 'ambiguous' : record.provider_status.toLowerCase());
    record.evidence = nearReceipt.found ? 'provider-linked-near-receipt' : 'provider-claim-only';
  }
  if (record.near_tx) record.near_explorer = `https://testnet.nearblocks.io/txns/${record.near_tx}`;
  record.stage = 'done';
  record.finished_at = new Date().toISOString();
}

function report(record, file) {
  emit({ stage: 'done', outcome: record.outcome, provider: record.provider_status, near_tx: record.near_tx ?? null, evidence: path.relative(ROOT, file) });
  if (record.outcome !== 'delivered') process.exitCode = 1;
}

/** Re-verify a saved transfer from its evidence file. Sends nothing. */
async function recheck(file) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (!record.quote?.depositAddress) fail('not a tidepool evidence file');
  await settle(record, record.request);
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  report(record, file);
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
  if (mode === 'pay') {
    const orderId = Number(target);
    const order = await provider.callFunction({ contractId: dep.contract, method: 'get_order', args: { id: orderId } });
    if (!order || order.status !== 'Pooled') fail(`order ${orderId} is not Pooled (status ${order?.status}); the contract would refund`);
    request = payQuoteRequest({ contractId: dep.contract, orderId, amount: amount.toString(), refundTo: evm.address, dry: false });
    evidenceFile = evidencePath('pay', orderId);
  } else {
    if (!target.endsWith('.testnet')) fail('testnet accounts only');
    request = fundQuoteRequest({ recipient: target, amount: amount.toString(), refundTo: evm.address, dry: false });
    evidenceFile = evidencePath('fund', `${target}-${Date.now()}`);
  }
  if (existsSync(evidenceFile)) fail(`${evidenceFile} exists: a transfer for this target was already attempted. Check it before sending again.`);

  const [eth, bal] = await Promise.all([
    source.getBalance({ address: evm.address }),
    source.readContract({ address: origin.token, abi: erc20, functionName: 'balanceOf', args: [evm.address] }),
  ]);
  if (bal < amount) fail(`EVM wallet has ${bal} base units of USDC, needs ${amount}`);
  if (eth === 0n) fail('EVM wallet has no Arbitrum Sepolia ETH for gas');

  const quote = await fetchPayQuote(request, { allowExecution: true, purpose: mode });
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

  const record = {
    mode, target, network: { origin: 'arbitrum-sepolia', destination: 'near-testnet' },
    request, quote: { depositAddress, amountIn: quote.amountIn, minAmountOut: quote.minAmountOut, signatureVerified: true },
    origin_tx: hash, origin_explorer: `https://sepolia.arbiscan.io/tx/${hash}`, nonce, stage: 'signed', created_at: new Date().toISOString(),
  };
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

  await settle(record, request);
  save();
  report(record, evidenceFile);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
