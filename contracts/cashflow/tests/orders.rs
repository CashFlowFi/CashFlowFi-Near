//! Sandbox tests: order rules and pool terms.

mod common;

use common::*;

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
