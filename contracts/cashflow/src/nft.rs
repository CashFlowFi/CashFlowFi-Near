//! NEP-171 position NFTs (core, resolver, enumeration, metadata) and the live SVG position card.

use crate::{Contract, ContractExt, PoolStatus, PositionView, Tranche};
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{Token, TokenId};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{near, AccountId, PromiseOrValue};
use std::collections::HashMap;

// ---------- SVG position card ----------

/// USDC base units (6 dp) as a short decimal string, e.g. 6375000 -> "6.375".
fn usdc_str(units: u128) -> String {
    let (whole, frac) = (units / 1_000_000, units % 1_000_000);
    if frac == 0 {
        return whole.to_string();
    }
    let f = format!("{:06}", frac);
    format!("{}.{}", whole, f.trim_end_matches('0'))
}

/// Percent-encode an SVG for a `data:` URI (readable, no base64 dependency).
fn svg_data_uri(svg: &str) -> String {
    let mut out = String::from("data:image/svg+xml;charset=utf-8,");
    for b in svg.bytes() {
        if b.is_ascii_alphanumeric() || b" -_.!~*()=:/,;'".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Position card rendered from live pool state. Fixed layout with numbers only: no user text is embedded.
fn position_svg(v: &PositionView, status: PoolStatus) -> String {
    let (label, color) = match v.tranche {
        Tranche::Senior => ("SENIOR", "#2563eb"),
        Tranche::Junior => ("JUNIOR", "#d97706"),
    };
    let status = match status {
        PoolStatus::Funding => "FUNDING",
        PoolStatus::Active => "ACTIVE",
        PoolStatus::Repaid => "REPAID",
        PoolStatus::Defaulted => "DEFAULTED",
    };
    let row = |y: u32, name: &str, value: String, fill: &str, size: u32| {
        format!(
            "<text x='24' y='{y}' fill='#94a3b8' font-size='13'>{name}</text><text x='376' y='{y}' fill='{fill}' font-size='{size}' text-anchor='end'>{value} USDC</text>"
        )
    };
    [
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 250' font-family='monospace'>".to_string(),
        "<rect width='400' height='250' rx='16' fill='#0f172a'/>".to_string(),
        format!("<rect width='400' height='8' fill='{color}'/>"),
        "<text x='24' y='48' fill='#e2e8f0' font-size='20'>Cashflow Fi</text>".to_string(),
        format!("<text x='376' y='48' fill='{color}' font-size='16' text-anchor='end'>{label}</text>"),
        format!("<text x='24' y='82' fill='#94a3b8' font-size='14'>Pool #{} - {status}</text>", v.pool_id),
        row(130, "Invested", usdc_str(v.amount.0), "#e2e8f0", 15),
        row(162, "Claimed", usdc_str(v.claimed.0), "#e2e8f0", 15),
        row(200, "Claimable now", usdc_str(v.claimable.0), color, 20),
        format!("<text x='24' y='232' fill='#475569' font-size='11'>Payouts go to the current holder - token {}</text>", v.token_id),
        "</svg>".to_string(),
    ]
    .concat()
}

impl Contract {
    /// Fill a token's metadata with the live position card and numbers.
    fn decorate(&self, mut token: Token) -> Token {
        let Some(view) = self.get_position(token.token_id.clone()) else { return token };
        let Some(pool) = self.pools.get(&view.pool_id) else { return token };
        let status = pool.status;
        if let Some(m) = token.metadata.as_mut() {
            m.media = Some(svg_data_uri(&position_svg(&view, status)));
            m.media_hash = None;
            m.extra = Some(
                json!({"pool_id": view.pool_id, "tranche": view.tranche, "amount": view.amount,
                       "claimed": view.claimed, "claimable": view.claimable, "pool_status": status})
                .to_string(),
            );
        }
        token
    }
}

// ---------- NEP-171 (positions) ----------

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id).map(|t| self.decorate(t))
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: TokenId, approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 { self.tokens.nft_total_supply() }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit).into_iter().map(|t| self.decorate(t)).collect()
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 { self.tokens.nft_supply_for_owner(account_id) }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit).into_iter().map(|t| self.decorate(t)).collect()
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Cashflow Fi Positions".to_string(),
            symbol: "CFPOS".to_string(),
            icon: None, base_uri: None, reference: None, reference_hash: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usdc_str_formats_six_decimals() {
        assert_eq!(usdc_str(0), "0");
        assert_eq!(usdc_str(6_375_000), "6.375");
        assert_eq!(usdc_str(1_000_000), "1");
        assert_eq!(usdc_str(1), "0.000001");
        assert_eq!(usdc_str(212_500_000), "212.5");
    }

    #[test]
    fn svg_uri_escapes_markup() {
        let u = svg_data_uri("<a href='#x'>1 & 2</a>");
        assert_eq!(u, "data:image/svg+xml;charset=utf-8,%3Ca href='%23x'%3E1 %26 2%3C/a%3E");
    }
}
