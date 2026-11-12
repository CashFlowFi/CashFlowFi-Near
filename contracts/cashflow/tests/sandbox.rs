//! Sandbox tests: the real contract and a NEP-141 test token on a local NEAR node.
//! Amounts use 6 decimals, like testnet USDC. Worked example: receivable 1,000, tier B.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

const YOCTO: NearToken = NearToken::from_yoctonear(1);
const DAY_NS: u64 = 86_400_000_000_000;

/// USDC with 6 decimals. Exact for every value used here.
fn usdc(x: f64) -> u128 {
    (x * 1_000_000.0).round() as u128
}

static WASMS: OnceCell<(Vec<u8>, Vec<u8>)> = OnceCell::const_new();

async fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    WASMS
        .get_or_init(|| async {
            let core = near_workspaces::compile_project("./").await.expect("compile cashflow");
            let token = near_workspaces::compile_project("../test-token").await.expect("compile test-token");
            (core, token)
        })
        .await
}

struct Ctx {
    worker: Worker<Sandbox>,
    token: Contract,
    cf: Contract,
    merchant: Account,
    customer: Account,
    agent: Account,
    dao: Account,
    alice: Account,
    bob: Account,
    carol: Account,
}

struct Opts {
    grace_ns: u64,
    dao_threshold: u128,
    register_merchant: bool,
}

impl Default for Opts {
    fn default() -> Self {
        Self { grace_ns: DAY_NS, dao_threshold: usdc(1_000.0), register_merchant: true }
    }
}

async fn setup(opts: Opts) -> anyhow::Result<Ctx> {
    let (core_wasm, token_wasm) = wasms().await;
    let worker = near_workspaces::sandbox().await?;
    let token = worker.dev_deploy(token_wasm).await?;
    token.call("new").transact().await?.into_result()?;
    let cf = worker.dev_deploy(core_wasm).await?;

    let root = worker.root_account()?;
    let mut accs = Vec::new();
    for name in ["merchant", "customer", "agent", "dao", "alice", "bob", "carol"] {
        accs.push(root.create_subaccount(name).initial_balance(NearToken::from_near(20)).transact().await?.into_result()?);
    }
    let [merchant, customer, agent, dao, alice, bob, carol]: [Account; 7] = accs.try_into().ok().unwrap();

    cf.call("new")
        .args_json(json!({
            "token_id": token.id(), "agent_id": agent.id(), "dao_id": dao.id(),
            "grace_ns": opts.grace_ns.to_string(), "dao_threshold": opts.dao_threshold.to_string(),
        }))
        .transact()
        .await?
        .into_result()?;

    let mut registered: Vec<&near_workspaces::AccountId> = vec![cf.id(), customer.id(), alice.id(), bob.id(), carol.id()];
    if opts.register_merchant {
        registered.push(merchant.id());
    }
    for id in registered {
        register(&token, &root, id).await?;
    }
    for a in [&customer, &alice, &bob, &carol] {
        token.call("mint").args_json(json!({"account_id": a.id(), "amount": usdc(10_000.0).to_string()})).transact().await?.into_result()?;
    }
    Ok(Ctx { worker, token, cf, merchant, customer, agent, dao, alice, bob, carol })
}

async fn register(token: &Contract, payer: &Account, id: &near_workspaces::AccountId) -> anyhow::Result<()> {
    payer
        .call(token.id(), "storage_deposit")
        .args_json(json!({"account_id": id}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

// ---------- helpers ----------

async fn now_ns(c: &Ctx) -> anyhow::Result<u64> {
    Ok(c.worker.view_block().await?.timestamp())
}

async fn balance(c: &Ctx, who: &near_workspaces::AccountId) -> anyhow::Result<u128> {
    let v: String = c.token.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(v.parse()?)
}

async fn view(c: &Ctx, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(c.cf.view(method).args_json(args).await?.json()?)
}

fn u(v: &Value, field: &str) -> u128 {
    v[field].as_str().unwrap_or_else(|| panic!("{field} missing in {v}")).parse().unwrap()
}

/// Asserts the call failed and that the failure names `msg`.
fn assert_fails(out: &ExecutionFinalResult, msg: &str) {
    assert!(out.is_failure(), "expected failure '{msg}', got success");
    let dbg = format!("{:?}", out.failures());
    assert!(dbg.contains(msg), "expected '{msg}' in failures: {dbg}");
}

/// Asserts some receipt in the transaction failed with `msg` (for failures behind a successful top level).
fn assert_receipt_fails(out: &ExecutionFinalResult, msg: &str) {
    let dbg = format!("{:?}", out.receipt_failures());
    assert!(dbg.contains(msg), "expected '{msg}' in receipt failures: {dbg}");
}

async fn ft_call(c: &Ctx, from: &Account, amount: u128, msg: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(c.token.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": c.cf.id(), "amount": amount.to_string(), "msg": msg.to_string()}))
        .deposit(YOCTO)
        .max_gas()
        .transact()
        .await?)
}

async fn invest(c: &Ctx, from: &Account, pool_id: u64, tranche: &str, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
    ft_call(c, from, amount, json!({"invest": {"pool_id": pool_id, "tranche": tranche}})).await
}

async fn pay(c: &Ctx, from: &Account, order_id: u64, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
    ft_call(c, from, amount, json!({"pay": {"order_id": order_id}})).await
}

async fn create_order(c: &Ctx, amount: u128, due_ns: u64) -> anyhow::Result<u64> {
    Ok(c.merchant
        .call(c.cf.id(), "create_order")
        .args_json(json!({"amount": amount.to_string(), "currency": "USDC", "due_date": due_ns.to_string(),
                          "invoice_no": "INV-1", "customer_hash": "h"}))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

async fn approve(c: &Ctx, id: u64) -> anyhow::Result<()> {
    c.customer.call(c.cf.id(), "approve_receipt").args_json(json!({"id": id})).transact().await?.into_result()?;
    Ok(())
}

async fn attest(c: &Ctx, id: u64) -> anyhow::Result<()> {
    c.agent
        .call(c.cf.id(), "attest_receipt")
        .args_json(json!({"id": id, "verdict": "Approve", "score": 85, "reason_hash": "r"}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn create_pool(c: &Ctx, ids: &[u64]) -> anyhow::Result<ExecutionFinalResult> {
    Ok(c.merchant.call(c.cf.id(), "create_pool").args_json(json!({"order_ids": ids})).transact().await?)
}

/// Order of 1,000 approved, attested and pooled. Returns (order_id, pool_id).
async fn funding_pool(c: &Ctx, due_ns: u64) -> anyhow::Result<(u64, u64)> {
    let id = create_order(c, usdc(1_000.0), due_ns).await?;
    approve(c, id).await?;
    attest(c, id).await?;
    let pool_id: u64 = create_pool(c, &[id]).await?.into_result()?.json()?;
    Ok((id, pool_id))
}

/// Pool funded by alice (senior 600) and bob (junior 200).
async fn active_pool(c: &Ctx, due_ns: u64) -> anyhow::Result<(u64, u64)> {
    let (id, pool_id) = funding_pool(c, due_ns).await?;
    invest(c, &c.alice, pool_id, "Senior", usdc(600.0)).await?.into_result()?;
    invest(c, &c.bob, pool_id, "Junior", usdc(200.0)).await?.into_result()?;
    assert_eq!(view(c, "get_pool", json!({"id": pool_id})).await?["status"], "Active");
    Ok((id, pool_id))
}

async fn position_of(c: &Ctx, owner: &Account) -> anyhow::Result<Value> {
    let v = view(c, "get_positions_by_owner", json!({"owner": owner.id()})).await?;
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 1, "expected one position for {}: {v}", owner.id());
    Ok(arr[0].clone())
}

async fn claim(c: &Ctx, who: &Account, token_id: &str) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who.call(c.cf.id(), "claim").args_json(json!({"token_id": token_id})).max_gas().transact().await?)
}

async fn due_in(c: &Ctx, ns: u64) -> anyhow::Result<u64> {
    Ok(now_ns(c).await? + ns)
}

/// Advance sandbox time until the block timestamp passes `t`.
async fn advance_past(c: &Ctx, t: u64) -> anyhow::Result<()> {
    for _ in 0..200 {
        if now_ns(c).await? > t {
            return Ok(());
        }
        c.worker.fast_forward(100).await?;
    }
    anyhow::bail!("sandbox clock did not pass {t}")
}

// ---------- 1. orders ----------

#[tokio::test]
async fn t1_order_rules() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let id = create_order(&c, usdc(1_000.0), due_in(&c, DAY_NS).await?).await?;

    let out = c.merchant.call(c.cf.id(), "approve_receipt").args_json(json!({"id": id})).transact().await?;
    assert_fails(&out, "Merchant cannot approve own order");

    // Pending, then customer-approved but not attested: neither can be pooled.
    assert_fails(&create_pool(&c, &[id]).await?, "Order not approved by underwriter");
    approve(&c, id).await?;
    assert_fails(&create_pool(&c, &[id]).await?, "Order not approved by underwriter");

    attest(&c, id).await?;
    assert!(create_pool(&c, &[id]).await?.is_success());
    Ok(())
}

// ---------- 2. terms ----------

#[tokio::test]
async fn t2_pool_terms() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let (_, pool_id) = funding_pool(&c, due_in(&c, DAY_NS).await?).await?;
    let p = view(&c, "get_pool", json!({"id": pool_id})).await?;
    assert_eq!(p["status"], "Funding");
    assert_eq!(p["tier"], "B");
    for (field, want) in [
        ("advance", 800.0), ("fee", 8.0), ("claim", 850.0), ("senior_face", 637.5),
        ("junior_face", 212.5), ("senior_target", 600.0), ("junior_target", 200.0),
    ] {
        assert_eq!(u(&p, field), usdc(want), "{field}");
    }
    Ok(())
}

// ---------- 3. funding and activation ----------

#[tokio::test]
async fn t3_invest_activate_advance() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let (_, pool_id) = funding_pool(&c, due_in(&c, DAY_NS).await?).await?;
    let alice0 = balance(&c, c.alice.id()).await?;

    // 650 into a 600 senior target: 50 comes back.
    invest(&c, &c.alice, pool_id, "Senior", usdc(650.0)).await?.into_result()?;
    assert_eq!(balance(&c, c.alice.id()).await?, alice0 - usdc(600.0));
    assert_eq!(view(&c, "get_pool", json!({"id": pool_id})).await?["status"], "Funding");
    assert_eq!(balance(&c, c.merchant.id()).await?, 0);

    invest(&c, &c.bob, pool_id, "Junior", usdc(200.0)).await?.into_result()?;
    let p = view(&c, "get_pool", json!({"id": pool_id})).await?;
    assert_eq!(p["status"], "Active");
    assert_eq!(balance(&c, c.merchant.id()).await?, usdc(792.0));

    let ins = view(&c, "get_insurance", json!({})).await?;
    assert_eq!(u(&ins, "balance"), usdc(4.0));
    assert_eq!(u(&ins, "treasury"), usdc(4.0));
    // 800 in, 792 out: the 8 fee stays in the contract.
    assert_eq!(balance(&c, c.cf.id()).await?, usdc(8.0));

    let supply: String = c.cf.view("nft_total_supply").args_json(json!({})).await?.json()?;
    assert_eq!(supply, "2");
    let a = position_of(&c, &c.alice).await?;
    let b = position_of(&c, &c.bob).await?;
    assert_eq!((a["tranche"].as_str(), u(&a, "amount")), (Some("Senior"), usdc(600.0)));
    assert_eq!((b["tranche"].as_str(), u(&b, "amount")), (Some("Junior"), usdc(200.0)));
    Ok(())
}

// ---------- 4. payments and the waterfall ----------

#[tokio::test]
async fn t4_waterfall_and_overpayment() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let (id, pool_id) = active_pool(&c, due_in(&c, DAY_NS).await?).await?;
    let cust0 = balance(&c, c.customer.id()).await?;

    pay(&c, &c.customer, id, usdc(500.0)).await?.into_result()?;
    let p = view(&c, "get_pool", json!({"id": pool_id})).await?;
    assert_eq!((u(&p, "senior_repaid"), u(&p, "junior_repaid"), u(&p, "residual_paid")), (usdc(500.0), 0, 0));

    let merchant_before = balance(&c, c.merchant.id()).await?;
    pay(&c, &c.customer, id, usdc(500.0)).await?.into_result()?;
    let p = view(&c, "get_pool", json!({"id": pool_id})).await?;
    assert_eq!(u(&p, "senior_repaid"), usdc(637.5));
    assert_eq!(u(&p, "junior_repaid"), usdc(212.5));
    assert_eq!(u(&p, "residual_paid"), usdc(150.0));
    assert_eq!(p["status"], "Repaid");
    assert_eq!(balance(&c, c.merchant.id()).await?, merchant_before + usdc(150.0));
    assert_eq!(view(&c, "get_order", json!({"id": id})).await?["status"], "Paid");

    // Order is settled: any further payment comes straight back.
    pay(&c, &c.customer, id, usdc(10.0)).await?.into_result()?;
    assert_eq!(balance(&c, c.customer.id()).await?, cust0 - usdc(1_000.0));
    Ok(())
}

#[tokio::test]
async fn t4b_overpayment_capped_at_owed() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let (id, _) = active_pool(&c, due_in(&c, DAY_NS).await?).await?;
    let cust0 = balance(&c, c.customer.id()).await?;
    pay(&c, &c.customer, id, usdc(1_100.0)).await?.into_result()?;
    assert_eq!(balance(&c, c.customer.id()).await?, cust0 - usdc(1_000.0));
    assert_eq!(u(&view(&c, "get_order", json!({"id": id})).await?, "paid"), usdc(1_000.0));
    Ok(())
}

// ---------- 5. claims ----------

#[tokio::test]
async fn t5_claims_follow_the_nft() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let (id, _) = active_pool(&c, due_in(&c, DAY_NS).await?).await?;
    let senior = position_of(&c, &c.alice).await?["token_id"].as_str().unwrap().to_string();
    let junior = position_of(&c, &c.bob).await?["token_id"].as_str().unwrap().to_string();

    pay(&c, &c.customer, id, usdc(500.0)).await?.into_result()?;
    assert_fails(&claim(&c, &c.carol, &senior).await?, "Only the position owner can claim");

    let a0 = balance(&c, c.alice.id()).await?;
    claim(&c, &c.alice, &senior).await?.into_result()?;
    assert_eq!(balance(&c, c.alice.id()).await?, a0 + usdc(500.0));
    // Nothing new has arrived: the second claim pays 0.
    assert_fails(&claim(&c, &c.alice, &senior).await?, "Nothing to claim");
    assert_eq!(balance(&c, c.alice.id()).await?, a0 + usdc(500.0));

    pay(&c, &c.customer, id, usdc(500.0)).await?.into_result()?;
    claim(&c, &c.alice, &senior).await?.into_result()?;
    assert_eq!(balance(&c, c.alice.id()).await?, a0 + usdc(637.5));

    // The junior position changes hands; only the new holder can claim it.
    c.bob
        .call(c.cf.id(), "nft_transfer")
        .args_json(json!({"receiver_id": c.carol.id(), "token_id": junior}))
        .deposit(YOCTO)
        .transact()
        .await?
        .into_result()?;
    assert_fails(&claim(&c, &c.bob, &junior).await?, "Only the position owner can claim");
    let carol0 = balance(&c, c.carol.id()).await?;
    claim(&c, &c.carol, &junior).await?.into_result()?;
    assert_eq!(balance(&c, c.carol.id()).await?, carol0 + usdc(212.5));
    Ok(())
}

// ---------- 6. failed advance ----------

#[tokio::test]
async fn t6_unregistered_merchant_advance_reverts() -> anyhow::Result<()> {
    let c = setup(Opts { register_merchant: false, ..Opts::default() }).await?;
    let (_, pool_id) = funding_pool(&c, due_in(&c, DAY_NS).await?).await?;
    invest(&c, &c.alice, pool_id, "Senior", usdc(600.0)).await?.into_result()?;
    let out = invest(&c, &c.bob, pool_id, "Junior", usdc(200.0)).await?;
    assert_receipt_fails(&out, "is not registered");

    assert_eq!(view(&c, "get_pool", json!({"id": pool_id})).await?["status"], "Funding");
    let ins = view(&c, "get_insurance", json!({})).await?;
    assert_eq!((u(&ins, "balance"), u(&ins, "treasury")), (0, 0));
    assert_eq!(balance(&c, c.cf.id()).await?, usdc(800.0));

    register(&c.token, &c.merchant, c.merchant.id()).await?;
    c.carol.call(c.cf.id(), "retry_advance").args_json(json!({"pool_id": pool_id})).max_gas().transact().await?.into_result()?;
    assert_eq!(view(&c, "get_pool", json!({"id": pool_id})).await?["status"], "Active");
    assert_eq!(balance(&c, c.merchant.id()).await?, usdc(792.0));
    let ins = view(&c, "get_insurance", json!({})).await?;
    assert_eq!((u(&ins, "balance"), u(&ins, "treasury")), (usdc(4.0), usdc(4.0)));
    Ok(())
}

// ---------- 7. default and insurance ----------

/// Active pool, 700 paid, 500 seeded into insurance. Returns (pool_id, due).
async fn defaultable(c: &Ctx) -> anyhow::Result<(u64, u64)> {
    let due = due_in(c, 5_000_000_000).await?;
    let (id, pool_id) = active_pool(c, due).await?;
    pay(c, &c.customer, id, usdc(700.0)).await?.into_result()?;
    ft_call(c, &c.carol, usdc(500.0), json!({"seed_insurance": {}})).await?.into_result()?;
    assert_eq!(u(&view(c, "get_insurance", json!({})).await?, "balance"), usdc(504.0));
    Ok((pool_id, due))
}

#[tokio::test]
async fn t7_default_cover_within_threshold() -> anyhow::Result<()> {
    let grace = 5_000_000_000;
    let c = setup(Opts { grace_ns: grace, dao_threshold: usdc(100.0), ..Opts::default() }).await?;
    let (pool_id, due) = defaultable(&c).await?;

    let early = c.carol.call(c.cf.id(), "mark_default").args_json(json!({"pool_id": pool_id})).transact().await?;
    assert_fails(&early, "Grace period not over");

    advance_past(&c, due + grace).await?;
    c.carol.call(c.cf.id(), "mark_default").args_json(json!({"pool_id": pool_id})).transact().await?.into_result()?;

    let p = view(&c, "get_pool", json!({"id": pool_id})).await?;
    assert_eq!(p["status"], "Defaulted");
    assert_eq!(u(&p, "insurance_paid"), usdc(100.0));
    assert_eq!(u(&p, "pending_cover"), 0);
    let ins = view(&c, "get_insurance", json!({})).await?;
    assert_eq!((u(&ins, "balance"), u(&ins, "total_paid")), (usdc(404.0), usdc(100.0)));
    assert_eq!(u(&position_of(&c, &c.alice).await?, "claimable"), usdc(637.5));
    assert_eq!(u(&position_of(&c, &c.bob).await?, "claimable"), usdc(162.5));
    Ok(())
}

#[tokio::test]
async fn t7b_default_cover_above_threshold_waits_for_dao() -> anyhow::Result<()> {
    let grace = 5_000_000_000;
    let c = setup(Opts { grace_ns: grace, dao_threshold: usdc(50.0), ..Opts::default() }).await?;
    let (pool_id, due) = defaultable(&c).await?;
    advance_past(&c, due + grace).await?;
    c.carol.call(c.cf.id(), "mark_default").args_json(json!({"pool_id": pool_id})).transact().await?.into_result()?;

    let p = view(&c, "get_pool", json!({"id": pool_id})).await?;
    assert_eq!((u(&p, "pending_cover"), u(&p, "insurance_paid")), (usdc(100.0), 0));
    // Cover is reserved but not yet paid.
    let ins = view(&c, "get_insurance", json!({})).await?;
    assert_eq!((u(&ins, "balance"), u(&ins, "total_paid")), (usdc(404.0), 0));
    assert_eq!(u(&position_of(&c, &c.bob).await?, "claimable"), usdc(62.5));

    let out = c.carol.call(c.cf.id(), "approve_cover").args_json(json!({"pool_id": pool_id})).transact().await?;
    assert_fails(&out, "Only the DAO");
    c.dao.call(c.cf.id(), "approve_cover").args_json(json!({"pool_id": pool_id})).transact().await?.into_result()?;

    assert_eq!(u(&view(&c, "get_pool", json!({"id": pool_id})).await?, "pending_cover"), 0);
    assert_eq!(u(&position_of(&c, &c.alice).await?, "claimable"), usdc(637.5));
    assert_eq!(u(&position_of(&c, &c.bob).await?, "claimable"), usdc(162.5));
    Ok(())
}

// ---------- 8. agent-only calls and tiers ----------

#[tokio::test]
async fn t8_agent_only_and_tier_c() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let id = create_order(&c, usdc(1_000.0), due_in(&c, DAY_NS).await?).await?;
    approve(&c, id).await?;

    let out = c.merchant
        .call(c.cf.id(), "attest_receipt")
        .args_json(json!({"id": id, "verdict": "Approve", "score": 99, "reason_hash": "r"}))
        .transact()
        .await?;
    assert_fails(&out, "Only the underwriter agent");
    let out = c.merchant
        .call(c.cf.id(), "set_merchant_tier")
        .args_json(json!({"merchant": c.merchant.id(), "tier": "A"}))
        .transact()
        .await?;
    assert_fails(&out, "Only the underwriter agent");
    assert_eq!(view(&c, "get_tier", json!({"merchant": c.merchant.id()})).await?, "B");

    c.agent
        .call(c.cf.id(), "set_merchant_tier")
        .args_json(json!({"merchant": c.merchant.id(), "tier": "C"}))
        .transact()
        .await?
        .into_result()?;
    attest(&c, id).await?;
    let pool_id: u64 = create_pool(&c, &[id]).await?.into_result()?.json()?;
    let p = view(&c, "get_pool", json!({"id": pool_id})).await?;
    assert_eq!(p["tier"], "C");
    assert_eq!(u(&p, "advance"), usdc(700.0));
    Ok(())
}

// ---------- 9. only the configured token ----------

#[tokio::test]
async fn t9_ft_on_transfer_rejects_other_callers() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let (_, pool_id) = funding_pool(&c, due_in(&c, DAY_NS).await?).await?;

    // Direct call by a user.
    let out = c.alice
        .call(c.cf.id(), "ft_on_transfer")
        .args_json(json!({"sender_id": c.alice.id(), "amount": usdc(600.0).to_string(),
                          "msg": json!({"invest": {"pool_id": pool_id, "tranche": "Senior"}}).to_string()}))
        .transact()
        .await?;
    assert_fails(&out, "Only the configured USDC token");

    // A look-alike token: our receiver panics, the fake token refunds its sender.
    let (_, token_wasm) = wasms().await;
    let fake = c.worker.dev_deploy(token_wasm).await?;
    fake.call("new").transact().await?.into_result()?;
    for id in [c.alice.id(), c.cf.id()] {
        register(&fake, &c.alice, id).await?;
    }
    fake.call("mint").args_json(json!({"account_id": c.alice.id(), "amount": usdc(600.0).to_string()})).transact().await?.into_result()?;
    let out = c.alice
        .call(fake.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": c.cf.id(), "amount": usdc(600.0).to_string(),
                          "msg": json!({"invest": {"pool_id": pool_id, "tranche": "Senior"}}).to_string()}))
        .deposit(YOCTO)
        .max_gas()
        .transact()
        .await?;
    assert_receipt_fails(&out, "Only the configured USDC token");

    let p = view(&c, "get_pool", json!({"id": pool_id})).await?;
    assert_eq!(u(&p, "senior_funded"), 0);
    let supply: String = c.cf.view("nft_total_supply").args_json(json!({})).await?.json()?;
    assert_eq!(supply, "0");
    let fake_bal: String = fake.view("ft_balance_of").args_json(json!({"account_id": c.alice.id()})).await?.json()?;
    assert_eq!(fake_bal, usdc(600.0).to_string());
    Ok(())
}

// ---------- 10. position NFTs render live state ----------

#[tokio::test]
async fn t10_nft_card_tracks_claimable() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let (id, _) = active_pool(&c, due_in(&c, DAY_NS).await?).await?;
    let token_id = position_of(&c, &c.alice).await?["token_id"].as_str().unwrap().to_string();
    let card = |t: &Value| -> (String, Value) {
        let m = &t["metadata"];
        (m["media"].as_str().unwrap().to_string(), serde_json::from_str(m["extra"].as_str().unwrap()).unwrap())
    };

    let (media, extra) = card(&view(&c, "nft_token", json!({"token_id": token_id})).await?);
    assert!(media.starts_with("data:image/svg+xml;charset=utf-8,%3Csvg"), "{media}");
    assert!(media.contains("SENIOR") && media.contains("ACTIVE"), "{media}");
    assert!(media.contains("Claimable now%3C/text%3E") && media.contains("%3E0 USDC%3C"), "{media}");
    assert_eq!((extra["claimable"].as_str(), extra["pool_status"].as_str()), (Some("0"), Some("Active")));

    pay(&c, &c.customer, id, usdc(500.0)).await?.into_result()?;
    let (media, extra) = card(&view(&c, "nft_token", json!({"token_id": token_id})).await?);
    assert!(media.contains("%3E500 USDC%3C"), "{media}");
    assert_eq!(extra["claimable"].as_str(), Some(usdc(500.0).to_string().as_str()));

    // Enumeration views carry the same card.
    let owned = view(&c, "nft_tokens_for_owner", json!({"account_id": c.alice.id()})).await?;
    assert_eq!(card(&owned[0]).0, media);
    Ok(())
}
