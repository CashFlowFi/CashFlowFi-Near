//! Sandbox tests: agent-only calls, tiers, and only the configured token may pay in.

mod common;

use common::*;

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
