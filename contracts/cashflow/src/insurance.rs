//! Default and insurance: cover up to the DAO threshold applies at once; larger cover waits for the DAO.

use crate::events::emit;
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};

#[near]
impl Contract {
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
}
