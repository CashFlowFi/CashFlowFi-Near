# Cashflow Fi

**Merchant receivables financing on NEAR.** A merchant turns customer-confirmed credit sales into upfront cash. Investors fund senior and junior tranches. Customers pay from any chain, and an on-chain waterfall repays investors in order.

> Built for **NEAR HACKATHON** (1–14 Nov 2026). Runs on **NEAR testnet** with test tokens only.

---

## The problem

Small merchants who sell on credit wait 30–90 days to be paid, and their working capital is stuck in unpaid invoices. Invoice financing exists, but it is slow, opaque and closed to most small businesses. On the other side, investors have little access to short-dated, real-economy yield with transparent risk.

## What Cashflow Fi does

1. **The merchant creates an order** for a credit sale.
2. **The customer confirms the sale on-chain** by scanning a QR code. This is gasless, through a meta-transaction relayer.
3. **An AI underwriter agent scores the receivable** (approve / flag / reject, a risk score and its reasons) and writes the verdict on-chain. The verdict comes from NEAR AI Cloud, with TEE attestation verified.
4. **The merchant opens a pool** on approved receivables.
5. **Investors fund the senior tranche** (paid first, lower return) or **the junior tranche** (first loss, higher return), and receive a **NEP-171 position NFT** for each investment.
6. **When the pool fills, the merchant is paid an 80% advance immediately.** It is paid in test USDC, minus a 1% origination fee: half goes to the insurance fund, half to the protocol.
7. **The customer pays the invoice from any supported chain** through Tidepool (a community testnet of the NEAR Intents / 1Click flow). Funds arrive straight in the contract through `ft_transfer_call`.
8. **The waterfall pays senior first, then junior, then the merchant's residual.**
9. **Position NFT holders claim their payouts.** Selling the NFT sells its future cash flow.
10. **If the customer defaults, the insurance fund covers part of the shortfall.** Covers above a threshold need a vote by the protocol's Sputnik DAO.

### Example: an invoice of 1,000 USDC

| | Puts in | Gets back |
|---|---|---|
| Senior investor | 600 | 637 |
| Junior investor | 200 | 213 |
| Merchant | — | 792 upfront + 150 residual after the customer pays 1,000 |
| Insurance fund / protocol | — | 4 / 4 (from the 1% fee) |

If the customer pays only 700 and defaults:

- Insurance covers up to `min(50% of junior, 10% of the invoice)` = 100.
- Senior is paid in full (637); junior receives 163.

## How NEAR is used

| NEAR feature | Use |
|---|---|
| Rust smart contracts (`near-sdk`) | Orders, pools, waterfall, insurance, claims, with callback-based rollback on every transfer |
| NEP-141 fungible tokens | Test USDC for deposits, advances, payments and payouts (`ft_transfer_call` / `ft_on_transfer`) |
| NEP-171 non-fungible tokens | Transferable investor positions; payouts follow the current holder |
| NEP-145 storage management | Storage registration for every account that receives USDC |
| Function-call access keys | The underwriter agent can only call `attest_receipt` and `set_merchant_tier`, and cannot move funds |
| Meta transactions | Gasless actions for merchants and customers through a relayer scoped to our contracts |
| Intents / 1Click flow (via Tidepool testnet) | Customers pay from Arbitrum Sepolia and other testnets into a NEAR contract |
| Sputnik DAO | Governs large insurance payouts |
| NEAR AI Cloud | Private underwriting inference with verified TEE attestation |

## Architecture

```
Customer ──approve (gasless)──┐        ┌── Tidepool (any chain → NEAR testnet)
Merchant ──create order/pool──┤        │      ft_transfer_call {"pay": order}
                              ▼        ▼
                  cashflow.<team>.testnet  ── mint ──▶ positions.<team>.testnet (NEP-171)
                  orders · pools · waterfall
                  insurance · claims
                     ▲          ▲          │ ft_transfer (+callback)
       attest_receipt│          │invest    ▼
 underwriter agent ──┘   Investors      usdc.tidepool-sandbox.testnet (NEP-141)
 (NEAR AI Cloud, TEE)                    Sputnik DAO ── approve_cover
```

## Repository layout

```
contracts/   Rust contracts (cashflow, positions) and near-workspaces tests
agent/       AI underwriter agent
watcher/     Tidepool quote and payment verification
relayer/     Meta-transaction relayer
web/         Next.js app
scripts/     deploy, seed, demo
evidence/    JSON proofs of testnet runs
docs/        interface, threat model, Tidepool notes
```

## Try it

Status: **in development.** These steps will be finalised, with testnet contract addresses, before submission.

1. Open the hosted app (link added at deployment) and connect a NEAR testnet wallet.
2. Get test USDC from the Tidepool faucet: <https://app.usetidepool.tech/faucet>.
3. **Merchant:** go to `/merchant` and create an order. You'll see a QR code.
4. **Customer:** go to `/consumer`, scan the code and approve. You'll see the underwriter's verdict and reasons.
5. **Merchant:** create a pool from the approved order. You'll see the pool in `Funding`, needing 600 senior and 200 junior.
6. **Investor:** invest from `/pools/<id>`. You'll see a position NFT in `/portfolio`, and the merchant receives the advance.
7. **Customer:** choose "Pay from any chain" and pay. You'll see Tidepool status, explorer links, and the waterfall filling.
8. **Investor:** claim in `/portfolio`. You'll see USDC received.

## Build status

| Component | Status |
|---|---|
| Core contract (`cashflow`) | Sandbox-tested (11 tests); not yet on testnet |
| Position NFTs (`positions`) | In progress |
| Underwriter agent | In progress |
| Tidepool payments + watcher | In progress |
| Insurance + Sputnik DAO | In progress |
| Web app + relayer | In progress |

## Disclosures

- **Tidepool** is a community-operated testnet of the Intents/1Click flow. It runs the unmodified `defuse` verifier at `verifier.tidepool-sandbox.testnet`. It is not affiliated with NEAR, and NEAR Intents itself has no testnet. All assets are test tokens with no value.
- **Related project:** the author also submits [Wavefund](https://github.com/WaveFund/wavefund-near), an independent project. Some intents-verification utilities from it are reused here and listed as a library.
- **Libraries:** `near-sdk`, `near-contract-standards`, `near-workspaces`, `near-api-js`, `@near-wallet-selector`, the 1Click TypeScript SDK, Next.js. The full list will be finalised before submission.

## License

MIT
