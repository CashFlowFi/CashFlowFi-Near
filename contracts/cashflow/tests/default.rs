//! Sandbox tests: default, insurance cover and the DAO threshold.

mod common;

use common::*;

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
