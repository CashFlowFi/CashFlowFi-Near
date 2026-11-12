//! Cashflow Fi core contract (NEAR testnet).
//!
//! One contract holds orders, pools, insurance and the NEP-171 position NFTs, so claims read the
//! token owner locally and need no cross-contract hop. All pool maths lives in `cashflow-core`.
//! All money arrives through the USDC token's `ft_transfer_call` (see docs/INTERFACE.md).

use cashflow_core as core;
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use std::collections::HashMap;

const GAS_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_CALLBACK: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Orders,
    Pools,
    Positions,
    Tiers,
    Withdrawable,
    NftOwners,
    NftMetadata,
    NftEnumeration,
}

// ---------- public types (JSON + Borsh) ----------

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum OrderStatus { Pending, CustomerApproved, Attested, Rejected, Pooled, Paid }

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Verdict { Approve, Flag, Reject }

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PoolStatus { Funding, Active, Repaid, Defaulted }

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tranche { Senior, Junior }

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tier { A, B, C, D }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Order {
    pub id: u64,
    pub merchant: AccountId,
    pub customer: Option<AccountId>,
    pub amount: U128,
    pub currency: String,
    pub due_date: U64,
    pub invoice_no: String,
    pub customer_hash: String,
    pub status: OrderStatus,
    pub verdict: Option<Verdict>,
    pub score: Option<u8>,
    pub reason_hash: Option<String>,
    pub paid: U128,
    pub pool_id: Option<u64>,
    pub created_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Pool {
    pub id: u64,
    pub merchant: AccountId,
    pub order_ids: Vec<u64>,
    pub tier: Tier,
    pub receivable: U128,
    pub advance: U128,
    pub fee: U128,
    pub claim: U128,
    pub senior_face: U128,
    pub junior_face: U128,
    pub senior_target: U128,
    pub junior_target: U128,
    pub senior_funded: U128,
    pub junior_funded: U128,
    pub senior_repaid: U128,
    pub junior_repaid: U128,
    pub residual_paid: U128,
    pub insurance_paid: U128,
    pub insurance_refilled: U128,
    pub pending_cover: U128,
    pub status: PoolStatus,
    pub due_date: U64,
    pub created_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PositionRecord {
    pub pool_id: u64,
    pub tranche: Tranche,
    pub amount: U128,
    pub claimed: U128,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub token_id: TokenId,
    pub pool_id: u64,
    pub tranche: Tranche,
    pub amount: U128,
    pub claimed: U128,
    pub claimable: U128,
    pub owner: AccountId,
}

#[near(serializers = [json])]
pub struct InsuranceView { pub balance: U128, pub total_paid: U128, pub treasury: U128 }

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
enum TransferMsg {
    Invest { pool_id: u64, tranche: Tranche },
    Pay { order_id: u64 },
    Repay { pool_id: u64 },
    SeedInsurance {},
}

// ---------- conversions to the pure engine ----------

impl From<Tier> for core::Tier {
    fn from(t: Tier) -> Self { match t { Tier::A => core::Tier::A, Tier::B => core::Tier::B, Tier::C => core::Tier::C, Tier::D => core::Tier::D } }
}
impl From<Tranche> for core::Tranche {
    fn from(t: Tranche) -> Self { match t { Tranche::Senior => core::Tranche::Senior, Tranche::Junior => core::Tranche::Junior } }
}

impl Pool {
    fn engine(&self) -> core::PoolState {
        let terms = core::terms(self.receivable.0, self.tier.into()).expect("bad terms");
        core::PoolState {
            terms,
            status: match self.status {
                PoolStatus::Funding => core::PoolStatus::Funding,
                PoolStatus::Active => core::PoolStatus::Active,
                PoolStatus::Repaid => core::PoolStatus::Repaid,
                PoolStatus::Defaulted => core::PoolStatus::Defaulted,
            },
            senior_funded: self.senior_funded.0,
            junior_funded: self.junior_funded.0,
            senior_repaid: self.senior_repaid.0,
            junior_repaid: self.junior_repaid.0,
            residual_paid: self.residual_paid.0,
            insurance_paid: self.insurance_paid.0,
            insurance_refilled: self.insurance_refilled.0,
        }
    }
    fn store(&mut self, s: &core::PoolState) {
        self.status = match s.status {
            core::PoolStatus::Funding => PoolStatus::Funding,
            core::PoolStatus::Active => PoolStatus::Active,
            core::PoolStatus::Repaid => PoolStatus::Repaid,
            core::PoolStatus::Defaulted => PoolStatus::Defaulted,
        };
        self.senior_funded = U128(s.senior_funded);
        self.junior_funded = U128(s.junior_funded);
        self.senior_repaid = U128(s.senior_repaid);
        self.junior_repaid = U128(s.junior_repaid);
        self.residual_paid = U128(s.residual_paid);
        self.insurance_paid = U128(s.insurance_paid);
        self.insurance_refilled = U128(s.insurance_refilled);
    }
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard": "cashflow", "version": "1.0.0", "event": event, "data": [data]})
    ));
}

// ---------- contract ----------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    token_id: AccountId,
    agent_id: AccountId,
    dao_id: AccountId,
    grace_ns: u64,
    dao_threshold: u128,
    paused: bool,
    orders: IterableMap<u64, Order>,
    pools: IterableMap<u64, Pool>,
    positions: LookupMap<TokenId, PositionRecord>,
    tiers: LookupMap<AccountId, Tier>,
    /// Residual payouts whose transfer failed; the merchant can withdraw them.
    withdrawable: LookupMap<AccountId, u128>,
    next_order: u64,
    next_pool: u64,
    next_token: u64,
    insurance_balance: u128,
    insurance_total_paid: u128,
    treasury_accrued: u128,
    tokens: NonFungibleToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new(token_id: AccountId, agent_id: AccountId, dao_id: AccountId, grace_ns: U64, dao_threshold: U128) -> Self {
        let owner_id = env::predecessor_account_id();
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NftOwners,
                env::current_account_id(),
                Some(StorageKey::NftMetadata),
                Some(StorageKey::NftEnumeration),
                None::<StorageKey>,
            ),
            owner_id,
            token_id,
            agent_id,
            dao_id,
            grace_ns: grace_ns.0,
            dao_threshold: dao_threshold.0,
            paused: false,
            orders: IterableMap::new(StorageKey::Orders),
            pools: IterableMap::new(StorageKey::Pools),
            positions: LookupMap::new(StorageKey::Positions),
            tiers: LookupMap::new(StorageKey::Tiers),
            withdrawable: LookupMap::new(StorageKey::Withdrawable),
            next_order: 1,
            next_pool: 1,
            next_token: 1,
            insurance_balance: 0,
            insurance_total_paid: 0,
            treasury_accrued: 0,
        }
    }

    // ----- orders -----

    pub fn create_order(&mut self, amount: U128, currency: String, due_date: U64, invoice_no: String, customer_hash: String) -> u64 {
        require!(!self.paused, "Paused");
        require!(amount.0 > 0, "Amount must be positive");
        require!(due_date.0 > env::block_timestamp(), "Due date must be in the future");
        require!(invoice_no.len() <= 64 && currency.len() <= 16 && customer_hash.len() <= 128, "Field too long");
        let id = self.next_order;
        self.next_order += 1;
        let merchant = env::predecessor_account_id();
        self.orders.insert(id, Order {
            id, merchant: merchant.clone(), customer: None, amount, currency, due_date, invoice_no, customer_hash,
            status: OrderStatus::Pending, verdict: None, score: None, reason_hash: None,
            paid: U128(0), pool_id: None, created_at: U64(env::block_timestamp()),
        });
        emit("order_created", json!({"order_id": id, "merchant": merchant, "amount": amount}));
        id
    }

    pub fn approve_receipt(&mut self, id: u64) {
        let caller = env::predecessor_account_id();
        let order = self.orders.get_mut(&id).unwrap_or_else(|| env::panic_str("Order not found"));
        require!(order.status == OrderStatus::Pending, "Order is not pending");
        require!(caller != order.merchant, "Merchant cannot approve own order");
        order.customer = Some(caller.clone());
        order.status = OrderStatus::CustomerApproved;
        emit("receipt_approved", json!({"order_id": id, "customer": caller}));
    }

    pub fn attest_receipt(&mut self, id: u64, verdict: Verdict, score: u8, reason_hash: String) {
        require!(env::predecessor_account_id() == self.agent_id, "Only the underwriter agent");
        require!(!self.paused, "Paused");
        require!(score <= 100, "Score out of range");
        let order = self.orders.get_mut(&id).unwrap_or_else(|| env::panic_str("Order not found"));
        require!(order.status == OrderStatus::CustomerApproved, "Order is not customer-approved");
        order.verdict = Some(verdict);
        order.score = Some(score);
        order.reason_hash = Some(reason_hash);
        order.status = if verdict == Verdict::Reject { OrderStatus::Rejected } else { OrderStatus::Attested };
        emit("receipt_attested", json!({"order_id": id, "verdict": verdict, "score": score}));
    }

    pub fn override_attestation(&mut self, id: u64, verdict: Verdict) {
        self.assert_owner();
        let order = self.orders.get_mut(&id).unwrap_or_else(|| env::panic_str("Order not found"));
        require!(matches!(order.status, OrderStatus::Attested | OrderStatus::Rejected), "Order not attested");
        order.verdict = Some(verdict);
        order.status = if verdict == Verdict::Reject { OrderStatus::Rejected } else { OrderStatus::Attested };
    }

    pub fn set_merchant_tier(&mut self, merchant: AccountId, tier: Tier) {
        require!(env::predecessor_account_id() == self.agent_id, "Only the underwriter agent");
        self.tiers.insert(merchant, tier);
    }

    // ----- pools -----

    pub fn create_pool(&mut self, order_ids: Vec<u64>) -> u64 {
        require!(!self.paused, "Paused");
        require!(!order_ids.is_empty() && order_ids.len() <= 20, "1 to 20 orders");
        let merchant = env::predecessor_account_id();
        let pool_id = self.next_pool;
        let mut receivable: u128 = 0;
        let mut due: u64 = 0;
        for id in &order_ids {
            let o = self.orders.get_mut(id).unwrap_or_else(|| env::panic_str("Order not found"));
            require!(o.merchant == merchant, "Not your order");
            require!(o.status == OrderStatus::Attested && o.verdict == Some(Verdict::Approve), "Order not approved by underwriter");
            o.status = OrderStatus::Pooled;
            o.pool_id = Some(pool_id);
            receivable += o.amount.0;
            due = due.max(o.due_date.0);
        }
        let tier = self.tiers.get(&merchant).copied().unwrap_or(Tier::B);
        let t = core::terms(receivable, tier.into()).unwrap_or_else(|_| env::panic_str("Invalid receivable"));
        self.next_pool += 1;
        self.pools.insert(pool_id, Pool {
            id: pool_id, merchant: merchant.clone(), order_ids, tier,
            receivable: U128(receivable), advance: U128(t.advance), fee: U128(t.fee), claim: U128(t.claim),
            senior_face: U128(t.senior_face), junior_face: U128(t.junior_face),
            senior_target: U128(t.senior_target), junior_target: U128(t.junior_target),
            senior_funded: U128(0), junior_funded: U128(0), senior_repaid: U128(0), junior_repaid: U128(0),
            residual_paid: U128(0), insurance_paid: U128(0), insurance_refilled: U128(0), pending_cover: U128(0),
            status: PoolStatus::Funding, due_date: U64(due), created_at: U64(env::block_timestamp()),
        });
        emit("pool_created", json!({"pool_id": pool_id, "merchant": merchant, "receivable": U128(receivable), "advance": U128(t.advance)}));
        pool_id
    }

    /// Retry the advance if its transfer failed (e.g. the merchant was not registered on the token).
    pub fn retry_advance(&mut self, pool_id: u64) -> Promise {
        let pool = self.pools.get_mut(&pool_id).unwrap_or_else(|| env::panic_str("Pool not found"));
        require!(pool.status == PoolStatus::Funding, "Pool not funding");
        require!(pool.senior_funded == pool.senior_target && pool.junior_funded == pool.junior_target, "Pool not full");
        pool.status = PoolStatus::Active;
        let (merchant, advance, fee) = (pool.merchant.clone(), pool.advance.0, pool.fee.0);
        self.pay_advance(pool_id, merchant, advance, fee)
    }

    // ----- claims -----

    pub fn claim(&mut self, token_id: TokenId) -> Promise {
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("Position not found"));
        require!(env::predecessor_account_id() == owner, "Only the position owner can claim");
        let rec = self.positions.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("Position not found"));
        let pool = self.pools.get(&rec.pool_id).unwrap_or_else(|| env::panic_str("Pool not found"));
        let amount = pool.engine().claimable(rec.tranche.into(), rec.amount.0, rec.claimed.0);
        require!(amount > 0, "Nothing to claim");
        self.positions.get_mut(&token_id).unwrap().claimed = U128(rec.claimed.0 + amount);
        emit("claimed", json!({"token_id": token_id, "owner": owner, "amount": U128(amount)}));
        self.ft_transfer(owner, amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_claim(token_id, U128(amount)))
    }

    // ----- default and insurance -----

    pub fn mark_default(&mut self, pool_id: u64) {
        let (dao_threshold, balance) = (self.dao_threshold, self.insurance_balance);
        let pool = self.pools.get_mut(&pool_id).unwrap_or_else(|| env::panic_str("Pool not found"));
        require!(env::block_timestamp() > pool.due_date.0.saturating_add(self.grace_ns), "Grace period not over");
        let mut s = pool.engine();
        let cover = s.default_cover(balance).unwrap_or_else(|_| env::panic_str("Pool not active"));
        s.mark_defaulted().unwrap();
        // Reserve the cover now so two defaults cannot spend the same balance.
        self.insurance_balance -= cover;
        let applied = if cover > 0 && cover <= dao_threshold {
            s.apply_cover(cover).unwrap();
            self.insurance_total_paid += cover;
            true
        } else {
            pool.pending_cover = U128(cover);
            false
        };
        pool.store(&s);
        emit("pool_defaulted", json!({"pool_id": pool_id, "cover": U128(cover), "needs_dao": !applied && cover > 0}));
        if applied {
            emit("insurance_cover", json!({"pool_id": pool_id, "amount": U128(cover)}));
        }
    }

    pub fn approve_cover(&mut self, pool_id: u64) {
        require!(env::predecessor_account_id() == self.dao_id, "Only the DAO");
        let pool = self.pools.get_mut(&pool_id).unwrap_or_else(|| env::panic_str("Pool not found"));
        let cover = pool.pending_cover.0;
        require!(cover > 0, "No pending cover");
        let mut s = pool.engine();
        s.apply_cover(cover).unwrap();
        pool.pending_cover = U128(0);
        pool.store(&s);
        self.insurance_total_paid += cover;
        emit("insurance_cover", json!({"pool_id": pool_id, "amount": U128(cover), "dao": true}));
    }

    // ----- admin -----

    pub fn set_paused(&mut self, paused: bool) { self.assert_owner(); self.paused = paused; }

    pub fn withdraw_residual(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.withdrawable.remove(&who).unwrap_or(0);
        require!(amount > 0, "Nothing to withdraw");
        self.ft_transfer(who.clone(), amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_residual(who, U128(amount)))
    }

    pub fn withdraw_treasury(&mut self, to: AccountId) -> Promise {
        self.assert_owner();
        let amount = std::mem::take(&mut self.treasury_accrued);
        require!(amount > 0, "Nothing to withdraw");
        self.ft_transfer(to, amount)
    }

    // ----- callbacks -----

    #[private]
    pub fn on_advance(&mut self, pool_id: u64, fee: U128) {
        if Self::transfer_ok() {
            if let Some(p) = self.pools.get(&pool_id) {
                emit("pool_activated", json!({"pool_id": pool_id, "merchant": p.merchant, "advance_net": U128(p.advance.0 - fee.0)}));
            }
            return;
        }
        // Undo: back to Funding and un-book the fee, so `retry_advance` can run again.
        let half = fee.0 / 2;
        self.insurance_balance -= half;
        self.treasury_accrued -= fee.0 - half;
        if let Some(pool) = self.pools.get_mut(&pool_id) {
            let mut s = pool.engine();
            s.revert_activation();
            pool.store(&s);
        }
        emit("advance_failed", json!({"pool_id": pool_id}));
    }

    #[private]
    pub fn on_claim(&mut self, token_id: TokenId, amount: U128) {
        if !Self::transfer_ok() {
            if let Some(rec) = self.positions.get_mut(&token_id) {
                rec.claimed = U128(rec.claimed.0 - amount.0);
            }
            emit("claim_failed", json!({"token_id": token_id, "amount": amount}));
        }
    }

    #[private]
    pub fn on_residual(&mut self, merchant: AccountId, amount: U128) {
        if !Self::transfer_ok() {
            let prev = self.withdrawable.get(&merchant).copied().unwrap_or(0);
            self.withdrawable.insert(merchant, prev + amount.0);
        }
    }

    // ----- views -----

    pub fn get_order(&self, id: u64) -> Option<Order> { self.orders.get(&id).cloned() }

    pub fn get_orders(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Order> {
        self.orders.values().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).cloned().collect()
    }

    pub fn get_orders_by_merchant(&self, merchant: AccountId) -> Vec<Order> {
        self.orders.values().filter(|o| o.merchant == merchant).take(100).cloned().collect()
    }

    pub fn get_pool(&self, id: u64) -> Option<Pool> { self.pools.get(&id).cloned() }

    pub fn get_pools(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Pool> {
        self.pools.values().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize).cloned().collect()
    }

    pub fn get_position(&self, token_id: TokenId) -> Option<PositionView> {
        let rec = self.positions.get(&token_id)?;
        let owner = self.tokens.owner_by_id.get(&token_id)?;
        let pool = self.pools.get(&rec.pool_id)?;
        let claimable = pool.engine().claimable(rec.tranche.into(), rec.amount.0, rec.claimed.0);
        Some(PositionView { token_id, pool_id: rec.pool_id, tranche: rec.tranche, amount: rec.amount, claimed: rec.claimed, claimable: U128(claimable), owner })
    }

    pub fn get_positions_by_owner(&self, owner: AccountId) -> Vec<PositionView> {
        self.tokens
            .nft_tokens_for_owner(owner, None, Some(100))
            .into_iter()
            .filter_map(|t| self.get_position(t.token_id))
            .collect()
    }

    pub fn get_insurance(&self) -> InsuranceView {
        InsuranceView { balance: U128(self.insurance_balance), total_paid: U128(self.insurance_total_paid), treasury: U128(self.treasury_accrued) }
    }

    pub fn get_tier(&self, merchant: AccountId) -> Tier { self.tiers.get(&merchant).copied().unwrap_or(Tier::B) }

    pub fn get_withdrawable(&self, account_id: AccountId) -> U128 { U128(self.withdrawable.get(&account_id).copied().unwrap_or(0)) }

    pub fn get_config(&self) -> Value {
        json!({"token_id": self.token_id, "positions_id": env::current_account_id(), "agent_id": self.agent_id,
               "dao_id": self.dao_id, "grace_ns": U64(self.grace_ns), "dao_threshold": U128(self.dao_threshold), "paused": self.paused})
    }
}

// ---------- internal helpers ----------

impl Contract {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only the owner");
    }

    fn transfer_ok() -> bool {
        // TooLong means the call succeeded; only Failed is a failure.
        !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
    }

    fn ft_transfer(&self, to: AccountId, amount: u128) -> Promise {
        ext_ft_core::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(to, U128(amount), Some("cashflow".to_string()))
    }

    /// Book the fee (half insurance, half treasury) and send the net advance to the merchant.
    fn pay_advance(&mut self, pool_id: u64, merchant: AccountId, advance: u128, fee: u128) -> Promise {
        let half = fee / 2;
        self.insurance_balance += half;
        self.treasury_accrued += fee - half;
        self.ft_transfer(merchant, advance - fee)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_advance(pool_id, U128(fee)))
    }

    fn handle_invest(&mut self, sender: AccountId, amount: u128, pool_id: u64, tranche: Tranche) -> u128 {
        let Some(pool) = self.pools.get_mut(&pool_id) else { return amount };
        let mut s = pool.engine();
        let Ok(r) = s.invest(tranche.into(), amount) else { return amount };
        pool.store(&s);
        let (merchant, advance, fee) = (pool.merchant.clone(), pool.advance.0, pool.fee.0);
        if r.accepted > 0 {
            let token_id = format!("{}-{}", pool_id, self.next_token);
            self.next_token += 1;
            self.positions.insert(token_id.clone(), PositionRecord { pool_id, tranche, amount: U128(r.accepted), claimed: U128(0) });
            let title = format!("Cashflow Fi pool #{} {:?} position", pool_id, tranche);
            self.tokens.internal_mint_with_refund(
                token_id.clone(),
                sender.clone(),
                Some(TokenMetadata {
                    title: Some(title),
                    description: Some(format!("{} USDC base units in the {:?} tranche of pool {}. Payouts go to the current holder.", r.accepted, tranche, pool_id)),
                    media: None, media_hash: None, copies: Some(1), issued_at: Some(env::block_timestamp().to_string()),
                    expires_at: None, starts_at: None, updated_at: None, extra: None, reference: None, reference_hash: None,
                }),
                None,
            );
            emit("invested", json!({"pool_id": pool_id, "tranche": tranche, "investor": sender, "amount": U128(r.accepted), "token_id": token_id}));
        }
        if r.activated {
            // Detached promise: the advance is not part of the refund value returned to the token.
            self.pay_advance(pool_id, merchant, advance, fee).detach();
        }
        r.refund
    }

    /// Returns the unused amount. Never panics on a well-formed payment, so funds are not lost.
    fn handle_payment(&mut self, pool_id: u64, amount: u128, order_id: Option<u64>) -> u128 {
        let Some(pool) = self.pools.get_mut(&pool_id) else { return amount };
        let merchant = pool.merchant.clone();
        let mut s = pool.engine();
        let (accepted, split) = match s.status {
            core::PoolStatus::Active | core::PoolStatus::Defaulted => match s.apply_payment(amount) {
                Ok(split) => (amount, split),
                Err(_) => return amount,
            },
            // Faces already covered: everything goes to the merchant as residual.
            core::PoolStatus::Repaid => {
                s.residual_paid += amount;
                (amount, core::Split { merchant: amount, ..Default::default() })
            }
            core::PoolStatus::Funding => return amount,
        };
        pool.store(&s);
        self.insurance_balance += split.insurance_refill;
        emit("payment_applied", json!({"pool_id": pool_id, "order_id": order_id, "amount": U128(accepted),
            "senior": U128(split.senior), "junior": U128(split.junior), "merchant": U128(split.merchant),
            "insurance_refill": U128(split.insurance_refill)}));
        if split.merchant > 0 {
            self.ft_transfer(merchant.clone(), split.merchant)
                .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_residual(merchant, U128(split.merchant)))
                .detach();
        }
        amount - accepted
    }
}

// ---------- NEP-141 receiver: the only way money enters ----------

#[near]
impl FungibleTokenReceiver for Contract {
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token_id, "Only the configured USDC token");
        let refund = match serde_json::from_str::<TransferMsg>(&msg) {
            Ok(TransferMsg::Invest { pool_id, tranche }) => {
                if self.paused { amount.0 } else { self.handle_invest(sender_id, amount.0, pool_id, tranche) }
            }
            Ok(TransferMsg::Pay { order_id }) => {
                // Cap at what is still owed on this order; refund the rest.
                match self.orders.get(&order_id).cloned() {
                    Some(o) if o.status == OrderStatus::Pooled && o.pool_id.is_some() => {
                        let owed = o.amount.0 - o.paid.0;
                        let take = amount.0.min(owed);
                        let unused = if take > 0 { self.handle_payment(o.pool_id.unwrap(), take, Some(order_id)) } else { 0 };
                        let applied = take - unused;
                        let order = self.orders.get_mut(&order_id).unwrap();
                        order.paid = U128(order.paid.0 + applied);
                        if order.paid == order.amount { order.status = OrderStatus::Paid; }
                        amount.0 - applied
                    }
                    _ => amount.0,
                }
            }
            Ok(TransferMsg::Repay { pool_id }) => match self.pools.get(&pool_id) {
                Some(p) if p.merchant == sender_id => self.handle_payment(pool_id, amount.0, None),
                _ => amount.0,
            },
            Ok(TransferMsg::SeedInsurance {}) => {
                self.insurance_balance += amount.0;
                0
            }
            Err(_) => amount.0, // Unknown msg: refund everything rather than lose funds.
        };
        PromiseOrValue::Value(U128(refund))
    }
}

// ---------- NEP-171 (positions) ----------

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: TokenId, approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 { self.tokens.nft_total_supply() }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> { self.tokens.nft_tokens(from_index, limit) }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 { self.tokens.nft_supply_for_owner(account_id) }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Cashflow Fi Positions".to_string(),
            symbol: "CFPOS".to_string(),
            icon: None, base_uri: None, reference: None, reference_hash: None,
        }
    }
}
