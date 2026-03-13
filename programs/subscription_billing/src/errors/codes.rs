use anchor_lang::prelude::*;

#[error_code]
pub enum BillingError {
    #[msg("Plan name must be between 1 and 32 characters")]
    InvalidPlanName,

    #[msg("Merchant name must be between 1 and 32 characters")]
    InvalidMerchantName,

    #[msg("Price must be greater than zero")]
    InvalidPrice,

    #[msg("Billing interval must be at least 60 seconds")]
    InvalidInterval,

    #[msg("Grace period cannot be negative")]
    InvalidGracePeriod,

    #[msg("Plan is not active and cannot accept new subscribers")]
    PlanNotActive,

    #[msg("Plan has reached its maximum subscriber limit")]
    PlanAtCapacity,

    #[msg("Subscription is not active")]
    SubscriptionNotActive,

    #[msg("Subscription is not due for renewal yet")]
    RenewalNotDue,

    #[msg("Subscription has already been cancelled")]
    AlreadyCancelled,

    #[msg("Subscription is still active and cannot be closed")]
    SubscriptionStillActive,

    #[msg("Grace period has not expired yet")]
    GracePeriodNotExpired,

    #[msg("This plan has no grace period configured")]
    GracePeriodNotConfigured,

    #[msg("Insufficient funds for payment")]
    InsufficientFunds,

    #[msg("Withdrawal amount exceeds treasury balance")]
    InsufficientTreasuryBalance,

    #[msg("Unauthorized: signer is not the expected authority")]
    Unauthorized,

    #[msg("New plan must belong to the same merchant")]
    PlanMerchantMismatch,

    #[msg("Cannot change to the same plan")]
    SamePlan,

    #[msg("Arithmetic overflow")]
    Overflow,
}
