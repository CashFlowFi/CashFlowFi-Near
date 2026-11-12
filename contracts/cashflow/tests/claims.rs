//! Sandbox tests: claims follow the position NFT, including transfers mid-payout.

mod common;

use common::*;

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

// ---------- 11. transfer mid-payout ----------

#[tokio::test]
async fn t11_transfer_mid_payout() -> anyhow::Result<()> {
    let c = setup(Opts::default()).await?;
    let (id, _) = active_pool(&c, due_in(&c, DAY_NS).await?).await?;
    let senior = position_of(&c, &c.alice).await?["token_id"].as_str().unwrap().to_string();
    let junior = position_of(&c, &c.bob).await?["token_id"].as_str().unwrap().to_string();
    let pos = |t: &str| view(&c, "get_position", json!({"token_id": t}));
    let transfer = |from: &Account, to: &Account, t: &str| {
        from.call(c.cf.id(), "nft_transfer").args_json(json!({"receiver_id": to.id(), "token_id": t})).deposit(YOCTO).transact()
    };

    // First 500 all goes to senior; alice claims it, then sells the position to carol.
    pay(&c, &c.customer, id, usdc(500.0)).await?.into_result()?;
    let a0 = balance(&c, c.alice.id()).await?;
    claim(&c, &c.alice, &senior).await?.into_result()?;
    assert_eq!(balance(&c, c.alice.id()).await?, a0 + usdc(500.0));
    transfer(&c.alice, &c.carol, &senior).await?.into_result()?;

    // Second 500: senior is owed the 137.5 remainder, junior its full 212.5 (still unclaimed by bob).
    pay(&c, &c.customer, id, usdc(500.0)).await?.into_result()?;
    let j = pos(&junior).await?;
    assert_eq!((u(&j, "claimed"), u(&j, "claimable")), (0, usdc(212.5)));
    // Bob sells the junior position with its accrued payout unclaimed.
    transfer(&c.bob, &c.carol, &junior).await?.into_result()?;

    // Previous holders can no longer claim.
    assert_fails(&claim(&c, &c.alice, &senior).await?, "Only the position owner can claim");
    assert_fails(&claim(&c, &c.bob, &junior).await?, "Only the position owner can claim");
    let b0 = balance(&c, c.bob.id()).await?;

    // Carol gets only the senior remainder, not alice's 500 again.
    let k0 = balance(&c, c.carol.id()).await?;
    claim(&c, &c.carol, &senior).await?.into_result()?;
    assert_eq!(balance(&c, c.carol.id()).await?, k0 + usdc(137.5));
    let s = pos(&senior).await?;
    assert_eq!((u(&s, "claimed"), u(&s, "claimable"), s["owner"].as_str().unwrap()), (usdc(637.5), 0, c.carol.id().as_str()));
    assert_fails(&claim(&c, &c.carol, &senior).await?, "Nothing to claim");

    // The unclaimed junior payout moved with the NFT: carol receives what accrued under bob.
    claim(&c, &c.carol, &junior).await?.into_result()?;
    assert_eq!(balance(&c, c.carol.id()).await?, k0 + usdc(137.5) + usdc(212.5));
    let j = pos(&junior).await?;
    assert_eq!((u(&j, "claimed"), u(&j, "claimable")), (usdc(212.5), 0));
    assert_eq!(balance(&c, c.bob.id()).await?, b0);
    Ok(())
}
