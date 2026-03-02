use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("11111111111111111111111111111111"); // Will be replaced after keygen

#[program]
pub mod subscription_billing {
    use super::*;

    /// Initialize a new merchant account with a treasury for collecting payments.
    pub fn initialize_merchant(ctx: Context<InitializeMerchant>, name: String) -> Result<()> {
        instructions::initialize_merchant::handler(ctx, name)
    }

    /// Create a new subscription plan under a merchant.
    pub fn create_plan(
        ctx: Context<CreatePlan>,
        name: String,
        price: u64,
        interval_seconds: i64,
        grace_period_seconds: i64,
        max_subscribers: Option<u64>,
    ) -> Result<()> {
        instructions::create_plan::handler(
            ctx,
            name,
            price,
            interval_seconds,
            grace_period_seconds,
            max_subscribers,
        )
    }

    /// Update an existing plan (only affects future subscribers).
    pub fn update_plan(
        ctx: Context<UpdatePlan>,
        new_price: Option<u64>,
        new_interval: Option<i64>,
        new_grace_period: Option<i64>,
        new_max_subscribers: Option<u64>,
    ) -> Result<()> {
        instructions::update_plan::handler(ctx, new_price, new_interval, new_grace_period, new_max_subscribers)
    }

    /// Deactivate a plan so no new subscriptions can be created.
    pub fn deactivate_plan(ctx: Context<DeactivatePlan>) -> Result<()> {
        instructions::deactivate_plan::handler(ctx)
    }

    /// Subscribe to a plan. Pays the first billing cycle upfront.
    pub fn subscribe(ctx: Context<Subscribe>) -> Result<()> {
        instructions::subscribe::handler(ctx)
    }

    /// Renew an active subscription. Can be called by subscriber or a cranker.
    pub fn renew(ctx: Context<Renew>) -> Result<()> {
        instructions::renew::handler(ctx)
    }

    /// Cancel a subscription. Stops auto-renewal at period end.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::cancel::handler(ctx)
    }

    /// Change plan (upgrade/downgrade). Prorated credit applied.
    pub fn change_plan(ctx: Context<ChangePlan>) -> Result<()> {
        instructions::change_plan::handler(ctx)
    }

    /// Close an expired/cancelled subscription account to reclaim rent.
    pub fn close_subscription(ctx: Context<CloseSubscription>) -> Result<()> {
        instructions::close_subscription::handler(ctx)
    }

    /// Merchant withdraws collected payments from treasury.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }
}
