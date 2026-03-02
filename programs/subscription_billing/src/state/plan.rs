use anchor_lang::prelude::*;

/// Plan account — defines a subscription tier (e.g., "Basic Monthly", "Pro Annual").
/// Seeds: ["plan", merchant, plan_id_bytes]
#[account]
#[derive(InitSpace)]
pub struct Plan {
    /// The merchant that owns this plan.
    pub merchant: Pubkey,
    /// Unique plan ID within the merchant's namespace.
    pub plan_id: u64,
    /// Human-readable plan name.
    #[max_len(32)]
    pub name: String,
    /// Price per billing cycle in token atomic units (e.g., 10_000_000 = 10 USDC).
    pub price: u64,
    /// Billing interval in seconds (e.g., 2_592_000 = 30 days).
    pub interval_seconds: i64,
    /// Grace period after billing due date before subscription is cancelled.
    pub grace_period_seconds: i64,
    /// Whether this plan accepts new subscribers.
    pub is_active: bool,
    /// Optional cap on total subscribers.
    pub max_subscribers: u64,
    /// Current number of active subscribers.
    pub subscriber_count: u64,
    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl Plan {
    pub const SEED_PREFIX: &'static [u8] = b"plan";
}
