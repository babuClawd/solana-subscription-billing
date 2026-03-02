use anchor_lang::prelude::*;

use crate::state::{Merchant, Plan};

#[derive(Accounts)]
pub struct DeactivatePlan<'info> {
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

pub fn handler(ctx: Context<DeactivatePlan>) -> Result<()> {
    let plan = &mut ctx.accounts.plan;
    plan.is_active = false;

    emit!(PlanDeactivated {
        plan: plan.key(),
        merchant: plan.merchant,
    });

    msg!("Plan deactivated: {}", plan.name);
    Ok(())
}

#[event]
pub struct PlanDeactivated {
    pub plan: Pubkey,
    pub merchant: Pubkey,
}
