//! Money in: the NEP-141 receiver (the only way funds enter) and the repayment waterfall.

use crate::events::emit;
use crate::{core, Contract, ContractExt, OrderStatus, TransferMsg, GAS_CALLBACK};
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, PromiseOrValue};

impl Contract {
    /// Returns the unused amount. Never panics on a well-formed payment, so funds are not lost.
    pub(crate) fn handle_payment(&mut self, pool_id: u64, amount: u128, order_id: Option<u64>) -> u128 {
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
