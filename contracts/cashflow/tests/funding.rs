//! Sandbox tests: funding, activation and the failed-advance retry.

mod common;

use common::*;

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
