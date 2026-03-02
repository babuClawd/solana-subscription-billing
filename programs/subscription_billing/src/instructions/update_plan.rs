use anchor_lang::prelude::*;

use crate::errors::BillingError;
use crate::state::{Merchant, Plan};

#[derive(Accounts)]
pub struct UpdatePlan<'info> {
    #[account(
        has_one = authority,
        seeds = [Merchant::SEED_PREFIX, authority.key().as_ref()],
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

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdatePlan>,
    new_price: Option<u64>,
    new_interval: Option<i64>,
    new_grace_period: Option<i64>,
    new_max_subscribers: Option<u64>,
) -> Result<()> {
    let plan = &mut ctx.accounts.plan;

    if let Some(price) = new_price {
        require!(price > 0, BillingError::InvalidPrice);
        plan.price = price;
    }

    if let Some(interval) = new_interval {
        require!(interval >= 60, BillingError::InvalidInterval);
        plan.interval_seconds = interval;
    }

    if let Some(grace) = new_grace_period {
        require!(grace >= 0, BillingError::InvalidGracePeriod);
        plan.grace_period_seconds = grace;
    }

    if let Some(max) = new_max_subscribers {
        plan.max_subscribers = max;
    }

    emit!(PlanUpdated {
        plan: plan.key(),
        price: plan.price,
        interval_seconds: plan.interval_seconds,
    });

    msg!("Plan updated: {}", plan.name);
    Ok(())
}

#[event]
pub struct PlanUpdated {
    pub plan: Pubkey,
    pub price: u64,
    pub interval_seconds: i64,
}
