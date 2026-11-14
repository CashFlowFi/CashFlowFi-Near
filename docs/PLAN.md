# Build plan: 2 developers, happy path first

The **happy path** is the demo:

1. Order → customer approves → agent attests.
2. Pool → invest (NFT) → advance.
3. Customer pays through Tidepool → waterfall → claim.

Everything else is layered on top of that.

## Owners

| Area | Owner |
|---|---|
| `web/` (Next.js app, wallet, all pages, CSV, deploy) | **FE dev** |
| `contracts/`, `agent/`, `watcher/`, `scripts/`, `evidence/`, README | **Core (us)** |
| `relayer/` | Core now; moves to the 3rd dev when they join |

The FE dev builds against [`INTERFACE.md`](INTERFACE.md) with the mock fixture. They don't need to wait for the deploy.

## Milestones

| # | Milestone | Core (us) | FE dev | Done when |
|---|---|---|---|---|
| M0 | Unblock | `INTERFACE.md`, the pure-Rust pool engine plus tests | Scaffold `web/`, wallet-selector login, mock client | FE renders mocked pools |
| M1 | Contracts on testnet | `cashflow` + `positions` deployed, storage registered, `scripts/demo.sh` runs the happy path from the CLI | Pages wired to testnet: merchant, consumer, pools, portfolio | Happy path clicks through in the browser |
| M2 | Agent | Underwriter agent (NEAR AI Cloud, function-call key) attesting live | Verdict and reasons on the order page; agent page | Order auto-attested within 30 s |
| M3 | Tidepool pay | Watcher plus the `/api/pay/*` endpoints; one verified Arbitrum Sepolia → contract payment | "Pay from any chain" flow with live status | `evidence/payments/*.json` shows `delivered` |
| **Demo-ready** | **M0–M3 = the happy path** | | | Record a backup video here |
| M4 | Insurance + default + DAO | `mark_default`, cover, Sputnik `approve_cover` | Insurance page | Default case in the demo |
| M5 | NFT resale + tiers | Positions transfer, adaptive LTV | Portfolio transfer, tier badge | — |
| M6 | Security + privacy | Attack demos, TEE attestation verification | Attestation badge | — |
| M7 | Gasless + polish | Meta-tx relayer | Relayer wiring, CSV export | — |
| M8 | Submit | README with evidence, video, X post draft | Vercel deploy kept up until 25 Nov | Human submits |

## Where AI agents and extra tracks add strength (ranked by value for effort)

| # | Addition | Tracks | Effort | Why |
|---|---|---|---|---|
| 1 | **Underwriter agent** (receipt verdicts and merchant tier on-chain, function-call key) | agents, security, realworld | M | Answers the core risk question: "what stops fake invoices?" |
| 2 | **TEE-verified inference** for the underwriter (NEAR AI Cloud attestation + badge) | privacy | S once #1 exists | Customer data is never exposed. Cheap to add |
| 3 | **Collections agent**: before the due date it sends the customer a pay link (Tidepool quote); after the due date it calls `mark_default` | agents, realworld | S | Makes the default/insurance path autonomous, so no human triggers it |
| 4 | **Investor allocator agent** with a Tidepool Agent API wallet (policy-bound spend limits): auto-invests in pools that match the investor's risk profile and the agent's score | agents, security, defi | M | Shows an agent spending money safely within limits |
| 5 | **Prompt-injection and fake-invoice attack demos** | security | S | Judges value a demonstrated defense |
| 6 | **Sputnik DAO insurance governance** | social | S–M | Uses an existing DAO instead of a new multisig |
| 7 | **Position NFTs with on-chain SVG** showing the pool, tranche and claimable amount | nfts | S | "NFT that owns cash flow" |

Current track coverage centres on receivables financing (`defi`, `realworld`), agent controls and attack demonstrations (`security`), TEE inference (`privacy`), DAO-governed insurance (`social`), and transferable payout positions (`nfts`). Final track selection follows the workflows demonstrated in the submission.

## Working rules

- Branch per feature and PR to `main`; `main` always deploys.
- `.env*` files are never committed. Each dev uses their own testnet accounts.
- Tick a track only when its demo works.
