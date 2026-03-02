use anchor_lang::prelude::*;

use crate::errors::BillingError;
use crate::state::{Merchant, MerchantStats, Plan, Subscription, SubscriptionStatus};

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(
        seeds = [Merchant::SEED_PREFIX, merchant.authority.as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(
        mut,
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
        has_one = subscriber,
        seeds = [
            Subscription::SEED_PREFIX,
            plan.key().as_ref(),
            subscriber.key().as_ref(),
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

    pub subscriber: Signer<'info>,
}

pub fn handler(ctx: Context<Cancel>) -> Result<()> {
    let subscription = &mut ctx.accounts.subscription;

    require!(
        subscription.status != SubscriptionStatus::Cancelled,
        BillingError::AlreadyCancelled
    );

    // Cancel = disable auto-renew. Subscription stays active until period end.
    subscription.auto_renew = false;
    subscription.status = SubscriptionStatus::Cancelled;

    // Decrement counters
    let plan = &mut ctx.accounts.plan;
    plan.subscriber_count = plan.subscriber_count.saturating_sub(1);

    let stats = &mut ctx.accounts.stats;
    stats.active_subscribers = stats.active_subscribers.saturating_sub(1);
    stats.total_cancellations = stats
        .total_cancellations
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    emit!(SubscriptionCancelledEvent {
        subscription: subscription.key(),
        subscriber: subscription.subscriber,
        plan: plan.key(),
        effective_until: subscription.current_period_end,
    });

    msg!(
        "Subscription cancelled. Active until: {}",
        subscription.current_period_end
    );
    Ok(())
}

#[event]
pub struct SubscriptionCancelledEvent {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub plan: Pubkey,
    pub effective_until: i64,
}
