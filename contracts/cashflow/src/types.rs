//! Public types (JSON + Borsh) and their conversions to the pure `cashflow-core` engine.
//! Stored types are part of the deployed state: keep field order as is.

use crate::core;
use near_contract_standards::non_fungible_token::TokenId;
use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

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
pub(crate) enum TransferMsg {
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
    pub(crate) fn engine(&self) -> core::PoolState {
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
    pub(crate) fn store(&mut self, s: &core::PoolState) {
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
