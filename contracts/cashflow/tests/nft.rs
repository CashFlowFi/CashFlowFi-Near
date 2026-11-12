//! Sandbox tests: position NFTs render live state.

mod common;

use common::*;

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
