//! Read-only views used by the frontend, agent and watcher.

use crate::{Contract, ContractExt, InsuranceView, Order, Pool, PositionView, Tier};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, near, AccountId};

#[near]
impl Contract {
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
