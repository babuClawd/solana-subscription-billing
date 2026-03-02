use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::BillingError;
use crate::state::Merchant;

/// Merchant withdraws collected payments from treasury.
/// Uses PDA signing so only the merchant program can authorize transfers.
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        has_one = authority,
        has_one = treasury,
        seeds = [Merchant::SEED_PREFIX, authority.key().as_ref()],
        bump = merchant.bump,
    )]
    pub merchant: Account<'info, Merchant>,

    #[account(mut)]
    pub treasury: Account<'info, TokenAccount>,

    /// Merchant's personal token account to receive withdrawn funds.
    #[account(
        mut,
        constraint = destination.mint == merchant.payment_mint,
    )]
    pub destination: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let merchant = &ctx.accounts.merchant;

    require!(
        ctx.accounts.treasury.amount >= amount,
        BillingError::InsufficientTreasuryBalance
    );

    // PDA signer seeds for the merchant account
    let authority_key = merchant.authority;
    let seeds = &[
        Merchant::SEED_PREFIX,
        authority_key.as_ref(),
        &[merchant.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.treasury.to_account_info(),
            to: ctx.accounts.destination.to_account_info(),
            authority: ctx.accounts.merchant.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, amount)?;

    emit!(WithdrawalProcessed {
        merchant: merchant.key(),
        amount,
        destination: ctx.accounts.destination.key(),
    });

    msg!("Withdrawn {} tokens to {}", amount, ctx.accounts.destination.key());
    Ok(())
}

#[event]
pub struct WithdrawalProcessed {
    pub merchant: Pubkey,
    pub amount: u64,
    pub destination: Pubkey,
}
