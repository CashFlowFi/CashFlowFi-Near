# Cashflow Fi

Merchant receivables financing on NEAR testnet. A merchant turns customer-confirmed credit sales into an upfront advance. Investors fund a senior and a junior tranche and hold NEP-171 position NFTs that own the payout. The customer pays the invoice cross-chain, an on-chain waterfall repays investors, and an insurance fund with Sputnik DAO approval covers part of a default.

Built for NEAR HACKATHON (2026-11-01 to 2026-11-14). Testnet only; all tokens are test tokens.

## Problem and flow

Merchants who sell on credit wait 30 to 90 days for payment. Cashflow Fi finances those receivables:

1. Merchant calls `create_order` (amount, currency, due date, invoice number).
2. Customer calls `approve_receipt` from their own account, confirming the sale. The merchant cannot approve its own order.
3. The underwriter agent applies deterministic rules first (a customer with 2 or more defaults and more defaults than invoices paid is rejected; so is a customer owing more than 100,000 USDC across all merchants; a new customer's invoice above 20 USDC can at most be flagged for human review), scores the order with an LLM inside a verified NEAR AI Cloud TEE that sees the customer's and the merchant's on-chain repayment records, and writes `attest_receipt` (verdict, score, reason hash) on-chain. A completion that fails TEE verification is never used to approve.
4. Merchant calls `create_pool` on approved orders. Terms come from the merchant tier (LTV A/B/C/D = 85/80/70/60 %).
5. Investors fund senior (75 %) and junior (25 %) of the advance with `ft_transfer_call`. Each investment mints a NEP-171 position NFT.
6. When both tranches are full, the merchant receives the advance minus a 1 % fee (half to insurance, half to treasury).
7. The customer pays from Arbitrum Sepolia through Tidepool, or directly on NEAR.
8. The waterfall pays senior face, then junior face, then refills any insurance cover the pool received, then the merchant residual. Position owners `claim`; payouts follow the current NFT owner.
9. After due date plus grace, anyone (here: the collections agent) calls `mark_default`. Insurance covers `min(50 % of junior face, 10 % of receivable)`. A cover above `dao_threshold` waits for `approve_cover` from the Sputnik DAO.

Numbers from the latest testnet run (10 USDC receivable; the merchant is tier D after 3 defaults, see below): advance 6, merchant net 5.94, senior 4.5 in / 4.78125 back, junior 1.5 in / 1.59375 back, merchant residual 3.625. Default run: customer paid 5.179687, cover 0.796875, senior got 4.78125, junior got 1.195312 (cover included). At tier B the same receivable gives advance 8 and senior/junior faces 6.375/2.125.

## How NEAR is used

| NEAR piece | Where | What it does here |
|---|---|---|
| Rust contract (`near-sdk` 5) | `contracts/cashflow` | Orders, pools, waterfall, insurance, claims; callbacks roll back state on failed transfers |
| NEP-141 | `usdc.tidepool-sandbox.testnet` | All money moves in via `ft_transfer_call` / `ft_on_transfer` (invest, pay, repay, seed insurance) |
| NEP-171 | inside `cashflow` | Position NFTs; `metadata.media` is a live on-chain SVG card; `claim` pays the current owner |
| Function-call access key | `agent.cashflowfi.testnet` | Agent key limited to `attest_receipt` and `set_merchant_tier` on the contract, 0 deposit |
| NEAR AI Cloud TEE (verified inference) | `agent/tee.mjs`, `agent/tee-quote.mjs` | Every model call (underwriter and investor matching) goes to `cloud-api.near.ai` (model `Qwen/Qwen3.6-35B-A3B-FP8` in the runs) only after a nonce-bound attestation and Intel TDX quote check; the response signature must recover to the attested key |
| Verdict proof | `agent/verdict-proof.mjs` | `/api/agent/verdicts` returns `verified: true` only after re-checking the saved signature and binding the signed answer to the on-chain score, reason hash and order |
| Sputnik DAO v2.3.1 | `dao.cashflowfi.testnet` | Council of 2, threshold 2 of 2; only the DAO can call `approve_cover` |
| NEP-366 meta transactions | `relayer/`, `web/src/lib/gasless.ts` | Gasless relayer with a method allowlist, spend cap and rate limit. The web app signs zero-deposit contract calls (`create_order`, `approve_receipt`, `create_pool`, `claim`) with MyNearWallet's function-call key and sends them to the relayer |
| Intents 1Click flow via Tidepool | `watcher/`, `scripts/tidepool.mjs` | Tidepool is a community testnet of the NEAR Intents 1Click flow; used because Intents has no testnet |

## Architecture

| Component | Path | Role |
|---|---|---|
| Contract | `contracts/cashflow` | NEAR contract: orders, pools, NEP-171 positions, insurance; near-workspaces sandbox tests in `tests/` (one file per area, shared fixture in `tests/common/`) |
| Pool engine | `contracts/cashflow-core` | Pure Rust pool accounting (terms, waterfall, cover), unit-tested natively |
| Test token | `contracts/test-token` | NEP-141 used only by the sandbox tests |
| Underwriter agent | `agent/underwriter.mjs`, `agent/run.mjs` | Hard rules, the customer's record (paid, defaulted, open) and the merchant's pools from chain, verified TEE call, strict parse, signs `attest_receipt` |
| Collections agent | `agent/collections.mjs`, `agent/reminder.mjs` | Personalised reminder worded in the verified TEE before the due date (must quote the exact amount and pay link, no other link; template otherwise), `mark_default` after due date plus grace |
| Tier reasons | `agent/tier-reason.mjs` | Rules choose the merchant tier; the TEE model only explains the change. Reason and its sha256 are stored next to the `set_merchant_tier` tx |
| Tidepool client | `watcher/tidepool.mjs`, `lib/quote-signature.mjs` | Builds quotes, verifies the 1Click quote signature, checks delivery on NEAR |
| Payment forwarder | `watcher/forwarder.mjs` | Moves a verified Tidepool delivery into the contract with `ft_transfer_call {"pay"}` |
| API | `api/` | `/api/pay/quote`, `/api/pay/status`, `/api/agent/verdicts`, `/api/ledger/payments` |
| Relayer | `relayer/` | NEP-366 relayer service and client |
| Scripts | `scripts/` | Live testnet runs (`demo.mjs`, `insurance-demo.mjs`, `tidepool.mjs`, `dao.mjs`), attack suites |
| Evidence | `evidence/`, `deployments/testnet.json` | JSON records of every live run with tx hashes |
| Web app | `web/` | Next.js app: pool workspace with stage selector, invoices with QR sharing, merchant desk, portfolio, agents, insurance; reads the chain over RPC and signs with NEAR wallet-selector |
| Interface | `docs/INTERFACE.md` | Methods, types, events, `msg` formats |

## Verified on testnet

Contract `cashflow.cashflowfi.testnet`, token `usdc.tidepool-sandbox.testnet`. Every run below wrote its evidence file with `"ok": true`.

| Flow | Evidence | Explorer |
|---|---|---|
| Deploy and init | `deployments/testnet.json` | [deploy](https://testnet.nearblocks.io/txns/8SDfWzNgR8ksbniwV5PrvA1jt9hCBSVZPKddrsAp3WEt), [SVG NFT upgrade](https://testnet.nearblocks.io/txns/GJBdWNTn9gicoQ6kGXLoM2DxAqUafJHDGyLSTT8xr58a), [current code](https://testnet.nearblocks.io/txns/HKxaGsbg3D1Kj28NYNUP28SHNRU6afFLRho7wtTg6iJu); on-chain code hash `DBZ1Z2v8DRqU8CGqitHas4bzFrAU1CUwYi4HpqCtPQZ9` equals `cargo near build non-reproducible-wasm` of this repo |
| Happy path, customer pays on NEAR (order 37, pool 22) | `evidence/demo-run.json`, `evidence/attestations/37.json` | [agent attest](https://testnet.nearblocks.io/txns/4n6sT6auUh35yRnfccRxHff6eYbNyQQEazXtcUVPez4Q), [payment + waterfall](https://testnet.nearblocks.io/txns/HayV6cv2ugZi4bwh6gbTuadYYq89DQHA5uVDc87BgA26) |
| Underwriter weighs the customer's own record: a customer with no defaults is approved (order 44: Approve 85 from a verified TEE), pool 26 funded, paid and claimed by `buyer.cashflowfi.testnet` | `evidence/demo-run-buyer.json`, `evidence/attestations/44.json` | [agent attest](https://testnet.nearblocks.io/txns/Ah5yzkmUK3aeZb5EpECxmemsfESn8kiZzBDjQF9m2jsg), [payment + waterfall](https://testnet.nearblocks.io/txns/ErGXhKTZcg9fDpk2EVFQoCn69Y7ABzUgMcZCTedQTihw); `GET /api/agent/verdicts?order_id=44` returns `verified: true` |
| Happy path, customer pays from Arbitrum Sepolia via Tidepool (order 38, pool 23) | `evidence/demo-run-tidepool.json`, `evidence/payments/38.json` | [Arbitrum deposit](https://sepolia.arbiscan.io/tx/0x5cd1178475ff43ed1d496ee00f6bdcf81990825d09906289642ad2fdbf0ef07e), [forwarder pays order](https://testnet.nearblocks.io/txns/7MknHLUsjbtbJE5T1Btzxe4QA9BPS3orM6Rkfi8i9oCg) |
| Default: TEE-written reminder before the due date, then collections agent default and Sputnik DAO cover (order 43, pool 25, proposal 5) | `evidence/insurance-run.json`, `evidence/collections/43.json`, `evidence/defaults/25.json` | [mark_default](https://testnet.nearblocks.io/txns/5bv37fK9ssGpwMPANd6wL1dN4PQfuY6FhSv5Wkancy6m), [final DAO vote](https://testnet.nearblocks.io/txns/8UFE5DUG46TrKcVgaLkE4PrR71UeWRByp2aM6u6dNjFF) |
| Merchant tier B → D by the rules (3 defaults); reason and its sha256 stored with the tx. | `evidence/tiers/merchant.cashflowfi.testnet.D.json` | [set_merchant_tier](https://testnet.nearblocks.io/txns/BCSpFsXf2JLp1ikhngT2kPgE4dxCEadbPhfWL9QujKvE) |
| Funding demo accounts cross-chain via Tidepool | `evidence/funding/*.json` | [Arbitrum deposit](https://sepolia.arbiscan.io/tx/0xcc7a32e9712dfd2ede04483b3a70932c981133f3a06e99c82eba99921013f833), [NEAR delivery](https://testnet.nearblocks.io/txns/CCSoHhBbkGDEBurWsLqVb1VoQ6ZQszCVfZXJ2X6p5p28) |
| On-chain attacks blocked by contract guards | `evidence/attacks/onchain.json` | [merchant self-approve](https://testnet.nearblocks.io/txns/884CMUJyrEGm686LutqxLdiczchxd8E4Kjqscvk7SfC), [spoofed deposit](https://testnet.nearblocks.io/txns/8wXyy2QvH7ThoCwYTkGvH68qq3LL3gMavYcieafSGqmf) |
| Sputnik DAO deployed and wired | `deployments/testnet.json` | [DAO deploy](https://testnet.nearblocks.io/txns/9UTeteha2PXgeMSTAUZqXVtX1Dry3iu5VJXphJ2JbFkM) |
| Underwriter verdict from a verified TEE (order 42: Approve, score 92), re-proved against the on-chain verdict | `evidence/tee-underwrite-run.json`, `evidence/attestations/42.json` | [agent attest](https://testnet.nearblocks.io/txns/49G6MguB6GvYQH7CUHNtvvnvevsFPKseQ18uT3MwfNxG); `GET /api/agent/verdicts?order_id=42` returns `verified: true` |
| Private pool matching: NEAR AI TEE attestation (nonce, Intel TDX quote, NVIDIA GPU) and response signature verified | `evidence/privacy/match-run.json` | Re-check offline, no keys: `node scripts/verify-match.mjs` recomputes both hashes and recovers the attested signer |
| Web app transaction builders (`web/src/lib/tx.ts`) on pool 1: two investments fill the pool, the customer pays 10 USDC, both holders claim; pool 1 is now `Repaid` | — | [senior invest](https://testnet.nearblocks.io/txns/efEiHghfrqf6zXTNeKJonuNQZDZ2uS1YpNm14EjbA9G), [junior invest + advance](https://testnet.nearblocks.io/txns/HHaCS9XkU4NXEpgwaLQyaZP7Mr8SNkPtf1k1y95eMXV4), [payment](https://testnet.nearblocks.io/txns/CgNKMGukfbKonzwqjj1228WnhVtBuizSn8RhB47ccu5Y), [claim](https://testnet.nearblocks.io/txns/HeYFToPP5wgft4ShVABHejXfDaJpjNw9Q6nZtfVhzBzs) |
| Gasless calls via the NEP-366 relayer (order 40: merchant creates, customer approves; neither pays gas) | `evidence/relayer-run.json` | [create_order](https://testnet.nearblocks.io/txns/AbkC4U5sw7HtefofRrCYingRNvhZ2899uHg79PsGagKj), [approve_receipt](https://testnet.nearblocks.io/txns/5gvUFCGqJ5aLvSCdVbtLgX7yYD7PyS1fdE1V94H7se3e) |

One end-to-end run (`npm run e2e`, evidence `evidence/e2e-run.json`, `"ok": true`) first checks that the deployment matches this repo (config, on-chain code hash, Sputnik version), then runs all eight scenarios in a row against the deployed contracts with every party involved: merchant, customer, two investors, a secondary NFT buyer, the underwriter and collections agents, the forwarder, the relayer, the DAO council and an outside attacker. It passes only if each scenario writes fresh evidence that meets its check: happy path on NEAR, happy path from Arbitrum via Tidepool and the forwarder, position NFTs sold mid-payout (`evidence/nft-transfer-run.json`), gasless relayer calls, all 7 on-chain attacks blocked (including a non-owner claim on a real position), private matching with `verified_private: true`, an underwriter verdict from a verified TEE re-proved offline against the chain, and a TEE-written reminder followed by default and Sputnik DAO cover.

Read the state yourself (no keys needed):

```sh
near contract call-function as-read-only cashflow.cashflowfi.testnet get_pool json-args '{"id":2}' network-config testnet now
```

Expected: `"status": "Repaid"`, `"senior_repaid": "6375000"`, `"junior_repaid": "2125000"`. Pool 5 shows `"status": "Defaulted"`, `"insurance_paid": "1000000"`.

## Try the web app

```sh
cd web && npm ci && npm run build && npm start      # http://localhost:3000
```

The app reads the live testnet contract directly, so these steps need no keys. For the AI verification badges, matching and cross-chain quotes, also run the API from the repo root (`CORS_ORIGIN=http://localhost:3000 npm run api`) and build the app with `NEXT_PUBLIC_API_URL=http://localhost:8787`. Optional: `NEXT_PUBLIC_RELAYER_URL=http://localhost:8788` with `npm run relayer` for gas-free calls.

| Do | See |
|---|---|
| Open `/` and pick a role under **I am a…** | A step-by-step guide for merchant, customer, investor or visitor, each step linking to its page. Investors also see the pools open right now |
| Open `/` | Live protocol numbers read from the chain (USDC repaid, pools, invoices scored by AI, insurance fund) and where the AI agents work |
| Click **Explore a pool** (pool 22) | The stage selector Invoice → Approved → Underwritten → Funded → Paid → Claimed, opened on the result: 6.375 USDC claimed of 6.375 paid out. **Replay this pool** steps through each stage |
| Click **Underwritten** | Verdict Approve, score 92, the reason hash, and the customer's and merchant's track records the AI weighs, all from chain. With the API: **TEE verified** and **What was verified** listing 5/5 checks (nonce, Intel TDX quote, NVIDIA GPU, response signature, attested signer) |
| Click **Activity & receipts** | Every transaction of that pool with explorer links, from `evidence/` |
| Click **proof** next to **TEE verified**, or **View proof** in the receipts | The proof viewer: what the record proves in plain words on the left, the raw evidence JSON on the right; hovering a point highlights its fields |
| Open `/pools/25` | A defaulted pool: Paid (5.179687 of 10), Default, Cover 0.796875 approved by the Sputnik DAO, every payout claimed |
| Open `/invoices/55` (INV-SHOP-1001), sign in as the merchant | A QR and WhatsApp / Telegram / copy links for the customer. Signed in as any other account: **Is this invoice for you?** (type `buyer@example.com`: it matches the on-chain hash) and **Approve invoice** (the contract rejects the merchant's own approval) |
| Open `/invoices/5` | **Pay on NEAR** (`ft_transfer_call` with the pay msg) and **Pay from Arbitrum** through the NEAR Intents 1Click flow on Tidepool: a labelled preview, or with `TIDEPOOL_LIVE=1` a deposit address and an EIP-681 QR for the exact USDC amount |
| Open `/portfolio` | Position NFTs of the demo investors, each card a live SVG rendered by the contract. Signed in: **Claim** and **Transfer**. With the API: **Find a tranche** returns ranked suggestions marked **Verified private (TEE)** |
| Open `/merchant?account=merchant.cashflowfi.testnet` | The demo merchant's invoices with AI verdicts, tier D (60 % advance), pools, and **Invoices CSV** for an accountant |
| Open `/agents` and `/insurance` | Underwriter verdicts, the tier change B → D, TEE-written reminders; the insurance fund, defaulted pools and DAO proposals |

`cd web && npm test` runs 86 tests on the stage mapping, BigInt amounts, transaction builders and real outcomes, gas-free signing checked against the relayer's own decoder and policy, TEE checks, CSV and sharing.

## Reproduce

Requirements: Node 22 or newer, then `npm ci`. For contracts: Rust stable (pinned in `rust-toolchain.toml` with the `wasm32-unknown-unknown` target) and `cargo-near`.

### Offline (no keys, no network except the first sandbox download)

| Run | See |
|---|---|
| `npm test` | `tests 164`, `pass 164`, `fail 0` (agent, private matching and TEE checks, API, watcher, forwarder, relayer, attack cases) |
| `cd contracts/cashflow && cargo test --tests` | every `test result: ok`: 13 sandbox tests across 7 files plus 2 unit tests (near-workspaces sandbox: order rules, pool terms, waterfall, claims follow the NFT, NFT transfer mid-payout, default cover, DAO threshold, agent-only calls, SVG card) |
| `npm run test:contracts` | `test result: ok. 14 passed` (pure pool engine) |
| `npm run attacks` | 16 cases, each `[HELD]` with the defense; rewrites `evidence/attacks/offchain.json` |

### Live on testnet

These scripts sign as the accounts in `deployments/testnet.json` and rewrite their evidence files. They need:

- `.env` copied from `.env.example`, with `NEARAI_API_KEY`, `NEARAI_MODEL`, `AGENT_ACCOUNT`, `AGENT_PRIVATE_KEY` (the function-call key, see `scripts/add-agent-key.md`) and `CASHFLOW_CONTRACT`.
- Full-access keys for the merchant, customer, investor, owner and forwarder accounts in `~/.near-credentials/testnet/<account>.json` (the near-cli-rs legacy keychain).
- Test USDC on those accounts (Tidepool faucet: https://app.usetidepool.tech/faucet).
- For the Tidepool payment: `EVM_PRIVATE_KEY` in `.env` for an Arbitrum Sepolia wallet holding test USDC and ETH.

Without our keys, a judge can verify the runs through the explorer links and view calls above. To run them yourself, deploy `contracts/cashflow` to your own accounts, call `new(token_id, agent_id, dao_id, grace_ns, dao_threshold)`, and put your account ids in `deployments/testnet.json`. There is no deploy script in this repo.

| Run | See |
|---|---|
| `npm run demo` | `✓ 1. merchant creates order <hash>` through `✓ 7b. junior holder claims <hash>`, each check `ok`, then `evidence/demo-run.json written (ok=true)` |
| `DEMO_PAY=tidepool npm run demo` | Same, with step 6 replaced by an Arbitrum Sepolia deposit, Tidepool delivery to `payments.cashflowfi.testnet` and the forwarder's `ft_transfer_call`; writes `evidence/demo-run-tidepool.json` and `evidence/payments/<order>.json` |
| `node scripts/insurance-demo.mjs` | About 7 minutes (5-minute grace). Steps 1 to 10b, checks `Defaulted`, pending cover, DAO proposal `Approved`, claims; writes `evidence/insurance-run.json` |
| `node scripts/attacks/onchain.mjs` | One `[BLOCKED]` line per forbidden call with the expected and observed panic and a tx link; writes `evidence/attacks/onchain.json (ok=true)` |

## Build status

| Component | Status |
|---|---|
| Contract `cashflow` with NEP-171 positions | Deployed on testnet; 13 sandbox tests, 14 engine tests |
| Underwriter agent (NEAR AI Cloud TEE, function-call key) | Live: attestations in `evidence/attestations/`; from order 22 on, each carries a verified TEE privacy block and raw signed bodies. Tier pass live (B → D) |
| Tidepool payment + forwarder | Live run done (order 38) |
| Collections agent | Live: TEE-written reminders (orders 5, 43), `mark_default` on pool 25 |
| Insurance + Sputnik DAO cover | Live run done (pool 25, proposal 5) |
| Attack suites | Off-chain in `npm test`; on-chain run on testnet |
| API (`api/`) | Built and tested (`api/app.test.mjs`) |
| Relayer (NEP-366) | Built, tested and run live (`evidence/relayer-run.json`, `npm run relay:demo`) |
| Private pool matching with TEE verification | Built, tested and run live (`evidence/privacy/match-run.json`, `verified_private: true`). |
| Web app (`web/`) | Built: all screens above, wallet sign-in (MyNearWallet, Meteor), invest, pay, claim, transfer, approve, create invoice, open pool, withdraw; in-app proof viewer for every evidence record; 86 tests |

## Security

Attack demos with the defense that stopped each one: [`scripts/attacks/README.md`](scripts/attacks/README.md).

- Off-chain: a fully hijacked model cannot produce `Approve` for orders that break the hard rules; the model never sets the verdict, malformed answers are flagged for human review.
- On-chain: forbidden calls (self-approval, non-agent attestation, non-DAO cover, spoofed `ft_on_transfer`) panic with the exact guard message on the live contract.

## Disclosures

- **Related project:** the author also submits [Wavefund](https://github.com/WaveFund/wavefund-near), an independent project. One intents-verification utility from it is reused here and listed as a library below.
- **Tidepool** is community-operated and runs the unmodified `defuse` verifier at `verifier.tidepool-sandbox.testnet`. It is not affiliated with NEAR.
- AI coding assistants were used during development.

### Libraries

| Library | Use |
|---|---|
| `near-sdk` 5 | Contract |
| `near-contract-standards` 5 | NEP-141 interface, NEP-171 implementation |
| `near-workspaces` 0.24 | Sandbox tests |
| `cargo-near` | Wasm build (used by `near_workspaces::compile_project`) |
| `near-api-js` 7.4.0 | Agent, forwarder, relayer, scripts |
| `viem` 2.57.13 | Arbitrum Sepolia deposits in `scripts/tidepool.mjs` |
| `lib/quote-signature.mjs` | 1Click quote-signature verification, reused from Wavefund (`runtime/intents/signature.mjs`); re-implements the check from `@defuse-protocol/one-click-sdk-typescript` 0.1.26 without adding that dependency |
| Sputnik DAO v2.3.1 | Deployed as the insurance governance DAO (code hash in `deployments/testnet.json`) |
| Next.js 15.5, Tailwind CSS 4 | Web app |
| `@near-wallet-selector` 10.1.4 | Wallet sign-in and signing in the web app |
| `qrcode` 1.5.4 | Invoice and payment QR codes |

## License

MIT. See [LICENSE](LICENSE).
