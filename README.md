# Cashflow Fi

Merchant receivables financing on NEAR testnet. A merchant turns customer-confirmed credit sales into an upfront advance. Investors fund a senior and a junior tranche and hold NEP-171 position NFTs that own the payout. The customer pays the invoice cross-chain, an on-chain waterfall repays investors, and an insurance fund with Sputnik DAO approval covers part of a default.

Built for NEAR HACKATHON (2026-11-01 to 2026-11-14). Testnet only; all tokens are test tokens.

## Problem and flow

Merchants who sell on credit wait 30 to 90 days for payment. Cashflow Fi finances those receivables:

1. Merchant calls `create_order` (amount, currency, due date, invoice number).
2. Customer calls `approve_receipt` from their own account, confirming the sale. The merchant cannot approve its own order.
3. The underwriter agent applies deterministic hard rules, scores the order with an LLM inside a verified NEAR AI Cloud TEE, and writes `attest_receipt` (verdict, score, reason hash) on-chain. A completion that fails TEE verification is never used to approve.
4. Merchant calls `create_pool` on approved orders. Terms come from the merchant tier (LTV A/B/C/D = 85/80/70/60 %).
5. Investors fund senior (75 %) and junior (25 %) of the advance with `ft_transfer_call`. Each investment mints a NEP-171 position NFT.
6. When both tranches are full, the merchant receives the advance minus a 1 % fee (half to insurance, half to treasury).
7. The customer pays from Arbitrum Sepolia through Tidepool, or directly on NEAR.
8. The waterfall pays senior face, then junior face, then the merchant residual. Position owners `claim`; payouts follow the current NFT owner.
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
| NEP-366 meta transactions | `relayer/` | Gasless relayer with a method allowlist, spend cap and rate limit |
| Intents 1Click flow via Tidepool | `watcher/`, `scripts/tidepool.mjs` | Tidepool is a community testnet of the NEAR Intents 1Click flow; used because Intents has no testnet |

Check the agent key yourself:

```sh
near account list-keys agent.cashflowfi.testnet network-config testnet now
```

You will see one function-call key (`ed25519:HKeuj...`) limited to `attest_receipt, set_merchant_tier` on `cashflow.cashflowfi.testnet`. The attestation txs below are signed with that key. The account also holds a full-access key, used for setup.

## Architecture

| Component | Path | Role |
|---|---|---|
| Contract | `contracts/cashflow` | NEAR contract: orders, pools, NEP-171 positions, insurance; near-workspaces sandbox tests in `tests/` (one file per area, shared fixture in `tests/common/`) |
| Pool engine | `contracts/cashflow-core` | Pure Rust pool accounting (terms, waterfall, cover), unit-tested natively |
| Test token | `contracts/test-token` | NEP-141 used only by the sandbox tests |
| Underwriter agent | `agent/underwriter.mjs`, `agent/run.mjs` | Hard rules, verified TEE call, strict parse, signs `attest_receipt` |
| Collections agent | `agent/collections.mjs`, `agent/reminder.mjs` | Personalised reminder worded in the verified TEE before the due date (must quote the exact amount and pay link, no other link; template otherwise), `mark_default` after due date plus grace |
| Tier reasons | `agent/tier-reason.mjs` | Rules choose the merchant tier; the TEE model only explains the change. Reason and its sha256 are stored next to the `set_merchant_tier` tx |
| Tidepool client | `watcher/tidepool.mjs`, `lib/quote-signature.mjs` | Builds quotes, verifies the 1Click quote signature, checks delivery on NEAR |
| Payment forwarder | `watcher/forwarder.mjs` | Moves a verified Tidepool delivery into the contract with `ft_transfer_call {"pay"}` |
| API | `api/` | `/api/pay/quote`, `/api/pay/status`, `/api/agent/verdicts`, `/api/ledger/payments` |
| Relayer | `relayer/` | NEP-366 relayer service and client |
| Scripts | `scripts/` | Live testnet runs (`demo.mjs`, `insurance-demo.mjs`, `tidepool.mjs`, `dao.mjs`), attack suites |
| Evidence | `evidence/`, `deployments/testnet.json` | JSON records of every live run with tx hashes |
| Interface | `docs/INTERFACE.md` | Methods, types, events, `msg` formats |

## Verified on testnet

Contract `cashflow.cashflowfi.testnet`, token `usdc.tidepool-sandbox.testnet`. Every run below wrote its evidence file with `"ok": true`.

| Flow | Evidence | Explorer |
|---|---|---|
| Deploy and init | `deployments/testnet.json` | [deploy](https://testnet.nearblocks.io/txns/8SDfWzNgR8ksbniwV5PrvA1jt9hCBSVZPKddrsAp3WEt), [SVG NFT upgrade](https://testnet.nearblocks.io/txns/GJBdWNTn9gicoQ6kGXLoM2DxAqUafJHDGyLSTT8xr58a), [current code](https://testnet.nearblocks.io/txns/HKxaGsbg3D1Kj28NYNUP28SHNRU6afFLRho7wtTg6iJu); on-chain code hash `DBZ1Z2v8DRqU8CGqitHas4bzFrAU1CUwYi4HpqCtPQZ9` equals `cargo near build non-reproducible-wasm` of this repo |
| Happy path, customer pays on NEAR (order 37, pool 22) | `evidence/demo-run.json`, `evidence/attestations/37.json` | [agent attest](https://testnet.nearblocks.io/txns/4n6sT6auUh35yRnfccRxHff6eYbNyQQEazXtcUVPez4Q), [payment + waterfall](https://testnet.nearblocks.io/txns/HayV6cv2ugZi4bwh6gbTuadYYq89DQHA5uVDc87BgA26) |
| Happy path, customer pays from Arbitrum Sepolia via Tidepool (order 38, pool 23) | `evidence/demo-run-tidepool.json`, `evidence/payments/38.json` | [Arbitrum deposit](https://sepolia.arbiscan.io/tx/0x5cd1178475ff43ed1d496ee00f6bdcf81990825d09906289642ad2fdbf0ef07e), [forwarder pays order](https://testnet.nearblocks.io/txns/7MknHLUsjbtbJE5T1Btzxe4QA9BPS3orM6Rkfi8i9oCg) |
| Default: TEE-written reminder before the due date, then collections agent default and Sputnik DAO cover (order 43, pool 25, proposal 5) | `evidence/insurance-run.json`, `evidence/collections/43.json`, `evidence/defaults/25.json` | [mark_default](https://testnet.nearblocks.io/txns/5bv37fK9ssGpwMPANd6wL1dN4PQfuY6FhSv5Wkancy6m), [final DAO vote](https://testnet.nearblocks.io/txns/8UFE5DUG46TrKcVgaLkE4PrR71UeWRByp2aM6u6dNjFF) |
| Merchant tier B → D by the rules (3 defaults); reason and its sha256 stored with the tx. This live change recorded the template reason: the model's answer ("Your tier is D because…") failed a too-literal check, since fixed and covered by a test | `evidence/tiers/merchant.cashflowfi.testnet.D.json` | [set_merchant_tier](https://testnet.nearblocks.io/txns/BCSpFsXf2JLp1ikhngT2kPgE4dxCEadbPhfWL9QujKvE) |
| Funding demo accounts cross-chain via Tidepool | `evidence/funding/*.json` | [Arbitrum deposit](https://sepolia.arbiscan.io/tx/0xcc7a32e9712dfd2ede04483b3a70932c981133f3a06e99c82eba99921013f833), [NEAR delivery](https://testnet.nearblocks.io/txns/CCSoHhBbkGDEBurWsLqVb1VoQ6ZQszCVfZXJ2X6p5p28) |
| On-chain attacks blocked by contract guards | `evidence/attacks/onchain.json` | [merchant self-approve](https://testnet.nearblocks.io/txns/884CMUJyrEGm686LutqxLdiczchxd8E4Kjqscvk7SfC), [spoofed deposit](https://testnet.nearblocks.io/txns/8wXyy2QvH7ThoCwYTkGvH68qq3LL3gMavYcieafSGqmf) |
| Sputnik DAO deployed and wired | `deployments/testnet.json` | [DAO deploy](https://testnet.nearblocks.io/txns/9UTeteha2PXgeMSTAUZqXVtX1Dry3iu5VJXphJ2JbFkM) |
| Underwriter verdict from a verified TEE (order 42: Approve, score 92), re-proved against the on-chain verdict | `evidence/tee-underwrite-run.json`, `evidence/attestations/42.json` | [agent attest](https://testnet.nearblocks.io/txns/49G6MguB6GvYQH7CUHNtvvnvevsFPKseQ18uT3MwfNxG); `GET /api/agent/verdicts?order_id=42` returns `verified: true`, verdicts from before order 22 return `false` |
| Private pool matching: NEAR AI TEE attestation (nonce, Intel TDX quote, NVIDIA GPU) and response signature verified | `evidence/privacy/match-run.json` | Re-check offline, no keys: `node scripts/verify-match.mjs` recomputes both hashes and recovers the attested signer |
| Gasless calls via the NEP-366 relayer (order 40: merchant creates, customer approves; neither pays gas) | `evidence/relayer-run.json` | [create_order](https://testnet.nearblocks.io/txns/AbkC4U5sw7HtefofRrCYingRNvhZ2899uHg79PsGagKj), [approve_receipt](https://testnet.nearblocks.io/txns/5gvUFCGqJ5aLvSCdVbtLgX7yYD7PyS1fdE1V94H7se3e) |

One end-to-end run (`npm run e2e`, evidence `evidence/e2e-run.json`, `"ok": true`) first checks that the deployment matches this repo (config, on-chain code hash, Sputnik version), then runs all eight scenarios in a row against the deployed contracts with every party involved: merchant, customer, two investors, a secondary NFT buyer, the underwriter and collections agents, the forwarder, the relayer, the DAO council and an outside attacker. It passes only if each scenario writes fresh evidence that meets its check: happy path on NEAR, happy path from Arbitrum via Tidepool and the forwarder, position NFTs sold mid-payout (`evidence/nft-transfer-run.json`), gasless relayer calls, all 7 on-chain attacks blocked (including a non-owner claim on a real position), private matching with `verified_private: true`, an underwriter verdict from a verified TEE re-proved offline against the chain, and a TEE-written reminder followed by default and Sputnik DAO cover.

Read the state yourself (no keys needed):

```sh
near contract call-function as-read-only cashflow.cashflowfi.testnet get_pool json-args '{"id":2}' network-config testnet now
```

Expected: `"status": "Repaid"`, `"senior_repaid": "6375000"`, `"junior_repaid": "2125000"`. Pool 5 shows `"status": "Defaulted"`, `"insurance_paid": "1000000"`.

## Reproduce

Requirements: Node 22 or newer, then `npm ci`. For contracts: Rust stable (pinned in `rust-toolchain.toml` with the `wasm32-unknown-unknown` target) and `cargo-near`.

### Offline (no keys, no network except the first sandbox download)

| Run | See |
|---|---|
| `npm test` | `tests 154`, `pass 154`, `fail 0` (agent, private matching and TEE checks, API, watcher, forwarder, relayer, attack cases) |
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
| API (`api/`) | Built and tested (`api/app.test.mjs`); not hosted |
| Relayer (NEP-366) | Built, tested and run live (`evidence/relayer-run.json`, `npm run relay:demo`) |
| Private pool matching with TEE verification | Built, tested and run live (`evidence/privacy/match-run.json`, `verified_private: true`). |
| Frontend | Not in this repo yet; built separately by another developer against `docs/INTERFACE.md` |

## Security

Attack demos with the defense that stopped each one: [`scripts/attacks/README.md`](scripts/attacks/README.md).

- Off-chain: a fully hijacked model cannot produce `Approve` for orders that break the hard rules; the model never sets the verdict, malformed answers are flagged for human review.
- On-chain: forbidden calls (self-approval, non-agent attestation, non-DAO cover, spoofed `ft_on_transfer`) panic with the exact guard message on the live contract.

## Known limitations and trust assumptions

- Testnet only. Nothing is deployed to mainnet.
- NEAR Intents has no testnet (organizer FAQ Q-007), so cross-chain payment uses Tidepool, a community testnet of the 1Click flow. It is not operated by NEAR.
- Tidepool testnet accepts `customRecipientMsg` but does not apply it: it delivers with a plain `ft_transfer`. Payments therefore deliver to `payments.cashflowfi.testnet`, and `watcher/forwarder.mjs` forwards them with `ft_transfer_call {"pay"}`. That account is a custodial hop. Each delivery is reserved by an exclusive evidence file written before broadcast, so it is forwarded at most once.
- 9.974 USDC from the order 5 attempt, delivered by Tidepool with a plain `ft_transfer` before the forwarder existed, sits unallocated in the contract (`deployments/testnet.json` notes, `evidence/payments/5.json`).
- Collections reminders use dry Tidepool quotes unless `TIDEPOOL_LIVE=1`, and get no quote at all without `COLLECTIONS_REFUND_TO` (the agent has no customer refund address). Reminders are written to `evidence/collections/`; delivery (email, SMS) is not built.
- Tier-change reasons and their sha256 are kept in `evidence/tiers/`, not on-chain (`set_merchant_tier` takes no reason).
- The contract refunds an overpayment to its sender. For cross-chain payments the sender is the forwarder, and nothing passes that refund on to the payer: it stays with `payments.cashflowfi.testnet`.
- Relayer rate limits, replay cache and spend cap are in memory and reset on restart.
- The underwriter's TEE checks have the same limits as private matching (next point). Its order facts are public on-chain data, so they are not private; the TEE proves which model produced the score. Hard rules run before and regardless of the model.
- Private matching: the `cloud-api.near.ai` gateway terminates TLS and sees the intent in plaintext; the gateway attestation, RTMR3 event-log replay, `app_compose` measurement and the NRAS JWT signature are not verified and are listed under `not_verified` in every response. TDX collateral comes from Phala's PCCS via `@phala/dcap-qvl`.
- The owner account can pause the contract and withdraw the treasury; the DAO council is two accounts controlled by the team.

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

## License

MIT. See [LICENSE](LICENSE).
