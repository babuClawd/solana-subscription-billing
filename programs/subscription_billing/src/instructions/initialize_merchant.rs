use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::BillingError;
use crate::state::{Merchant, MerchantStats};

#[derive(Accounts)]
pub struct InitializeMerchant<'info> {
    #[account(
        init,
        seeds = [Merchant::SEED_PREFIX, authority.key().as_ref()],
        bump,
        payer = authority,
        space = 8 + Merchant::INIT_SPACE,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(
        init,
        seeds = [MerchantStats::SEED_PREFIX, merchant.key().as_ref()],
        bump,
        payer = authority,
        space = 8 + MerchantStats::INIT_SPACE,
    )]
    pub stats: Account<'info, MerchantStats>,

    /// The SPL token mint for payments (e.g., USDC).
    pub payment_mint: Account<'info, Mint>,

    /// The merchant's treasury token account (must be owned by merchant PDA).
    #[account(
        init,
        seeds = [b"treasury", merchant.key().as_ref()],
        bump,
        payer = authority,
        token::mint = payment_mint,
        token::authority = merchant,
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<InitializeMerchant>, name: String) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= 32,
        BillingError::InvalidMerchantName
    );

    let merchant = &mut ctx.accounts.merchant;
    merchant.authority = ctx.accounts.authority.key();
    merchant.payment_mint = ctx.accounts.payment_mint.key();
    merchant.treasury = ctx.accounts.treasury.key();
    merchant.name = name.clone();
    merchant.plan_count = 0;
    merchant.bump = ctx.bumps.merchant;

    let stats = &mut ctx.accounts.stats;
    stats.merchant = merchant.key();
    stats.total_revenue = 0;
    stats.active_subscribers = 0;
    stats.total_invoices = 0;
    stats.total_subscriptions = 0;
    stats.total_cancellations = 0;
    stats.bump = ctx.bumps.stats;

    emit!(MerchantInitialized {
        merchant: merchant.key(),
        authority: merchant.authority,
        payment_mint: merchant.payment_mint,
        name,
    });

    msg!("Merchant initialized: {}", merchant.key());
    Ok(())
}

#[event]
pub struct MerchantInitialized {
    pub merchant: Pubkey,
    pub authority: Pubkey,
    pub payment_mint: Pubkey,
    pub name: String,
}
