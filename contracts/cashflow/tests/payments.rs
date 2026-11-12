//! Sandbox tests: payments, the waterfall and overpayment refunds.

mod common;

use common::*;

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
