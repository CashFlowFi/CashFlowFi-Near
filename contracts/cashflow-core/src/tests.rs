//! Unit tests for the pool engine: terms, funding, waterfall, default cover.

use super::*;

const U: u128 = 1_000_000; // 1 USDC

fn active_pool() -> PoolState {
    let mut p = PoolState::new(terms(1_000 * U, Tier::B).unwrap());
    p.invest(Tranche::Senior, 600 * U).unwrap();
    assert!(p.invest(Tranche::Junior, 200 * U).unwrap().activated);
    p
}

#[test]
fn terms_for_1000_tier_b() {
    let t = terms(1_000 * U, Tier::B).unwrap();
    assert_eq!(t.advance, 800 * U);
    assert_eq!(t.fee, 8 * U);
    assert_eq!((t.fee_insurance, t.fee_treasury), (4 * U, 4 * U));
    assert_eq!(t.merchant_net, 792 * U);
    assert_eq!(t.claim, 850 * U);
    assert_eq!(t.senior_face, 637_500_000);
    assert_eq!(t.junior_face, 212_500_000);
    assert_eq!((t.senior_target, t.junior_target), (600 * U, 200 * U));
    assert_eq!(t.insurance_cap, 100 * U); // min(106.25, 100)
}

#[test]
fn tiers_change_ltv() {
    assert_eq!(terms(1_000 * U, Tier::A).unwrap().advance, 850 * U);
    assert_eq!(terms(1_000 * U, Tier::C).unwrap().advance, 700 * U);
    assert_eq!(terms(1_000 * U, Tier::D).unwrap().advance, 600 * U);
    assert_eq!(terms(0, Tier::B), Err(EngineError::ZeroReceivable));
}

#[test]
fn overfunding_is_refunded_and_activation_happens_once() {
    let mut p = PoolState::new(terms(1_000 * U, Tier::B).unwrap());
    let r = p.invest(Tranche::Senior, 650 * U).unwrap();
    assert_eq!((r.accepted, r.refund, r.activated), (600 * U, 50 * U, false));
    let r = p.invest(Tranche::Senior, 10 * U).unwrap();
    assert_eq!((r.accepted, r.refund, r.activated), (0, 10 * U, false));
    let r = p.invest(Tranche::Junior, 200 * U).unwrap();
    assert!(r.activated);
    assert_eq!(p.status, PoolStatus::Active);
    assert_eq!(p.invest(Tranche::Junior, U), Err(EngineError::NotFunding));
}

#[test]
fn waterfall_happy_path() {
    let mut p = active_pool();
    let s = p.apply_payment(500 * U).unwrap();
    assert_eq!(s, Split { senior: 500 * U, junior: 0, insurance_refill: 0, merchant: 0 });
    let s = p.apply_payment(500 * U).unwrap();
    assert_eq!(s.senior, 137_500_000);
    assert_eq!(s.junior, 212_500_000);
    assert_eq!(s.merchant, 150 * U);
    assert_eq!(p.status, PoolStatus::Repaid);
}

#[test]
fn payment_rejected_while_funding() {
    let mut p = PoolState::new(terms(1_000 * U, Tier::B).unwrap());
    assert_eq!(p.apply_payment(U), Err(EngineError::NotPayable));
}

#[test]
fn claims_pay_once_and_track_progress() {
    let mut p = active_pool();
    p.apply_payment(500 * U).unwrap();
    let mut claimed = 0;
    let c = p.claimable(Tranche::Senior, 600 * U, claimed);
    assert_eq!(c, 500 * U);
    claimed += c;
    assert_eq!(p.claimable(Tranche::Senior, 600 * U, claimed), 0);
    p.apply_payment(400 * U).unwrap();
    let c = p.claimable(Tranche::Senior, 600 * U, claimed);
    assert_eq!(c, 137_500_000);
    claimed += c;
    assert_eq!(claimed, 637_500_000); // 600 -> 637.5 (+6.25%)
    assert_eq!(p.claimable(Tranche::Junior, 200 * U, 0), 212_500_000);
}

#[test]
fn split_positions_share_pro_rata() {
    let mut p = PoolState::new(terms(1_000 * U, Tier::B).unwrap());
    p.invest(Tranche::Senior, 450 * U).unwrap();
    p.invest(Tranche::Senior, 150 * U).unwrap();
    p.invest(Tranche::Junior, 200 * U).unwrap();
    p.apply_payment(1_000 * U).unwrap();
    let a = p.claimable(Tranche::Senior, 450 * U, 0);
    let b = p.claimable(Tranche::Senior, 150 * U, 0);
    assert_eq!(a + b, p.terms.senior_face);
}

#[test]
fn default_with_insurance_protects_senior() {
    let mut p = active_pool();
    p.apply_payment(700 * U).unwrap(); // senior 637.5, junior 62.5
    assert_eq!(p.shortfall(), 150 * U);
    let cover = p.default_cover(500 * U).unwrap();
    assert_eq!(cover, 100 * U);
    p.mark_defaulted().unwrap();
    let s = p.apply_cover(cover).unwrap();
    assert_eq!((s.senior, s.junior), (0, 100 * U));
    assert_eq!(p.claimable(Tranche::Senior, 600 * U, 0), 637_500_000);
    assert_eq!(p.claimable(Tranche::Junior, 200 * U, 0), 162_500_000);
    assert_eq!(p.insurance_paid, 100 * U);
}

#[test]
fn small_fund_gives_partial_cover() {
    let mut p = active_pool();
    p.apply_payment(700 * U).unwrap();
    assert_eq!(p.default_cover(30 * U).unwrap(), 30 * U);
}

#[test]
fn late_payment_refills_insurance_before_merchant() {
    let mut p = active_pool();
    p.apply_payment(700 * U).unwrap();
    p.mark_defaulted().unwrap();
    p.apply_cover(100 * U).unwrap();
    let s = p.apply_payment(200 * U).unwrap();
    assert_eq!(s.junior, 50 * U);
    assert_eq!(s.insurance_refill, 100 * U);
    assert_eq!(s.merchant, 50 * U);
    assert_eq!(p.status, PoolStatus::Repaid);
}

#[test]
fn default_only_from_active() {
    let mut p = PoolState::new(terms(1_000 * U, Tier::B).unwrap());
    assert_eq!(p.mark_defaulted(), Err(EngineError::NotActive));
    assert_eq!(p.default_cover(U), Err(EngineError::NotActive));
}

#[test]
fn failed_advance_reverts_to_funding() {
    let mut p = active_pool();
    p.revert_activation();
    assert_eq!(p.status, PoolStatus::Funding);
}

#[test]
fn tier_c_pool() {
    let t = terms(1_000 * U, Tier::C).unwrap();
    assert_eq!(t.advance, 700 * U);
    assert_eq!((t.senior_target, t.junior_target), (525 * U, 175 * U));
}

#[test]
fn conservation_over_many_payments() {
    // Money in (payments) must equal money out (senior + junior + refill + merchant).
    let mut p = active_pool();
    let mut out = 0;
    let mut paid = 0;
    for amt in [1, 7 * U, 333_333_333, 250 * U, 999 * U] {
        let s = p.apply_payment(amt).unwrap();
        out += s.senior + s.junior + s.insurance_refill + s.merchant;
        paid += amt;
    }
    assert_eq!(out, paid);
    assert_eq!(p.status, PoolStatus::Repaid);
}
