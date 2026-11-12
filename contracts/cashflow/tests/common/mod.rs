//! Shared sandbox fixture: the real contract and a NEP-141 test token on a local NEAR node.
//! Amounts use 6 decimals, like testnet USDC. Worked example: receivable 1,000, tier B.
//! Each test binary uses a subset of these helpers, hence `allow(dead_code)`.
#![allow(dead_code)]

mod calls;

pub use calls::*;
pub use near_workspaces::Account;
pub use serde_json::{json, Value};

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Contract, Worker};
use tokio::sync::OnceCell;

pub const YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const DAY_NS: u64 = 86_400_000_000_000;

/// USDC with 6 decimals. Exact for every value used here.
pub fn usdc(x: f64) -> u128 {
    (x * 1_000_000.0).round() as u128
}

static WASMS: OnceCell<(Vec<u8>, Vec<u8>)> = OnceCell::const_new();

pub async fn wasms() -> &'static (Vec<u8>, Vec<u8>) {
    WASMS
        .get_or_init(|| async {
            let core = near_workspaces::compile_project("./").await.expect("compile cashflow");
            let token = near_workspaces::compile_project("../test-token").await.expect("compile test-token");
            (core, token)
        })
        .await
}

pub struct Ctx {
    pub worker: Worker<Sandbox>,
    pub token: Contract,
    pub cf: Contract,
    pub merchant: Account,
    pub customer: Account,
    pub agent: Account,
    pub dao: Account,
    pub alice: Account,
    pub bob: Account,
    pub carol: Account,
}

pub struct Opts {
    pub grace_ns: u64,
    pub dao_threshold: u128,
    pub register_merchant: bool,
}

impl Default for Opts {
    fn default() -> Self {
        Self { grace_ns: DAY_NS, dao_threshold: usdc(1_000.0), register_merchant: true }
    }
}

pub async fn setup(opts: Opts) -> anyhow::Result<Ctx> {
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

pub async fn register(token: &Contract, payer: &Account, id: &near_workspaces::AccountId) -> anyhow::Result<()> {
    payer
        .call(token.id(), "storage_deposit")
        .args_json(json!({"account_id": id}))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}
