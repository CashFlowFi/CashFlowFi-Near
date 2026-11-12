//! Pools: bundle approved orders, take tranche investments, pay the advance when full.

use crate::events::emit;
use crate::{core, Contract, ContractExt, OrderStatus, Pool, PoolStatus, PositionRecord, Tier, Tranche, Verdict, GAS_CALLBACK};
use near_contract_standards::non_fungible_token::metadata::TokenMetadata;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Promise};

#[near]
impl Contract {
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
}

impl Contract {
    /// Book the fee (half insurance, half treasury) and send the net advance to the merchant.
    pub(crate) fn pay_advance(&mut self, pool_id: u64, merchant: AccountId, advance: u128, fee: u128) -> Promise {
        let half = fee / 2;
        self.insurance_balance += half;
        self.treasury_accrued += fee - half;
        self.ft_transfer(merchant, advance - fee)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_CALLBACK).on_advance(pool_id, U128(fee)))
    }

    pub(crate) fn handle_invest(&mut self, sender: AccountId, amount: u128, pool_id: u64, tranche: Tranche) -> u128 {
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
}
