//! Cashflow Fi pool engine.
//!
//! Pure integer accounting with no I/O and no NEAR types, so every rule is unit-tested natively.
//! The `cashflow` contract wraps this engine and adds storage, auth and token transfers.
//! Amounts are token base units (USDC has 6 decimals). Rates are in basis points.

pub const BPS: u128 = 10_000;
pub const ORIGINATION_FEE_BPS: u128 = 100; // 1% of the advance
pub const FINANCING_COST_BPS: u128 = 625; // 6.25% of the advance
pub const SENIOR_SHARE_BPS: u128 = 7_500; // 75% senior, 25% junior
pub const INSURANCE_JUNIOR_CAP_BPS: u128 = 5_000; // cover <= 50% of junior face
pub const INSURANCE_RECEIVABLE_CAP_BPS: u128 = 1_000; // cover <= 10% of the receivable

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    A,
    B,
    C,
    D,
}

impl Tier {
    pub fn ltv_bps(self) -> u128 {
        match self {
            Tier::A => 8_500,
            Tier::B => 8_000,
            Tier::C => 7_000,
            Tier::D => 6_000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tranche {
    Senior,
    Junior,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoolStatus {
    Funding,
    Active,
    Repaid,
    Defaulted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineError {
    ZeroReceivable,
    NotFunding,
    NotPayable,
    NotActive,
    ZeroAmount,
    NothingToCover,
}

/// Terms fixed at pool creation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    pub receivable: u128,
    pub tier: Tier,
    pub advance: u128,
    pub fee: u128,
    pub fee_insurance: u128,
    pub fee_treasury: u128,
    pub merchant_net: u128,
    pub claim: u128,
    pub senior_face: u128,
    pub junior_face: u128,
    pub senior_target: u128,
    pub junior_target: u128,
    pub insurance_cap: u128,
}

pub fn terms(receivable: u128, tier: Tier) -> Result<Terms, EngineError> {
    if receivable == 0 {
        return Err(EngineError::ZeroReceivable);
    }
    let advance = receivable * tier.ltv_bps() / BPS;
    let fee = advance * ORIGINATION_FEE_BPS / BPS;
    let fee_insurance = fee / 2;
    let fee_treasury = fee - fee_insurance;
    let claim = advance + advance * FINANCING_COST_BPS / BPS;
    let senior_face = claim * SENIOR_SHARE_BPS / BPS;
    let junior_face = claim - senior_face;
    let senior_target = advance * SENIOR_SHARE_BPS / BPS;
    let junior_target = advance - senior_target;
    let insurance_cap = (junior_face * INSURANCE_JUNIOR_CAP_BPS / BPS)
        .min(receivable * INSURANCE_RECEIVABLE_CAP_BPS / BPS);
    Ok(Terms {
        receivable,
        tier,
        advance,
        fee,
        fee_insurance,
        fee_treasury,
        merchant_net: advance - fee,
        claim,
        senior_face,
        junior_face,
        senior_target,
        junior_target,
        insurance_cap,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvestResult {
    pub accepted: u128,
    pub refund: u128,
    /// True when this investment filled both tranches: pay the advance now.
    pub activated: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Split {
    pub senior: u128,
    pub junior: u128,
    pub insurance_refill: u128,
    pub merchant: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolState {
    pub terms: Terms,
    pub status: PoolStatus,
    pub senior_funded: u128,
    pub junior_funded: u128,
    pub senior_repaid: u128,
    pub junior_repaid: u128,
    pub residual_paid: u128,
    pub insurance_paid: u128,
    pub insurance_refilled: u128,
}

impl PoolState {
    pub fn new(terms: Terms) -> Self {
        Self {
            terms,
            status: PoolStatus::Funding,
            senior_funded: 0,
            junior_funded: 0,
            senior_repaid: 0,
            junior_repaid: 0,
            residual_paid: 0,
            insurance_paid: 0,
            insurance_refilled: 0,
        }
    }

    pub fn remaining_target(&self, tranche: Tranche) -> u128 {
        match tranche {
            Tranche::Senior => self.terms.senior_target - self.senior_funded,
            Tranche::Junior => self.terms.junior_target - self.junior_funded,
        }
    }

    /// Accept up to the tranche's remaining target and refund the rest.
    pub fn invest(&mut self, tranche: Tranche, amount: u128) -> Result<InvestResult, EngineError> {
        if amount == 0 {
            return Err(EngineError::ZeroAmount);
        }
        if self.status != PoolStatus::Funding {
            return Err(EngineError::NotFunding);
        }
        let accepted = amount.min(self.remaining_target(tranche));
        match tranche {
            Tranche::Senior => self.senior_funded += accepted,
            Tranche::Junior => self.junior_funded += accepted,
        }
        let activated = accepted > 0
            && self.senior_funded == self.terms.senior_target
            && self.junior_funded == self.terms.junior_target;
        if activated {
            self.status = PoolStatus::Active;
        }
        Ok(InvestResult { accepted, refund: amount - accepted, activated })
    }

    /// Undo activation when the advance transfer fails, so the pool can retry.
    pub fn revert_activation(&mut self) {
        if self.status == PoolStatus::Active && self.senior_repaid == 0 && self.junior_repaid == 0 {
            self.status = PoolStatus::Funding;
        }
    }

    /// Run a payment through the waterfall: senior face, junior face, insurance refill, then merchant residual.
    pub fn apply_payment(&mut self, amount: u128) -> Result<Split, EngineError> {
        if amount == 0 {
            return Err(EngineError::ZeroAmount);
        }
        if !matches!(self.status, PoolStatus::Active | PoolStatus::Defaulted) {
            return Err(EngineError::NotPayable);
        }
        let mut rest = amount;
        let senior = rest.min(self.terms.senior_face - self.senior_repaid);
        rest -= senior;
        let junior = rest.min(self.terms.junior_face - self.junior_repaid);
        rest -= junior;
        let insurance_refill = rest.min(self.insurance_paid - self.insurance_refilled);
        rest -= insurance_refill;
        let merchant = rest;

        self.senior_repaid += senior;
        self.junior_repaid += junior;
        self.insurance_refilled += insurance_refill;
        self.residual_paid += merchant;
        if self.fully_repaid() {
            self.status = PoolStatus::Repaid;
        }
        Ok(Split { senior, junior, insurance_refill, merchant })
    }

    pub fn fully_repaid(&self) -> bool {
        self.senior_repaid == self.terms.senior_face && self.junior_repaid == self.terms.junior_face
    }

    pub fn shortfall(&self) -> u128 {
        (self.terms.senior_face + self.terms.junior_face) - (self.senior_repaid + self.junior_repaid)
    }

    /// Cover available on default: min(cap, shortfall, fund balance).
    pub fn default_cover(&self, insurance_balance: u128) -> Result<u128, EngineError> {
        if self.status != PoolStatus::Active {
            return Err(EngineError::NotActive);
        }
        let cover = self.terms.insurance_cap.min(self.shortfall()).min(insurance_balance);
        Ok(cover)
    }

    pub fn mark_defaulted(&mut self) -> Result<(), EngineError> {
        if self.status != PoolStatus::Active {
            return Err(EngineError::NotActive);
        }
        self.status = PoolStatus::Defaulted;
        Ok(())
    }

    /// Apply insurance money through the waterfall (senior first). It is not a customer payment.
    pub fn apply_cover(&mut self, cover: u128) -> Result<Split, EngineError> {
        if self.status != PoolStatus::Defaulted {
            return Err(EngineError::NotActive);
        }
        if cover == 0 {
            return Err(EngineError::NothingToCover);
        }
        let senior = cover.min(self.terms.senior_face - self.senior_repaid);
        let junior = (cover - senior).min(self.terms.junior_face - self.junior_repaid);
        self.senior_repaid += senior;
        self.junior_repaid += junior;
        self.insurance_paid += senior + junior;
        if self.fully_repaid() {
            self.status = PoolStatus::Repaid;
        }
        Ok(Split { senior, junior, insurance_refill: 0, merchant: 0 })
    }

    /// What a position of `amount` in `tranche` is entitled to so far.
    pub fn entitled(&self, tranche: Tranche, amount: u128) -> u128 {
        let (repaid, target) = match tranche {
            Tranche::Senior => (self.senior_repaid, self.terms.senior_target),
            Tranche::Junior => (self.junior_repaid, self.terms.junior_target),
        };
        if target == 0 {
            return 0;
        }
        repaid * amount / target
    }

    pub fn claimable(&self, tranche: Tranche, amount: u128, claimed: u128) -> u128 {
        self.entitled(tranche, amount).saturating_sub(claimed)
    }
}

#[cfg(test)]
mod tests;
