use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::BillingError;
use crate::state::{Invoice, Merchant, MerchantStats, Plan, Subscription, SubscriptionStatus};

/// Change plan (upgrade or downgrade).
/// Calculates prorated credit from remaining time on current plan,
/// applies it toward the new plan, and charges/refunds the difference.
#[derive(Accounts)]
pub struct ChangePlan<'info> {
    #[account(
        seeds = [Merchant::SEED_PREFIX, merchant.authority.as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Box<Account<'info, Merchant>>,

    /// The current plan the subscriber is on.
    #[account(
        mut,
        has_one = merchant,
        seeds = [
            Plan::SEED_PREFIX,
            merchant.key().as_ref(),
            &current_plan.plan_id.to_le_bytes(),
        ],
        bump = current_plan.bump,
    )]
    pub current_plan: Box<Account<'info, Plan>>,

    /// The new plan the subscriber wants to switch to.
    #[account(
        mut,
        has_one = merchant,
        seeds = [
            Plan::SEED_PREFIX,
            merchant.key().as_ref(),
            &new_plan.plan_id.to_le_bytes(),
        ],
        bump = new_plan.bump,
    )]
    pub new_plan: Box<Account<'info, Plan>>,

    #[account(
        mut,
        has_one = subscriber,
        constraint = subscription.plan == current_plan.key(),
        constraint = subscription.merchant == merchant.key(),
        seeds = [
            Subscription::SEED_PREFIX,
            current_plan.key().as_ref(),
            subscriber.key().as_ref(),
        ],
        bump = subscription.bump,
    )]
    pub subscription: Box<Account<'info, Subscription>>,

    /// New subscription account for the new plan.
    #[account(
        init,
        seeds = [
            Subscription::SEED_PREFIX,
            new_plan.key().as_ref(),
            subscriber.key().as_ref(),
        ],
        bump,
        payer = subscriber,
        space = 8 + Subscription::INIT_SPACE,
    )]
    pub new_subscription: Box<Account<'info, Subscription>>,

    /// Invoice for the plan change.
    #[account(
        init,
        seeds = [
            Invoice::SEED_PREFIX,
            new_subscription.key().as_ref(),
            &0u64.to_le_bytes(),
        ],
        bump,
        payer = subscriber,
        space = 8 + Invoice::INIT_SPACE,
    )]
    pub invoice: Box<Account<'info, Invoice>>,

    #[account(
        mut,
        seeds = [MerchantStats::SEED_PREFIX, merchant.key().as_ref()],
        bump = stats.bump,
    )]
    pub stats: Box<Account<'info, MerchantStats>>,

    #[account(
        mut,
        constraint = subscriber_token_account.owner == subscriber.key(),
        constraint = subscriber_token_account.mint == merchant.payment_mint,
    )]
    pub subscriber_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury.key() == merchant.treasury,
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub subscriber: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ChangePlan>) -> Result<()> {
    let current_plan = &ctx.accounts.current_plan;
    let new_plan = &ctx.accounts.new_plan;
    let old_sub = &mut ctx.accounts.subscription;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Validate
    require!(
        old_sub.status == SubscriptionStatus::Active,
        BillingError::SubscriptionNotActive
    );
    require!(
        current_plan.key() != new_plan.key(),
        BillingError::SamePlan
    );
    require!(new_plan.is_active, BillingError::PlanNotActive);

    if new_plan.max_subscribers > 0 {
        require!(
            new_plan.subscriber_count < new_plan.max_subscribers,
            BillingError::PlanAtCapacity
        );
    }

    // Calculate prorated credit from remaining time on current plan.
    // credit = (remaining_seconds / total_interval) * current_price
    let remaining = old_sub
        .current_period_end
        .checked_sub(now)
        .ok_or(BillingError::Overflow)?
        .max(0) as u64;
    let total_interval = current_plan.interval_seconds.max(1) as u64;

    let credit = (current_plan.price as u128)
        .checked_mul(remaining as u128)
        .ok_or(BillingError::Overflow)?
        .checked_div(total_interval as u128)
        .ok_or(BillingError::Overflow)? as u64;

    // Cost of the new plan
    let new_cost = new_plan.price;

    // Net amount: if upgrade, subscriber pays difference; if downgrade, credit > cost
    // For simplicity: subscriber always pays for full new period minus credit.
    // If credit > new_cost, the excess is "lost" (no refund mechanism for simplicity).
    let charge = new_cost.saturating_sub(credit);

    if charge > 0 {
        require!(
            ctx.accounts.subscriber_token_account.amount >= charge,
            BillingError::InsufficientFunds
        );

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.subscriber_token_account.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.subscriber.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, charge)?;
    }

    // Cancel old subscription
    old_sub.status = SubscriptionStatus::Cancelled;
    old_sub.auto_renew = false;

    // Decrement old plan count
    let current_plan = &mut ctx.accounts.current_plan;
    current_plan.subscriber_count = current_plan.subscriber_count.saturating_sub(1);

    // Create new subscription
    let new_period_end = now
        .checked_add(new_plan.interval_seconds)
        .ok_or(BillingError::Overflow)?;

    let new_sub = &mut ctx.accounts.new_subscription;
    new_sub.subscriber = ctx.accounts.subscriber.key();
    new_sub.plan = new_plan.key();
    new_sub.merchant = ctx.accounts.merchant.key();
    new_sub.created_at = now;
    new_sub.current_period_end = new_period_end;
    new_sub.status = SubscriptionStatus::Active;
    new_sub.payments_made = 1;
    new_sub.auto_renew = true;
    new_sub.bump = ctx.bumps.new_subscription;

    // Increment new plan count
    let new_plan = &mut ctx.accounts.new_plan;
    new_plan.subscriber_count = new_plan
        .subscriber_count
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    // Create invoice
    let invoice = &mut ctx.accounts.invoice;
    invoice.subscription = new_sub.key();
    invoice.plan = new_plan.key();
    invoice.amount = charge;
    invoice.paid_at = now;
    invoice.period_start = now;
    invoice.period_end = new_period_end;
    invoice.invoice_number = 0;
    invoice.bump = ctx.bumps.invoice;

    // Update stats (net: subscriber count stays same, revenue += charge)
    let stats = &mut ctx.accounts.stats;
    if charge > 0 {
        stats.total_revenue = stats
            .total_revenue
            .checked_add(charge)
            .ok_or(BillingError::Overflow)?;
    }
    stats.total_invoices = stats
        .total_invoices
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    emit!(PlanChanged {
        old_subscription: old_sub.key(),
        new_subscription: new_sub.key(),
        subscriber: new_sub.subscriber,
        old_plan: current_plan.key(),
        new_plan: new_plan.key(),
        credit,
        charge,
    });

    msg!(
        "Plan changed. Credit: {}, Charge: {}, New period ends: {}",
        credit,
        charge,
        new_period_end
    );
    Ok(())
}

#[event]
pub struct PlanChanged {
    pub old_subscription: Pubkey,
    pub new_subscription: Pubkey,
    pub subscriber: Pubkey,
    pub old_plan: Pubkey,
    pub new_plan: Pubkey,
    pub credit: u64,
    pub charge: u64,
}
