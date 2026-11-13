# Interface contract (v0.2)

The frontend builds against this file. Everything below is deployed on NEAR testnet. Any change goes through a PR to this file.

- **Amounts** are `string` base units (U128). The token has **6 decimals**, so `"1000000000"` = 1,000 USDC.
- **Timestamps** are `string` nanoseconds (U64).
- **IDs** are numbers (`u64`). Position token IDs are strings.

## Accounts (testnet)

| Name | Account | Notes |
|---|---|---|
| Core contract | `cashflow.cashflowfi.testnet` | Orders, pools, insurance, claims |
| Position NFTs | same as the core contract | NEP-171 is implemented inside `cashflow`, so `nft_*` methods are called on the core contract |
| Token | `usdc.tidepool-sandbox.testnet` | 6 decimals |
| Underwriter agent | `agent.cashflowfi.testnet` | Calls `attest_receipt` / `set_merchant_tier` |
| Insurance DAO | `dao.cashflowfi.testnet` | Sputnik DAO v2.3.1; calls `approve_cover` |
| Payment forwarder | `payments.cashflowfi.testnet` | Receives Tidepool deliveries and pays orders |
| Owner / relayer | `cashflowfi.testnet` | Contract owner; also pays gas for relayed calls |
| Demo users | `merchant.`, `customer.`, `buyer.`, `alice.`, `bob.`, `carol.cashflowfi.testnet` | Used by the scripts and evidence. `buyer.` is the customer in new script runs (clean record); `customer.` paid and defaulted in the earlier runs |

## Enums

```ts
type OrderStatus = "Pending" | "CustomerApproved" | "Attested" | "Rejected" | "Pooled" | "Paid";
type Verdict     = "Approve" | "Flag" | "Reject";
type PoolStatus  = "Funding" | "Active" | "Repaid" | "Defaulted";
type Tranche     = "Senior" | "Junior";
type Tier        = "A" | "B" | "C" | "D";      // LTV 85 / 80 / 70 / 60 %
```

## View methods (no wallet needed)

```ts
get_order({ id }): Order | null
get_orders({ from_index?: number, limit?: number }): Order[]
get_orders_by_merchant({ merchant }): Order[]
get_pool({ id }): Pool | null
get_pools({ from_index?, limit? }): Pool[]
get_position({ token_id }): Position | null
get_positions_by_owner({ owner }): Position[]   // reads owners from the positions contract
get_insurance(): { balance: string, total_paid: string, treasury: string }
get_tier({ merchant }): Tier
get_withdrawable({ account_id }): string        // residual owed to a merchant whose direct transfer failed
get_config(): { token_id, positions_id, agent_id, dao_id, grace_ns: string, dao_threshold: string, paused: boolean }
```

```ts
interface Order {
  id: number; merchant: string; customer: string | null;
  amount: string; currency: string; due_date: string;         // ns
  invoice_no: string; customer_hash: string;
  status: OrderStatus; verdict: Verdict | null; score: number | null; reason_hash: string | null;
  paid: string; pool_id: number | null; created_at: string;
}
interface Pool {
  id: number; merchant: string; order_ids: number[]; tier: Tier;
  receivable: string; advance: string; fee: string; claim: string;
  senior_face: string; junior_face: string; senior_target: string; junior_target: string;
  senior_funded: string; junior_funded: string;
  senior_repaid: string; junior_repaid: string; residual_paid: string;
  insurance_paid: string; insurance_refilled: string; pending_cover: string;
  status: PoolStatus; due_date: string; created_at: string;
}
interface Position {
  token_id: string; pool_id: number; tranche: Tranche;
  amount: string; claimed: string; claimable: string; owner: string;
}
```

## Change methods (wallet; 30 TGas default, 0 deposit unless stated)

| Method | Args | Caller |
|---|---|---|
| `create_order` | `{ amount, currency, due_date, invoice_no, customer_hash }` → `number`. `invoice_no` must match `^[A-Za-z0-9][A-Za-z0-9._/#-]{0,63}$` and `currency` `^[A-Z]{3,5}$`, or the underwriter rejects the order | merchant |
| `approve_receipt` | `{ id }` | customer (not the merchant) |
| `create_pool` | `{ order_ids: number[] }` → `number`. No deposit (the method is not payable) | merchant |
| `claim` | `{ token_id }`. 100 TGas | position owner |
| `nft_transfer` | `{ receiver_id, token_id }`. **1 yoctoNEAR** | position owner (sells or gives the position; future payouts follow the NFT) |
| `retry_advance` | `{ pool_id }`. 300 TGas | anyone, when a full pool is back in `Funding` because the advance transfer failed (e.g. merchant not registered on the token) |
| `withdraw_residual` | `{}`. 300 TGas | merchant, when `get_withdrawable` > 0 |
| `mark_default` | `{ pool_id }` | anyone, after due date + grace |
| `attest_receipt` | `{ id, verdict, score, reason_hash }` | agent only |
| `set_merchant_tier` | `{ merchant, tier }` | agent only |
| `approve_cover` | `{ pool_id }` | DAO only |
| `set_paused`, `override_attestation`, `withdraw_treasury` | see `contracts/cashflow/src` | owner only (admin, not needed by the UI) |

### Money in: always through the token's `ft_transfer_call`

Call on `usdc.tidepool-sandbox.testnet`. Attach **1 yoctoNEAR** and **150 TGas**.

```ts
ft_transfer_call({ receiver_id: CASHFLOW, amount, msg })
```

| Purpose | `msg` (JSON string) |
|---|---|
| Invest | `{"invest":{"pool_id":1,"tranche":"Senior"}}` |
| Pay an invoice | `{"pay":{"order_id":7}}` (also used by Tidepool through `customRecipientMsg`) |
| Merchant repays | `{"repay":{"pool_id":1}}` |
| Seed insurance | `{"seed_insurance":{}}` |

Anything not used (over-funding, over-payment) is **refunded automatically** in the same transaction.

Before the first transfer, the user must be registered on the token: `storage_deposit({ account_id })` with **0.00125 NEAR** attached. Check first with `storage_balance_of`.

## Position NFTs

`nft_token`, `nft_tokens` and `nft_tokens_for_owner` return `metadata.media` as a live SVG card (`data:image/svg+xml;charset=utf-8,...`) built from pool state, and `metadata.extra` as JSON: `{ pool_id, tranche, amount, claimed, claimable, pool_status }`. Render `media` directly; don't cache it, the numbers change as payments arrive.

## Events (NEP-297 logs, `EVENT_JSON:` prefix, standard `cashflow`, version `1.0.0`)

The events are: `order_created`, `receipt_approved`, `receipt_attested`, `pool_created`, `invested`, `pool_activated`, `payment_applied`, `claimed`, `pool_defaulted`, `insurance_cover`, `advance_failed`, `claim_failed`.

Each event's `data` holds the relevant ids and amounts, for example:

```json
{"event":"payment_applied","data":[{"pool_id":1,"order_id":7,"amount":"500000000","senior":"500000000","junior":"0","merchant":"0","insurance_refill":"0"}]}
```

## Off-chain APIs (served by our Node services)

| Endpoint | Returns |
|---|---|
| `POST /api/pay/quote` `{ order_id, origin_asset: "arb-sepolia-usdc", refund_to: "0x…" }` | `{ depositAddress, amountIn, minAmountOut, deadline, dry, order_id }`. `refund_to` is the payer's EVM address. With `dry: true` (server without `TIDEPOOL_LIVE=1`) the quote is a price preview only. Errors: 409 `ORDER_NOT_PAYABLE` / `POOL_NOT_ACTIVE` / `ORDER_ALREADY_PAID` |
| `GET /api/pay/status?depositAddress=` | `{ status, originTx, destinationTx, nearTx, evidence, reason? }`. `status`: `pending` → `forwarding` → `delivered`, or `refunded` / `failed` / `ambiguous`. Poll every 5–10 s |
| `GET /api/agent/verdicts?order_id=` | `{ verdict, score, reasons[], attestation: { verified, model, report_url } }`. `verdict`/`score` come from chain; `reasons` only if they hash to the on-chain `reason_hash`; `verified: true` only when the saved TEE signature re-checks and is bound to this on-chain verdict; `report_url` is the evidence file path in this repo. 404 `NOT_ATTESTED` before the agent has scored the order |
| `GET /api/ledger/payments` | Watcher ledger rows (CSV at `?format=csv`) |
| `POST /api/invest/match` `{ intent, filters }` | Ranked tranche suggestions plus a `privacy` block (below) |

### `POST /api/invest/match`: private pool matching

The investor describes what they want in free text. The server reads open pools from chain (status `Funding` with room left in a tranche) and applies the filters in code. A NEAR AI model running in a TEE then ranks only the tranches that passed the filters. The intent is never stored or logged. The response is a suggestion: investing is still the investor's own `ft_transfer_call` with `msg = invest_msg`.

```ts
// Request. Unknown keys are rejected (400 MATCH_BODY / MATCH_FILTERS).
{ intent: string;                     // 1..280 chars, untrusted data for the model
  filters?: { tranche?: Tranche; max_usdc?: number; max_days?: number; min_tier?: Tier } } // min_tier "B" allows A and B

// Response
{ source: "model" | "fallback";
  model_error: string | null;         // NO_CANDIDATES | MODEL_NOT_CONFIGURED | MODEL_NOT_JSON | MODEL_SHAPE | MODEL_PICK | MODEL_AMOUNT
                                      // | MODEL_REASON | MODEL_NO_VALID_PICKS | TEE_NONCE_NOT_BOUND | TEE_QUOTE_REJECTED | INFERENCE_HTTP_<n> | ...
  dropped: number;                    // model picks removed: unknown pool or tranche, or outside the filters
  candidates: number;                 // tranches that passed the filters
  filters: object;                    // as applied
  suggestions: { rank: number; pool_id: number; tranche: Tranche;
                 amount_usdc: number; amount: string;   // clamped to max_usdc and the tranche's remaining room
                 reason: string; invest_msg: string }[]; // invest_msg = '{"invest":{"pool_id":1,"tranche":"Senior"}}'
  privacy: { model: string | null;
             nonce_bound: boolean;                // the attestation report echoed our fresh 32-byte nonce
             signature_valid: boolean;            // ECDSA (EIP-191) signature over sha256(exact request bytes):sha256(exact response bytes)
             signer_matches_attestation: boolean; // the recovered signer is the attested model signing_address
             signature_kind: "provider_tee" | "gateway" | null;
             gpu_attested: boolean;               // NVIDIA NRAS overall result true for the nonce-bound GPU evidence
             tdx_quote_verified: boolean;         // Intel TDX quote verified (dcap-qvl), not debug, report_data = signer + nonce
             verified_private: boolean;           // nonce_bound && signature_valid && signer_matches_attestation && kind = provider_tee
             intent_stored: false;
             not_verified: string[];              // checks this client does not perform
             evidence?: { nonce, chat_id, attested_signers, tdx_tcb_status, request_sha256, response_sha256,
                          signed_text, signature, signing_address } };
  note: string }
```

- The model sees only public pool facts per tranche (pool id, tier, receivable, advance, face, target, room, days to due, lowest underwriter score of the pool's orders) and the intent.
- If the model is unavailable, the TEE checks fail before the prompt is sent, or its answer fails the strict parse, the response is a **fallback** ranking: underwriter score (high first), then tier, then days to due, then pool id, Senior before Junior, each for as much as the filters and room allow.
- Reproduce from the CLI: `npm run match -- "<intent>" --filters '{"tranche":"Senior"}' [--save]`. The live run is in `evidence/privacy/match-run.json`.

## Gasless relayer (NEP-366)

`relayer/server.mjs` (port 8788). `POST /relay { signedDelegate: base64 }` → `{ txHash, status }`; `GET /relay/health`. Only these calls are relayed: on the core contract `create_order`, `approve_receipt`, `create_pool`, `claim`, `nft_transfer` (1 yocto); on the token `ft_transfer_call` to the core contract with an `invest` / `pay` / `repay` / `seed_insurance` msg. Build the signed delegate with `relayer/client.mjs` (`signDelegate`, `signDelegateFor`, `submitToRelayer`; no Node-only APIs).

## Mock fixture (receivable 1,000 USDC, tier B)

Use these values for mocks and storybook states:

```json
{"receivable":"1000000000","advance":"800000000","fee":"8000000","claim":"850000000",
 "senior_face":"637500000","junior_face":"212500000",
 "senior_target":"600000000","junior_target":"200000000"}
```

Faces are computed in base units, so senior is 637.5 and junior 212.5 USDC. The earlier docs used whole-USDC rounding (637/213); this file is the reference.
