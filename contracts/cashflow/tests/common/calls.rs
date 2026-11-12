//! Call and view helpers shared by the sandbox tests.

use super::*;
use near_workspaces::result::ExecutionFinalResult;

pub async fn now_ns(c: &Ctx) -> anyhow::Result<u64> {
    Ok(c.worker.view_block().await?.timestamp())
}

pub async fn balance(c: &Ctx, who: &near_workspaces::AccountId) -> anyhow::Result<u128> {
    let v: String = c.token.view("ft_balance_of").args_json(json!({"account_id": who})).await?.json()?;
    Ok(v.parse()?)
}

pub async fn view(c: &Ctx, method: &str, args: Value) -> anyhow::Result<Value> {
    Ok(c.cf.view(method).args_json(args).await?.json()?)
}

pub fn u(v: &Value, field: &str) -> u128 {
    v[field].as_str().unwrap_or_else(|| panic!("{field} missing in {v}")).parse().unwrap()
}

/// Asserts the call failed and that the failure names `msg`.
pub fn assert_fails(out: &ExecutionFinalResult, msg: &str) {
    assert!(out.is_failure(), "expected failure '{msg}', got success");
    let dbg = format!("{:?}", out.failures());
    assert!(dbg.contains(msg), "expected '{msg}' in failures: {dbg}");
}

/// Asserts some receipt in the transaction failed with `msg` (for failures behind a successful top level).
pub fn assert_receipt_fails(out: &ExecutionFinalResult, msg: &str) {
    let dbg = format!("{:?}", out.receipt_failures());
    assert!(dbg.contains(msg), "expected '{msg}' in receipt failures: {dbg}");
}

pub async fn ft_call(c: &Ctx, from: &Account, amount: u128, msg: Value) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(c.token.id(), "ft_transfer_call")
        .args_json(json!({"receiver_id": c.cf.id(), "amount": amount.to_string(), "msg": msg.to_string()}))
        .deposit(YOCTO)
        .max_gas()
        .transact()
        .await?)
}

pub async fn invest(c: &Ctx, from: &Account, pool_id: u64, tranche: &str, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
    ft_call(c, from, amount, json!({"invest": {"pool_id": pool_id, "tranche": tranche}})).await
}

pub async fn pay(c: &Ctx, from: &Account, order_id: u64, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
    ft_call(c, from, amount, json!({"pay": {"order_id": order_id}})).await
}

pub async fn create_order(c: &Ctx, amount: u128, due_ns: u64) -> anyhow::Result<u64> {
    Ok(c.merchant
        .call(c.cf.id(), "create_order")
        .args_json(json!({"amount": amount.to_string(), "currency": "USDC", "due_date": due_ns.to_string(),
                          "invoice_no": "INV-1", "customer_hash": "h"}))
        .transact()
        .await?
        .into_result()?
        .json()?)
}

pub async fn approve(c: &Ctx, id: u64) -> anyhow::Result<()> {
    c.customer.call(c.cf.id(), "approve_receipt").args_json(json!({"id": id})).transact().await?.into_result()?;
    Ok(())
}

pub async fn attest(c: &Ctx, id: u64) -> anyhow::Result<()> {
    c.agent
        .call(c.cf.id(), "attest_receipt")
        .args_json(json!({"id": id, "verdict": "Approve", "score": 85, "reason_hash": "r"}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

pub async fn create_pool(c: &Ctx, ids: &[u64]) -> anyhow::Result<ExecutionFinalResult> {
    Ok(c.merchant.call(c.cf.id(), "create_pool").args_json(json!({"order_ids": ids})).transact().await?)
}

/// Order of 1,000 approved, attested and pooled. Returns (order_id, pool_id).
pub async fn funding_pool(c: &Ctx, due_ns: u64) -> anyhow::Result<(u64, u64)> {
    let id = create_order(c, usdc(1_000.0), due_ns).await?;
    approve(c, id).await?;
    attest(c, id).await?;
    let pool_id: u64 = create_pool(c, &[id]).await?.into_result()?.json()?;
    Ok((id, pool_id))
}

/// Pool funded by alice (senior 600) and bob (junior 200).
pub async fn active_pool(c: &Ctx, due_ns: u64) -> anyhow::Result<(u64, u64)> {
    let (id, pool_id) = funding_pool(c, due_ns).await?;
    invest(c, &c.alice, pool_id, "Senior", usdc(600.0)).await?.into_result()?;
    invest(c, &c.bob, pool_id, "Junior", usdc(200.0)).await?.into_result()?;
    assert_eq!(view(c, "get_pool", json!({"id": pool_id})).await?["status"], "Active");
    Ok((id, pool_id))
}

pub async fn position_of(c: &Ctx, owner: &Account) -> anyhow::Result<Value> {
    let v = view(c, "get_positions_by_owner", json!({"owner": owner.id()})).await?;
    let arr = v.as_array().unwrap();
    assert_eq!(arr.len(), 1, "expected one position for {}: {v}", owner.id());
    Ok(arr[0].clone())
}

pub async fn claim(c: &Ctx, who: &Account, token_id: &str) -> anyhow::Result<ExecutionFinalResult> {
    Ok(who.call(c.cf.id(), "claim").args_json(json!({"token_id": token_id})).max_gas().transact().await?)
}

pub async fn due_in(c: &Ctx, ns: u64) -> anyhow::Result<u64> {
    Ok(now_ns(c).await? + ns)
}

/// Advance sandbox time until the block timestamp passes `t`.
pub async fn advance_past(c: &Ctx, t: u64) -> anyhow::Result<()> {
    for _ in 0..200 {
        if now_ns(c).await? > t {
            return Ok(());
        }
        c.worker.fast_forward(100).await?;
    }
    anyhow::bail!("sandbox clock did not pass {t}")
}
