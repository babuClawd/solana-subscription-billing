use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::BillingError;
use crate::state::{Invoice, Merchant, MerchantStats, Plan, Subscription, SubscriptionStatus};

#[derive(Accounts)]
pub struct Subscribe<'info> {
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
        init,
        seeds = [
            Subscription::SEED_PREFIX,
            plan.key().as_ref(),
            subscriber.key().as_ref(),
        ],
        bump,
        payer = subscriber,
        space = 8 + Subscription::INIT_SPACE,
    )]
    pub subscription: Account<'info, Subscription>,

    #[account(
        init,
        seeds = [
            Invoice::SEED_PREFIX,
            subscription.key().as_ref(),
            &0u64.to_le_bytes(), // First invoice = #0
        ],
        bump,
        payer = subscriber,
        space = 8 + Invoice::INIT_SPACE,
    )]
    pub invoice: Account<'info, Invoice>,

    #[account(
        mut,
        seeds = [MerchantStats::SEED_PREFIX, merchant.key().as_ref()],
        bump = stats.bump,
    )]
    pub stats: Account<'info, MerchantStats>,

    /// Subscriber's token account to pay from.
    #[account(
        mut,
        constraint = subscriber_token_account.owner == subscriber.key(),
        constraint = subscriber_token_account.mint == merchant.payment_mint,
    )]
    pub subscriber_token_account: Account<'info, TokenAccount>,

    /// Merchant's treasury token account to receive payment.
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

pub fn handler(ctx: Context<Subscribe>) -> Result<()> {
    let plan = &mut ctx.accounts.plan;
    let merchant = &ctx.accounts.merchant;

    // Validate plan is active
    require!(plan.is_active, BillingError::PlanNotActive);

    // Check subscriber cap (0 = unlimited)
    if plan.max_subscribers > 0 {
        require!(
            plan.subscriber_count < plan.max_subscribers,
            BillingError::PlanAtCapacity
        );
    }

    // Check subscriber has sufficient funds
    require!(
        ctx.accounts.subscriber_token_account.amount >= plan.price,
        BillingError::InsufficientFunds
    );

    // Transfer first payment
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.subscriber_token_account.to_account_info(),
            to: ctx.accounts.treasury.to_account_info(),
            authority: ctx.accounts.subscriber.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, plan.price)?;

    // Get current time
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let period_end = now
        .checked_add(plan.interval_seconds)
        .ok_or(BillingError::Overflow)?;

    // Initialize subscription
    let subscription = &mut ctx.accounts.subscription;
    subscription.subscriber = ctx.accounts.subscriber.key();
    subscription.plan = plan.key();
    subscription.merchant = merchant.key();
    subscription.created_at = now;
    subscription.current_period_end = period_end;
    subscription.status = SubscriptionStatus::Active;
    subscription.payments_made = 1;
    subscription.auto_renew = true;
    subscription.bump = ctx.bumps.subscription;

    // Create first invoice
    let invoice = &mut ctx.accounts.invoice;
    invoice.subscription = subscription.key();
    invoice.plan = plan.key();
    invoice.amount = plan.price;
    invoice.paid_at = now;
    invoice.period_start = now;
    invoice.period_end = period_end;
    invoice.invoice_number = 0;
    invoice.bump = ctx.bumps.invoice;

    // Update plan subscriber count
    plan.subscriber_count = plan
        .subscriber_count
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    // Update merchant stats
    let stats = &mut ctx.accounts.stats;
    stats.active_subscribers = stats
        .active_subscribers
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;
    stats.total_subscriptions = stats
        .total_subscriptions
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;
    stats.total_revenue = stats
        .total_revenue
        .checked_add(plan.price)
        .ok_or(BillingError::Overflow)?;
    stats.total_invoices = stats
        .total_invoices
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    emit!(SubscriptionCreated {
        subscription: subscription.key(),
        subscriber: subscription.subscriber,
        plan: plan.key(),
        merchant: merchant.key(),
        amount: plan.price,
        period_end,
    });

    msg!(
        "Subscription created for {} on plan {}",
        subscription.subscriber,
        plan.name
    );
    Ok(())
}

#[event]
pub struct SubscriptionCreated {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub plan: Pubkey,
    pub merchant: Pubkey,
    pub amount: u64,
    pub period_end: i64,
}
