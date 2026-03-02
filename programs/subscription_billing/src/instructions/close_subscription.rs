use anchor_lang::prelude::*;

use crate::errors::BillingError;
use crate::state::{Plan, Subscription, SubscriptionStatus};

/// Close a cancelled/expired subscription account to reclaim rent SOL.
#[derive(Accounts)]
pub struct CloseSubscription<'info> {
    #[account(
        has_one = merchant,
        seeds = [
            Plan::SEED_PREFIX,
            plan.merchant.as_ref(),
            &plan.plan_id.to_le_bytes(),
        ],
        bump = plan.bump,
    )]
    pub plan: Account<'info, Plan>,

    #[account(
        mut,
        has_one = subscriber,
        has_one = plan,
        seeds = [
            Subscription::SEED_PREFIX,
            plan.key().as_ref(),
            subscriber.key().as_ref(),
        ],
        bump = subscription.bump,
        close = subscriber,
    )]
    pub subscription: Account<'info, Subscription>,

    /// CHECK: Only used for has_one validation on plan.
    pub merchant: UncheckedAccount<'info>,

    #[account(mut)]
    pub subscriber: Signer<'info>,
}

pub fn handler(ctx: Context<CloseSubscription>) -> Result<()> {
    let subscription = &ctx.accounts.subscription;
    let clock = Clock::get()?;

    // Can only close if cancelled OR if past period end + grace
    match subscription.status {
        SubscriptionStatus::Cancelled => {
            // Cancelled subscriptions can always be closed
        }
        SubscriptionStatus::Active | SubscriptionStatus::PastDue => {
            // Active subs can only be closed if period has fully expired
            require!(
                clock.unix_timestamp > subscription.current_period_end,
                BillingError::SubscriptionStillActive
            );
        }
    }

    msg!("Subscription account closed. Rent reclaimed.");
    Ok(())
}
