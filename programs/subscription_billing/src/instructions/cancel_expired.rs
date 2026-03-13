use anchor_lang::prelude::*;

use crate::errors::BillingError;
use crate::state::{Merchant, MerchantStats, Plan, Subscription, SubscriptionStatus};

/// Cancel a subscription whose grace period has expired.
///
/// This instruction is intentionally separate from `renew` so that the
/// grace-period auto-cancellation path never allocates (and charges rent for)
/// an `Invoice` account.  Callers (crankers, the subscriber themselves, or
/// any keeper service) can call this to clean up lapsed subscriptions without
/// providing a funded invoice account.
///
/// # Validations
/// - Subscription must be `Active` or `PastDue`.
/// - The plan's grace period must be > 0.
/// - The current time must be strictly past `current_period_end + grace_period_seconds`.
#[derive(Accounts)]
pub struct CancelExpired<'info> {
    #[account(
        seeds = [Merchant::SEED_PREFIX, merchant.authority.as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(
        has_one = merchant,
        seeds = [
            Plan::SEED_PREFIX,
            merchant.key().as_ref(),
            &plan.plan_id.to_le_bytes(),
        ],
        bump = plan.bump,
    )]
    pub plan: Account<'info, Plan>,

    #[account(
        mut,
        has_one = plan,
        has_one = merchant,
        seeds = [
            Subscription::SEED_PREFIX,
            plan.key().as_ref(),
            subscription.subscriber.as_ref(),
        ],
        bump = subscription.bump,
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(
        mut,
        seeds = [MerchantStats::SEED_PREFIX, merchant.key().as_ref()],
        bump = stats.bump,
    )]
    pub stats: Account<'info, MerchantStats>,
}

pub fn handler(ctx: Context<CancelExpired>) -> Result<()> {
    let subscription = &mut ctx.accounts.subscription;
    let plan = &ctx.accounts.plan;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Must be in a renewable-but-lapsed state
    require!(
        subscription.status == SubscriptionStatus::Active
            || subscription.status == SubscriptionStatus::PastDue,
        BillingError::SubscriptionNotActive
    );

    // Grace period must be configured on this plan
    require!(
        plan.grace_period_seconds > 0,
        BillingError::GracePeriodNotConfigured
    );

    // Grace deadline must have passed
    let grace_deadline = subscription
        .current_period_end
        .checked_add(plan.grace_period_seconds)
        .ok_or(BillingError::Overflow)?;

    require!(now > grace_deadline, BillingError::GracePeriodNotExpired);

    // Cancel the subscription
    subscription.status = SubscriptionStatus::Cancelled;
    subscription.auto_renew = false;

    let stats = &mut ctx.accounts.stats;
    stats.active_subscribers = stats.active_subscribers.saturating_sub(1);
    stats.total_cancellations = stats
        .total_cancellations
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    emit!(SubscriptionExpired {
        subscription: subscription.key(),
        subscriber: subscription.subscriber,
        grace_deadline,
        cancelled_at: now,
    });

    msg!(
        "Subscription {} auto-cancelled: grace period expired at {}",
        subscription.key(),
        grace_deadline
    );
    Ok(())
}

#[event]
pub struct SubscriptionExpired {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub grace_deadline: i64,
    pub cancelled_at: i64,
}
