//! Money out: position claims, merchant residual and treasury withdrawals, and the
//! transfer callbacks that undo bookkeeping when a token transfer fails.

use crate::events::emit;
use crate::{Contract, ContractExt, GAS_CALLBACK};
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId, Promise};

#[near]
impl Contract {
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

    // ----- withdrawals -----

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
}
