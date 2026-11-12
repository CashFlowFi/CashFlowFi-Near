//! Order lifecycle: merchant creates, customer approves, underwriter agent attests.

use crate::events::emit;
use crate::{Contract, ContractExt, Order, OrderStatus, Tier, Verdict};
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

#[near]
impl Contract {
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
}
