use anchor_lang::prelude::*;

use crate::errors::BillingError;
use crate::state::{Merchant, Plan};

#[derive(Accounts)]
pub struct CreatePlan<'info> {
    #[account(
        mut,
        has_one = authority,
        seeds = [Merchant::SEED_PREFIX, authority.key().as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(
        init,
        seeds = [
            Plan::SEED_PREFIX,
            merchant.key().as_ref(),
            &merchant.plan_count.to_le_bytes(),
        ],
        bump,
        payer = authority,
        space = 8 + Plan::INIT_SPACE,
    )]
    pub plan: Account<'info, Plan>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreatePlan>,
    name: String,
    price: u64,
    interval_seconds: i64,
    grace_period_seconds: i64,
    max_subscribers: Option<u64>,
) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= 32,
        BillingError::InvalidPlanName
    );
    require!(price > 0, BillingError::InvalidPrice);
    require!(interval_seconds >= 60, BillingError::InvalidInterval);
    require!(grace_period_seconds >= 0, BillingError::InvalidGracePeriod);

    let merchant = &mut ctx.accounts.merchant;
    let plan = &mut ctx.accounts.plan;

    plan.merchant = merchant.key();
    plan.plan_id = merchant.plan_count;
    plan.name = name.clone();
    plan.price = price;
    plan.interval_seconds = interval_seconds;
    plan.grace_period_seconds = grace_period_seconds;
    plan.is_active = true;
    plan.max_subscribers = max_subscribers.unwrap_or(0); // 0 = unlimited
    plan.subscriber_count = 0;
    plan.bump = ctx.bumps.plan;

    merchant.plan_count = merchant
        .plan_count
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    emit!(PlanCreated {
        merchant: merchant.key(),
        plan: plan.key(),
        plan_id: plan.plan_id,
        name,
        price,
        interval_seconds,
    });

    msg!("Plan created: {} (ID: {})", plan.name, plan.plan_id);
    Ok(())
}

#[event]
pub struct PlanCreated {
    pub merchant: Pubkey,
    pub plan: Pubkey,
    pub plan_id: u64,
    pub name: String,
    pub price: u64,
    pub interval_seconds: i64,
}
