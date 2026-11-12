// Tidepool (community testnet of the Intents/1Click flow) for paying a Cashflow Fi invoice from another chain.
// Tidepool testnet accepts customRecipientMsg but delivers with a plain ft_transfer (verified live, order 5),
// so pay quotes deliver to a forwarder account (forwardQuoteRequest) and watcher/forwarder.mjs moves the
// verified delivery into the contract with ft_transfer_call {"pay":{"order_id":N}}.
// Delivery rules: verify the quote signature, never trust provider SUCCESS alone,
// the destination-hash list can mix NEAR and EVM hashes, and executable quotes are never auto-retried.
import { createQuoteSignatureVerifier, stableStringify } from '../lib/quote-signature.mjs';

export const TIDEPOOL = Object.freeze({
  baseUrl: 'https://www.usetidepool.tech',
  publicKey: 'ed25519:U1Mu4u1nHnHmgABpCkfDGXt2FZj8k29UGqhkMAu4iWY',
  verifier: 'verifier.tidepool-sandbox.testnet',
  destinationAsset: 'nep141:usdc.tidepool-sandbox.testnet',
  destinationToken: 'usdc.tidepool-sandbox.testnet',
  origins: Object.freeze({
    'arb-sepolia-usdc': Object.freeze({
      chainId: 421614,
      asset: 'nep141:arb-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet',
      token: '0x38d81431b9f76d9699af7517040d5221d9dea252',
      decimals: 6,
    }),
  }),
});

const verifySignature = createQuoteSignatureVerifier({ publicKey: TIDEPOOL.publicKey });
const fail = (code) => { throw new Error(code); };
const check = (ok, code) => { if (!ok) fail(code); };
const EVM = /^0x[0-9a-fA-F]{40}$/;
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const UINT = /^(0|[1-9][0-9]*)$/;

export function payMessage(orderId) {
  check(Number.isSafeInteger(orderId) && orderId > 0, 'PAY_ORDER_ID');
  return JSON.stringify({ pay: { order_id: orderId } });
}

/**
 * Build a quote request that pays `amount` (6-dp base units) of order `orderId` into `contractId`.
 * EXACT_INPUT: any surplus over the amount owed is refunded by the contract, never lost.
 */
export function payQuoteRequest({ contractId, orderId, amount, refundTo, origin = 'arb-sepolia-usdc', dry = true,
  deadlineSeconds = 1800, now = Math.floor(Date.now() / 1000) }) {
  const o = TIDEPOOL.origins[origin];
  check(o, 'PAY_UNSUPPORTED_ORIGIN');
  check(typeof contractId === 'string' && contractId.length <= 64 && NEAR_ACCOUNT.test(contractId) && contractId.endsWith('.testnet'), 'PAY_CONTRACT');
  check(typeof refundTo === 'string' && EVM.test(refundTo) && !/^0x0{40}$/i.test(refundTo), 'PAY_REFUND_ADDRESS');
  check(typeof amount === 'string' && UINT.test(amount) && BigInt(amount) > 0n, 'PAY_AMOUNT');
  check(typeof dry === 'boolean', 'PAY_DRY');
  check(Number.isSafeInteger(deadlineSeconds) && deadlineSeconds >= 60 && deadlineSeconds <= 86400, 'PAY_DEADLINE');
  return {
    dry, swapType: 'EXACT_INPUT', slippageTolerance: 100,
    originAsset: o.asset, depositType: 'ORIGIN_CHAIN',
    destinationAsset: TIDEPOOL.destinationAsset, amount,
    recipient: contractId, recipientType: 'DESTINATION_CHAIN',
    customRecipientMsg: payMessage(orderId),
    refundTo, refundType: 'ORIGIN_CHAIN',
    deadline: new Date((now + deadlineSeconds) * 1000).toISOString(),
  };
}

/**
 * Build a quote that delivers `amount` of USDC to a NEAR account with a plain transfer (no msg).
 * Used to fund demo accounts from Arbitrum Sepolia instead of the faucet.
 */
export function fundQuoteRequest({ recipient, ...rest }) {
  const req = payQuoteRequest({ contractId: recipient, orderId: 1, ...rest });
  delete req.customRecipientMsg;
  return req;
}

/**
 * Pay quote for the forwarder route: deliver `amount` to `forwarder` with a plain transfer. The order binding
 * lives in our own evidence (evidence/quotes/<depositAddress>.json), never in the request.
 */
export function forwardQuoteRequest({ forwarder, ...rest }) {
  return fundQuoteRequest({ recipient: forwarder, ...rest });
}

/** Validate a provider response against the exact request we sent. Throws a code on any mismatch. */
export function validatePayQuote(response, request, { now = Math.floor(Date.now() / 1000), purpose = 'pay' } = {}) {
  check(['pay', 'fund', 'forward'].includes(purpose), 'PAY_PURPOSE');
  check(stableStringify(response?.quoteRequest) === stableStringify(request), 'PAY_REQUEST_CHANGED');
  check(verifySignature(response).valid, 'PAY_SIGNATURE');
  const routeOk = purpose === 'fund' || purpose === 'forward'
    ? request.customRecipientMsg === undefined
    : typeof request.customRecipientMsg === 'string' && JSON.parse(request.customRecipientMsg).pay;
  check(request.recipientType === 'DESTINATION_CHAIN' && request.destinationAsset === TIDEPOOL.destinationAsset && routeOk, 'PAY_ROUTE');
  const generated = Date.parse(response.timestamp) / 1000;
  const expires = Date.parse(request.deadline) / 1000;
  check(Number.isFinite(generated) && generated <= now + 30 && now - generated <= 300 && expires > now, 'PAY_EXPIRED');
  const q = response.quote ?? {};
  const int = (x) => typeof x === 'string' && UINT.test(x);
  check(int(q.amountIn) && q.amountIn === request.amount && int(q.amountOut) && int(q.minAmountOut)
    && BigInt(q.amountOut) >= BigInt(q.minAmountOut) && BigInt(q.minAmountOut) * 100n >= BigInt(request.amount) * 98n, 'PAY_QUOTE_AMOUNT');
  if (!request.dry) {
    check(typeof q.depositAddress === 'string' && EVM.test(q.depositAddress) && !/^0x0{40}$/i.test(q.depositAddress), 'PAY_DEPOSIT_ADDRESS');
    check(Date.parse(q.deadline) > now * 1000 && Date.parse(q.deadline) <= Date.parse(request.deadline), 'PAY_DEPOSIT_DEADLINE');
  }
  return {
    signatureVerified: true, testnetOnly: true, official1Click: false,
    depositAddress: q.depositAddress ?? null, amountIn: q.amountIn, minAmountOut: q.minAmountOut,
    // Not signed on dry quotes: display only, never accounting.
    unsignedFees: { refundFee: q.refundFee ?? null, appFees: response.quoteRequest?.appFees ?? null },
  };
}

export async function fetchPayQuote(request, { fetchImpl = fetch, allowExecution = false, purpose = 'pay' } = {}) {
  check(request.dry === true || allowExecution === true, 'PAY_EXECUTION_DISABLED');
  const r = await fetchImpl(`${TIDEPOOL.baseUrl}/v0/quote`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  check(r.ok, 'PAY_PROVIDER_UNAVAILABLE');
  const text = await r.text();
  check(text.length <= 1_000_000, 'PAY_RESPONSE_SIZE');
  const response = JSON.parse(text);
  return { response, ...validatePayQuote(response, request, { purpose }) };
}

export const TERMINAL = Object.freeze(['SUCCESS', 'REFUNDED', 'FAILED']);

export async function fetchStatus(depositAddress, { fetchImpl = fetch } = {}) {
  check(EVM.test(depositAddress ?? ''), 'PAY_DEPOSIT_ADDRESS');
  const r = await fetchImpl(`${TIDEPOOL.baseUrl}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    { redirect: 'error', signal: AbortSignal.timeout(15000) });
  check(r.ok, 'PAY_STATUS_UNAVAILABLE');
  return r.json();
}

/** NEAR transaction hashes are base58 (32 bytes); EVM ones are 0x-hex. The provider list mixes both. */
export function nearDestinationHashes(status) {
  const list = status?.swapDetails?.destinationChainTxHashes ?? [];
  return list.map((x) => (typeof x === 'string' ? x : x?.hash))
    .filter((h) => typeof h === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(h));
}

/**
 * Decide the payment outcome from provider status plus our own NEAR receipt check.
 * `nearReceipt` = { found, success, receiverId, predecessorId, method, args, logs } read from NEAR RPC
 * (EXPERIMENTAL_tx_status) for the destination hash. Provider SUCCESS without our receipt stays "pending".
 */
export function classifyPayment({ status, request, nearReceipt }) {
  const s = status?.status;
  if (!s || !TERMINAL.includes(s)) return { outcome: 'pending', evidence: 'provider-claim-only' };
  if (s === 'REFUNDED') return { outcome: 'refunded', evidence: 'provider-claim-only', refundReason: status.refundReason ?? null };
  if (s === 'FAILED') return { outcome: 'failed', evidence: 'provider-claim-only' };
  if (!nearReceipt?.found) return { outcome: 'pending', evidence: 'provider-claim-only' };
  const msg = request.customRecipientMsg;
  const applied = (nearReceipt.logs ?? []).some((l) => l.startsWith('EVENT_JSON:') && l.includes('"payment_applied"'));
  const ok = nearReceipt.success === true
    && nearReceipt.receiverId === TIDEPOOL.destinationToken
    && nearReceipt.method === 'ft_transfer_call'
    && nearReceipt.args?.receiver_id === request.recipient
    && nearReceipt.args?.msg === msg
    && applied;
  return ok
    ? { outcome: 'delivered', evidence: 'provider-linked-near-receipt' }
    : { outcome: 'ambiguous', evidence: 'provider-linked-near-receipt', reason: 'NEAR receipt does not match the expected ft_transfer_call' };
}
