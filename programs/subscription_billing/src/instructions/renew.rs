use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::BillingError;
use crate::state::{Invoice, Merchant, MerchantStats, Plan, Subscription, SubscriptionStatus};

#[derive(Accounts)]
pub struct Renew<'info> {
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
        has_one = subscriber,
        seeds = [
            Subscription::SEED_PREFIX,
            plan.key().as_ref(),
            subscriber.key().as_ref(),
        ],
        bump = subscription.bump,
    )]
    pub subscription: Account<'info, Subscription>,

    /// Invoice for this payment cycle.
    #[account(
        init,
        seeds = [
            Invoice::SEED_PREFIX,
            subscription.key().as_ref(),
            &subscription.payments_made.to_le_bytes(),
        ],
        bump,
        payer = payer,
        space = 8 + Invoice::INIT_SPACE,
    )]
    pub invoice: Account<'info, Invoice>,

    #[account(
        mut,
        seeds = [MerchantStats::SEED_PREFIX, merchant.key().as_ref()],
        bump = stats.bump,
    )]
    pub stats: Account<'info, MerchantStats>,

    /// Subscriber's token account.
    #[account(
        mut,
        constraint = subscriber_token_account.owner == subscriber.key(),
        constraint = subscriber_token_account.mint == merchant.payment_mint,
    )]
    pub subscriber_token_account: Account<'info, TokenAccount>,

    /// Merchant's treasury.
    #[account(
        mut,
        constraint = treasury.key() == merchant.treasury,
    )]
    pub treasury: Account<'info, TokenAccount>,

    /// The subscriber (must sign to authorize token transfer).
    #[account(mut)]
    pub subscriber: Signer<'info>,

    /// Payer for the invoice account rent (can be subscriber or cranker).
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Renew>) -> Result<()> {
    let subscription = &mut ctx.accounts.subscription;
    let plan = &ctx.accounts.plan;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Must be active or past due
    require!(
        subscription.status == SubscriptionStatus::Active
            || subscription.status == SubscriptionStatus::PastDue,
        BillingError::SubscriptionNotActive
    );

    // Must be auto-renew enabled
    require!(subscription.auto_renew, BillingError::AlreadyCancelled);

    // Check if renewal is due (current period has ended)
    require!(
        now >= subscription.current_period_end,
        BillingError::RenewalNotDue
    );

    // Grace period check — if past grace deadline, reject and tell caller to use cancel_expired.
    // We do NOT cancel here because `init` on the invoice account would have already charged rent
    // for an account that would be wasted.  The caller must use the `cancel_expired` instruction
    // instead, which carries no invoice account and charges no unnecessary rent.
    if plan.grace_period_seconds > 0 {
        let grace_deadline = subscription
            .current_period_end
            .checked_add(plan.grace_period_seconds)
            .ok_or(BillingError::Overflow)?;

        require!(now <= grace_deadline, BillingError::GracePeriodNotExpired);
    }

    // Check funds
    require!(
        ctx.accounts.subscriber_token_account.amount >= plan.price,
        BillingError::InsufficientFunds
    );

    // Transfer payment
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.subscriber_token_account.to_account_info(),
            to: ctx.accounts.treasury.to_account_info(),
            authority: ctx.accounts.subscriber.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, plan.price)?;

    // Update subscription
    let new_period_end = subscription
        .current_period_end
        .checked_add(plan.interval_seconds)
        .ok_or(BillingError::Overflow)?;

    let period_start = subscription.current_period_end;
    subscription.current_period_end = new_period_end;
    subscription.status = SubscriptionStatus::Active;
    let invoice_number = subscription.payments_made;
    subscription.payments_made = subscription
        .payments_made
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    // Create invoice
    let invoice = &mut ctx.accounts.invoice;
    invoice.subscription = subscription.key();
    invoice.plan = plan.key();
    invoice.amount = plan.price;
    invoice.paid_at = now;
    invoice.period_start = period_start;
    invoice.period_end = new_period_end;
    invoice.invoice_number = invoice_number;
    invoice.bump = ctx.bumps.invoice;

    // Update stats
    let stats = &mut ctx.accounts.stats;
    stats.total_revenue = stats
        .total_revenue
        .checked_add(plan.price)
        .ok_or(BillingError::Overflow)?;
    stats.total_invoices = stats
        .total_invoices
        .checked_add(1)
        .ok_or(BillingError::Overflow)?;

    emit!(PaymentProcessed {
        subscription: subscription.key(),
        subscriber: subscription.subscriber,
        plan: plan.key(),
        amount: plan.price,
        invoice: invoice.key(),
        period_start,
        period_end: new_period_end,
    });

    msg!("Renewal successful. Next billing: {}", new_period_end);
    Ok(())
}

#[event]
pub struct PaymentProcessed {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub plan: Pubkey,
    pub amount: u64,
    pub invoice: Pubkey,
    pub period_start: i64,
    pub period_end: i64,
}
