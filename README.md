# Cashflow Fi

Merchant receivables financing on NEAR testnet. A merchant turns customer-confirmed credit sales into an upfront advance. Investors fund a senior and a junior tranche and hold NEP-171 position NFTs that own the payout. The customer pays the invoice cross-chain, an on-chain waterfall repays investors, and an insurance fund with Sputnik DAO approval covers part of a default.

Built for NEAR HACKATHON (2026-11-01 to 2026-11-14). Testnet only; all tokens are test tokens.

## Problem and flow

Merchants who sell on credit wait 30 to 90 days for payment. Cashflow Fi finances those receivables:

1. Merchant calls `create_order` (amount, currency, due date, invoice number).
2. Customer calls `approve_receipt` from their own account, confirming the sale. The merchant cannot approve its own order.
3. The underwriter agent scores the order with an LLM on NEAR AI Cloud, applies deterministic hard rules, and writes `attest_receipt` (verdict, score, reason hash) on-chain.
4. Merchant calls `create_pool` on approved orders. Terms come from the merchant tier (LTV A/B/C/D = 85/80/70/60 %).
5. Investors fund senior (75 %) and junior (25 %) of the advance with `ft_transfer_call`. Each investment mints a NEP-171 position NFT.
6. When both tranches are full, the merchant receives the advance minus a 1 % fee (half to insurance, half to treasury).
7. The customer pays from Arbitrum Sepolia through Tidepool, or directly on NEAR.
8. The waterfall pays senior face, then junior face, then the merchant residual. Position owners `claim`; payouts follow the current NFT owner.
9. After due date plus grace, anyone (here: the collections agent) calls `mark_default`. Insurance covers `min(50 % of junior face, 10 % of receivable)`. A cover above `dao_threshold` waits for `approve_cover` from the Sputnik DAO.

Numbers from the testnet run (10 USDC receivable, tier B): advance 8, merchant net 7.92, senior 6 in / 6.375 back, junior 2 in / 2.125 back, merchant residual 1.5. Default run: customer paid 7, cover 1, senior got 6.375, junior got 1.625.

## How NEAR is used

| NEAR piece | Where | What it does here |
|---|---|---|
| Rust contract (`near-sdk` 5) | `contracts/cashflow` | Orders, pools, waterfall, insurance, claims; callbacks roll back state on failed transfers |
| NEP-141 | `usdc.tidepool-sandbox.testnet` | All money moves in via `ft_transfer_call` / `ft_on_transfer` (invest, pay, repay, seed insurance) |
| NEP-171 | inside `cashflow` | Position NFTs; `metadata.media` is a live on-chain SVG card; `claim` pays the current owner |
| Function-call access key | `agent.cashflowfi.testnet` | Agent key limited to `attest_receipt` and `set_merchant_tier` on the contract, 0 deposit |
| NEAR AI Cloud | `agent/underwriter.mjs` | Chat completion at `cloud-api.near.ai` (model `Qwen/Qwen3.6-35B-A3B-FP8` in the runs) |
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
| Underwriter agent | `agent/underwriter.mjs`, `agent/run.mjs` | Hard rules, NEAR AI call, strict parse, signs `attest_receipt` |
| Collections agent | `agent/collections.mjs` | Payment reminders before due date, `mark_default` after due date plus grace |
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
| Deploy and init | `deployments/testnet.json` | [deploy](https://testnet.nearblocks.io/txns/8SDfWzNgR8ksbniwV5PrvA1jt9hCBSVZPKddrsAp3WEt), [SVG NFT upgrade](https://testnet.nearblocks.io/txns/GJBdWNTn9gicoQ6kGXLoM2DxAqUafJHDGyLSTT8xr58a) |
| Happy path, customer pays on NEAR (order 4, pool 2) | `evidence/demo-run.json`, `evidence/attestations/4.json` | [agent attest](https://testnet.nearblocks.io/txns/2Scu7EPzbyxKjuMx3hx43j9mGAN2Wf5cSX8Eej9WWRoU), [payment + waterfall](https://testnet.nearblocks.io/txns/BwUcf7dbNBRRabkrm8PUTDLERBMYumV2CU3JEpU3EkGz) |
| Happy path, customer pays from Arbitrum Sepolia via Tidepool (order 6, pool 4) | `evidence/demo-run-tidepool.json`, `evidence/payments/6.json` | [Arbitrum deposit](https://sepolia.arbiscan.io/tx/0xfdfc3c81711986ed7da85b1636aeca9a7cd9469917c2434f29ab96d5f4d6f88a), [forwarder pays order](https://testnet.nearblocks.io/txns/9ExMjG2TpeSEGVaSCD91Y2MuKAyQwNAZCYrZR2JB3DG5) |
| Default, collections agent, Sputnik DAO cover (order 8, pool 5) | `evidence/insurance-run.json`, `evidence/defaults/5.json` | [mark_default](https://testnet.nearblocks.io/txns/PYvP8Dk3CoodZHfRVgDJ9znM5QgazAKrBUdopiaRzfw), [final DAO vote](https://testnet.nearblocks.io/txns/FbUmHdaSH8MxJ7h2Xc2LMYWBnDkwmPptNn1ukEk4PyL1) |
| Funding demo accounts cross-chain via Tidepool | `evidence/funding/*.json` | [Arbitrum deposit](https://sepolia.arbiscan.io/tx/0xcc7a32e9712dfd2ede04483b3a70932c981133f3a06e99c82eba99921013f833), [NEAR delivery](https://testnet.nearblocks.io/txns/CCSoHhBbkGDEBurWsLqVb1VoQ6ZQszCVfZXJ2X6p5p28) |
| On-chain attacks blocked by contract guards | `evidence/attacks/onchain.json` | [merchant self-approve](https://testnet.nearblocks.io/txns/6vD9XdhtxtAR54tkrffv3umK1pHA4ykYBocXdubcS46h), [spoofed deposit](https://testnet.nearblocks.io/txns/7SsPgdP8CQbENbfEWzjt4TUyp1KPfXSCMjFKL13wpkoG) |
| Sputnik DAO deployed and wired | `deployments/testnet.json` | [DAO deploy](https://testnet.nearblocks.io/txns/9UTeteha2PXgeMSTAUZqXVtX1Dry3iu5VJXphJ2JbFkM) |
| Gasless calls via the NEP-366 relayer (order 9: merchant creates, customer approves; neither pays gas) | `evidence/relayer-run.json` | [create_order](https://testnet.nearblocks.io/txns/83wmLDunDHwRwT5QLskLLbuJr46euD7tyBm893M17oio), [approve_receipt](https://testnet.nearblocks.io/txns/Bk8X9mtjMghG9SvWdmHCwqED6wR16AASukFzpj4r8aBG) |

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
| `npm test` | `tests 114`, `pass 114`, `fail 0` (agent, API, watcher, forwarder, relayer, attack cases) |
| `cd contracts/cashflow && cargo test --tests` | every `test result: ok`: 13 sandbox tests across 7 files plus 2 unit tests (near-workspaces sandbox: order rules, pool terms, waterfall, claims follow the NFT, NFT transfer mid-payout, default cover, DAO threshold, agent-only calls, SVG card) |
| `npm run test:contracts` | `test result: ok. 14 passed` (pure pool engine) |
| `npm run attacks` | 16 cases, each `[HELD]` with the defense; rewrites `evidence/attacks/offchain.json` |

### Live on testnet

These scripts sign as the accounts in `deployments/testnet.json` and rewrite their evidence files. They need:

- `.env` copied from `.env.example`, with `NEARAI_API_KEY`, `NEARAI_MODEL`, `AGENT_ACCOUNT`, `AGENT_PRIVATE_KEY` (the function-call key, see `scripts/add-agent-key.md`) and `CASHFLOW_CONTRACT`.
- Full-access keys for the merchant, customer, investor, owner and forwarder accounts in `~/.near-credentials/testnet/<account>.json` (the near-cli-rs legacy keychain).
- Test USDC on those accounts (Tidepool faucet: https://app.usetidepool.tech/faucet).
- For the Tidepool payment: `EVM_PRIVATE_KEY` in `.env` (not listed in `.env.example`) for an Arbitrum Sepolia wallet holding test USDC and ETH.

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
| Underwriter agent (NEAR AI Cloud, function-call key) | Live: attestations for orders 2 to 8 in `evidence/attestations/` |
| Tidepool payment + forwarder | Live run done (order 6) |
| Collections agent | Live: `mark_default` on pool 5 |
| Insurance + Sputnik DAO cover | Live run done (pool 5, proposal 1) |
| Attack suites | Off-chain in `npm test`; on-chain run on testnet |
| API (`api/`) | Built and tested (`api/app.test.mjs`); not hosted |
| Relayer (NEP-366) | Built, tested and run live (`evidence/relayer-run.json`, `npm run relay:demo`) |
| TEE attestation verification for inference | In progress. Not verified: `/api/agent/verdicts` returns `verified: false` when no attestation is recorded, and none is recorded yet |
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
- Collections reminders use dry Tidepool quotes unless `TIDEPOOL_LIVE=1`.
- Relayer rate limits, replay cache and spend cap are in memory and reset on restart.
- The underwriter trusts the NEAR AI Cloud response; TEE attestation is not yet verified (see Build status). Hard rules run before and regardless of the model.
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
