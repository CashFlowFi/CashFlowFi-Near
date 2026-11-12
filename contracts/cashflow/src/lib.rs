//! Cashflow Fi core contract (NEAR testnet).
//!
//! One contract holds orders, pools, insurance and the NEP-171 position NFTs, so claims read the
//! token owner locally and need no cross-contract hop. All pool maths lives in `cashflow-core`.
//! All money arrives through the USDC token's `ft_transfer_call` (see docs/INTERFACE.md).
//!
//! Layout: `types` (public types), `orders`, `pools`, `payments` (NEP-141 receiver),
//! `claims` (payouts + callbacks), `insurance`, `nft` (NEP-171 + SVG card), `views`, `events`.

use cashflow_core as core;
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::non_fungible_token::{NonFungibleToken, TokenId};
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

mod claims;
mod events;
mod insurance;
mod nft;
mod orders;
mod payments;
mod pools;
mod types;
mod views;

pub use types::*;

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

    // ----- admin -----

    pub fn set_paused(&mut self, paused: bool) { self.assert_owner(); self.paused = paused; }
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
}
