use anchor_lang::prelude::*;

/// Merchant account — the service provider who creates plans and collects payments.
/// Seeds: ["merchant", authority]
#[account]
#[derive(InitSpace)]
pub struct Merchant {
    /// The wallet that controls this merchant account.
    pub authority: Pubkey,
    /// The SPL token mint accepted for payments (e.g., USDC).
    pub payment_mint: Pubkey,
    /// The token account where payments are collected.
    pub treasury: Pubkey,
    /// Human-readable merchant name.
    #[max_len(32)]
    pub name: String,
    /// Number of plans created (used as plan ID counter).
    pub plan_count: u64,
    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl Merchant {
    pub const SEED_PREFIX: &'static [u8] = b"merchant";
}
