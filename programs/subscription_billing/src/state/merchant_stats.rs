use anchor_lang::prelude::*;

/// Aggregated stats for a merchant — on-chain analytics.
/// Seeds: ["stats", merchant]
#[account]
#[derive(InitSpace)]
pub struct MerchantStats {
    /// The merchant this stats account belongs to.
    pub merchant: Pubkey,
    /// Total revenue collected (in token atomic units).
    pub total_revenue: u64,
    /// Current number of active subscriptions.
    pub active_subscribers: u64,
    /// Total number of invoices generated.
    pub total_invoices: u64,
    /// Total number of subscriptions ever created.
    pub total_subscriptions: u64,
    /// Total number of cancellations.
    pub total_cancellations: u64,
    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl MerchantStats {
    pub const SEED_PREFIX: &'static [u8] = b"stats";
}
