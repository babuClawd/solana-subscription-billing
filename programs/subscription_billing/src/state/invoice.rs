use anchor_lang::prelude::*;

/// Invoice account — an immutable receipt for each payment.
/// Seeds: ["invoice", subscription, payment_number_bytes]
#[account]
#[derive(InitSpace)]
pub struct Invoice {
    /// The subscription this invoice belongs to.
    pub subscription: Pubkey,
    /// The plan at time of payment.
    pub plan: Pubkey,
    /// Amount paid in token atomic units.
    pub amount: u64,
    /// Timestamp when payment was made.
    pub paid_at: i64,
    /// Start of the billing period this invoice covers.
    pub period_start: i64,
    /// End of the billing period this invoice covers.
    pub period_end: i64,
    /// Sequential invoice number for this subscription.
    pub invoice_number: u64,
    /// Bump seed for PDA derivation.
    pub bump: u8,
}

impl Invoice {
    pub const SEED_PREFIX: &'static [u8] = b"invoice";
}
