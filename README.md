# Solana Subscription Billing

> A production-grade on-chain subscription billing system rebuilt from Web2 patterns (Stripe/Recurly) as a Solana program in Rust.

**Built for the [Superteam Poland Bounty](https://superteam.fun/earn/listing/rebuild-production-backend-systems-as-on-chain-rust-programs): Rebuild Production Backend Systems as On-Chain Rust Programs**

## Overview

This project demonstrates how traditional SaaS subscription billing — the backbone of services like Stripe Billing, Recurly, and Chargebee — can be rebuilt as a trustless, transparent on-chain system using Solana's account model and the Anchor framework.

## How It Works in Web2

Traditional subscription billing (e.g., Stripe) relies on:

| Component | Web2 Implementation |
|-----------|-------------------|
| **Customer Data** | PostgreSQL rows with encrypted payment methods |
| **Plans/Prices** | Database records with pricing tiers |
| **Subscriptions** | Stateful records managed by a billing engine |
| **Recurring Charges** | Background workers + payment processor APIs |
| **Invoices** | Generated documents stored in object storage |
| **Webhooks** | HTTP callbacks for state change notifications |
| **Analytics** | Data warehouse aggregations |

**Architecture:**
```
Customer → REST API → Billing Engine → PostgreSQL
                    ↓                    ↓
              Payment Processor     Webhook System
              (Stripe/Braintree)    (HTTP callbacks)
                    ↓
              Invoice Generation
```

## How It Works on Solana

Every component maps to an on-chain equivalent:

| Web2 | Solana Equivalent |
|------|------------------|
| Customer database row | Subscriber's wallet (Pubkey) |
| Plan/Price record | Plan PDA account |
| Subscription record | Subscription PDA account |
| Payment processing | SPL Token CPI transfer |
| Invoice document | Invoice PDA (immutable receipt) |
| Webhooks | Program events (logs) |
| Analytics dashboard | MerchantStats PDA account |
| Auth/sessions | Ed25519 signatures |
| Cron billing | Cranker pattern (external trigger) |

**Architecture:**
```
Subscriber Wallet → Subscribe IX → Subscription PDA created
                                 → SPL Token transfer to Treasury PDA
                                 → Invoice PDA created
                                 → Event emitted

Cranker/Subscriber → Renew IX → Time check (Clock sysvar)
                              → Payment transferred
                              → Period extended
                              → Invoice PDA created
```

## Account Model

```
Merchant PDA ──────── ["merchant", authority]
├── MerchantStats PDA ── ["stats", merchant]
├── Treasury PDA ──────── ["treasury", merchant]  (Token Account)
└── Plan PDA ──────────── ["plan", merchant, plan_id]
    └── Subscription PDA ── ["subscription", plan, subscriber]
        └── Invoice PDA ──── ["invoice", subscription, payment_number]
```

### State Machine

```
                 subscribe()
                    │
                    ▼
              ┌──────────┐
              │  Active   │◄──── renew() (payment succeeds)
              └────┬──────┘
                   │
          ┌────────┼────────┐
          │        │        │
     cancel()   period   grace period
          │     expires    expires
          ▼        ▼        ▼
    ┌───────────┐ ┌──────────┐
    │ Cancelled │ │ PastDue  │──── renew() fails ──→ Cancelled
    └───────────┘ └──────────┘
```

## Instructions

| Instruction | Signer | Description |
|------------|--------|-------------|
| `initialize_merchant` | Merchant | Creates merchant, stats, and treasury accounts |
| `create_plan` | Merchant | Creates a subscription plan with pricing & interval |
| `update_plan` | Merchant | Updates plan parameters (future subscribers only) |
| `deactivate_plan` | Merchant | Stops accepting new subscribers |
| `subscribe` | Customer | Subscribes to plan, pays first cycle |
| `renew` | Customer/Cranker | Processes renewal payment when period ends |
| `cancel` | Customer | Cancels subscription (active until period end) |
| `change_plan` | Customer | Upgrades/downgrades with prorated credit |
| `close_subscription` | Customer | Closes expired account, reclaims rent |
| `withdraw` | Merchant | Withdraws collected payments from treasury |

## Tradeoffs & Constraints

| Aspect | Web2 | Solana | Tradeoff |
|--------|------|--------|----------|
| **Latency** | <100ms API response | ~400ms confirmation | Slower but trustless |
| **Cost per operation** | Free (absorbed by SaaS) | ~0.00025 SOL per tx | Minimal, predictable |
| **Billing automation** | Server-side cron | Requires external cranker | No native scheduling |
| **Privacy** | Data encrypted at rest | All data public on-chain | Not suitable for PII |
| **Refunds** | Instant via payment processor | Requires merchant cooperation | No chargebacks |
| **Scalability** | Millions of subs per DB | Account size limits apply | ~10K subs per plan practical |
| **Composability** | APIs, webhooks | Any program can CPI | Natively interoperable |
| **Trust model** | Trust the company | Trust the code | Verifiable, auditable |
| **Time precision** | Millisecond cron | Slot-based (~400ms blocks) | Sufficient for billing |
| **Storage** | Cheap (pennies/GB) | Expensive (rent) | Close accounts to reclaim |

## Tech Stack

- **On-chain program:** Rust + Anchor Framework 0.31.0
- **Token standard:** SPL Token (USDC compatible)
- **Client SDK:** TypeScript (Anchor generated)
- **CLI:** TypeScript + Commander.js
- **Testing:** Anchor test framework (Mocha/Chai)

## Getting Started

### Prerequisites

- Rust 1.93+
- Solana CLI 3.0+
- Anchor CLI 0.31.0
- Node.js 18+

### Build

```bash
anchor build
```

### Test

```bash
anchor test
```

### Deploy to Devnet

```bash
anchor deploy --provider.cluster devnet
```

## Devnet Deployment

- **Program ID:** `TBD`
- **Transaction Links:** `TBD`

## Project Structure

```
├── programs/subscription_billing/src/
│   ├── lib.rs                    # Program entrypoint & instruction dispatch
│   ├── state/                    # Account definitions
│   │   ├── merchant.rs           # Merchant account
│   │   ├── plan.rs               # Plan account
│   │   ├── subscription.rs       # Subscription account + status enum
│   │   ├── invoice.rs            # Invoice account
│   │   └── merchant_stats.rs     # Analytics account
│   ├── instructions/             # Instruction handlers
│   │   ├── initialize_merchant.rs
│   │   ├── create_plan.rs
│   │   ├── update_plan.rs
│   │   ├── deactivate_plan.rs
│   │   ├── subscribe.rs
│   │   ├── renew.rs
│   │   ├── cancel.rs
│   │   ├── change_plan.rs
│   │   ├── close_subscription.rs
│   │   └── withdraw.rs
│   └── errors/                   # Custom error codes
│       └── codes.rs
├── tests/                        # Integration tests
├── app/                          # TypeScript SDK & CLI
└── Anchor.toml
```

## License

MIT
