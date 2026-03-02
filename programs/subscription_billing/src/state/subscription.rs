use anchor_lang::prelude::*;

/// Subscription status state machine:
///   Active → PastDue → Cancelled
///   Active → Cancelled (voluntary)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SubscriptionStatus {
    /// Subscription is active and paid up.
    Active,
    /// Payment is overdue but within grace period.
    PastDue,
    /// Subscription has been cancelled (voluntary or expired).
    Cancelled,
}

/// Subscription account — tracks an individual subscriber's state.
/// Seeds: ["subscription", plan, subscriber]
#[account]
#[derive(InitSpace)]
pub struct Subscription {
    /// The subscriber's wallet.
    pub subscriber: Pubkey,
    /// The plan this subscription is for.
    pub plan: Pubkey,
    /// The merchant (denormalized for efficient lookups).
    pub merchant: Pubkey,
    /// When the subscription was created.
    pub created_at: i64,
    /// When the current billing period ends.
    pub current_period_end: i64,
    /// Current subscription status.
    pub status: SubscriptionStatus,
    /// Total number of successful payments made.
    pub payments_made: u64,
    /// Whether auto-renew is enabled.
    pub auto_renew: bool,
    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl Subscription {
    pub const SEED_PREFIX: &'static [u8] = b"subscription";
}
