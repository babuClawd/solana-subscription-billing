# Solana Subscription Billing

> A production-grade on-chain subscription billing system built with Anchor on Solana — the Web3 equivalent of Stripe Billing / Recurly.

**Program ID:** `2NxEGwW787jkeK5PSFMsQxPLy1MzXv1QUpuXhmRann2o`  
**Network:** Devnet  
**Deploy Tx:** [`VY8opF1hSNNA...`](https://explorer.solana.com/tx/VY8opF1hSNNAfz8TVq7QvsFjJT7nAuQhDG6sU92Mpb5LMdnzFMN84yCcssZ8rtFMRTBDvfpDKoD99X8iUS4j31f?cluster=devnet)  
**Explorer:** [View Program](https://explorer.solana.com/address/2NxEGwW787jkeK5PSFMsQxPLy1MzXv1QUpuXhmRann2o?cluster=devnet)  
**IDL (on-chain):** [`7m8TzLB2Ja3i2h3YvAu2m6ysd6FxpujjZ9VUFj2CTKX4`](https://explorer.solana.com/address/7m8TzLB2Ja3i2h3YvAu2m6ysd6FxpujjZ9VUFj2CTKX4?cluster=devnet)  
**CI:** [![CI](https://github.com/babuClawd/solana-subscription-billing/actions/workflows/ci.yml/badge.svg)](https://github.com/babuClawd/solana-subscription-billing/actions/workflows/ci.yml)

### Devnet Demo Transactions

| Action | Transaction | Accounts |
|--------|-------------|----------|
| **Initialize Merchant** | [`2cJVUQ6E...`](https://explorer.solana.com/tx/2cJVUQ6EsgjUZEYKWJ4s7stLau3kUKkWrtoWxb7ZtfdNYBTM4XFM2tfzDzpmjsJtRin6xVACUMMPQ9ggh4zByZ8s?cluster=devnet) | [Merchant](https://explorer.solana.com/address/7Jqrycs2QMkTc5yx9mBNBkugBVRKHDV7npeT7zbGzEBP?cluster=devnet) |
| **Create Plan** | [`3Mghnt4U...`](https://explorer.solana.com/tx/3Mghnt4UQ4CVvhNVmna9yyneod2Pa8WDsL8v4MWc5ZK2zAuukUPARkomjdLpvtoifBsJ9WYUQLQBfRMGbMMtuNZ9?cluster=devnet) | [Plan](https://explorer.solana.com/address/8Cvx5sW7iJfYm9mcZ9eAZ6X5RLDWokMHn3AfG7nSVe8Z?cluster=devnet) |
| **Subscribe + Pay** | [`36qqqeg5...`](https://explorer.solana.com/tx/36qqqeg5DVVuC2veA4Pz2Qx4yRMNsuK9Hb6Dv2a1botkHDQrBjspPytuVc3jRWkratMmtdMGkitWEp2f3u8Wezca?cluster=devnet) | [Subscription](https://explorer.solana.com/address/9M5HEuJgdqAgf3fzLRiG68zegPQZGwrfnUu5gfhE4VTP?cluster=devnet) |

> All transactions are live on Devnet. Click to inspect accounts, instruction data, and token transfers on Solana Explorer.

---

## Table of Contents

- [Architecture: Web2 vs Solana](#architecture-web2-vs-solana)
- [Account Model](#account-model)
- [Instructions](#instructions)
- [Design Decisions & Tradeoffs](#design-decisions--tradeoffs)
- [Getting Started](#getting-started)
- [CLI Client](#cli-client)
- [Testing](#testing)
- [Project Structure](#project-structure)

---

## Architecture: Web2 vs Solana

### The Web2 System (Stripe Billing / Recurly)

A traditional subscription billing backend looks like this:

```
┌──────────────────────────────────────────────────────────┐
│                    APPLICATION SERVER                      │
│                                                           │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ REST API │  │  Webhook  │  │  Cron    │  │  Admin   │ │
│  │ Gateway  │  │  Handler  │  │  Jobs    │  │  Panel   │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │              │              │       │
│  ┌────┴──────────────┴──────────────┴──────────────┴───┐ │
│  │              BUSINESS LOGIC LAYER                    │ │
│  │  • Subscription state machine                        │ │
│  │  • Proration calculator                              │ │
│  │  • Invoice generator                                 │ │
│  │  • Payment retry logic                               │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                          │                                │
│  ┌──────────────────────┴──────────────────────────────┐ │
│  │              DATA LAYER (PostgreSQL)                  │ │
│  │  merchants | plans | subscriptions | invoices | ...   │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                          │                                │
│  ┌──────────────────────┴──────────────────────────────┐ │
│  │           EXTERNAL SERVICES                          │ │
│  │  Stripe API  │  PayPal  │  Email  │  Analytics       │ │
│  └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘

Trust model: You trust the server operator.
Payment flow: Server → Stripe API → Card network → Bank → Settlement (2-7 days)
State: Mutable database rows, single source of truth
Audit: Application-level logs (can be tampered with)
```

**Key components:**
| Component | Role |
|-----------|------|
| PostgreSQL tables | Merchants, plans, subscriptions, invoices, payments |
| Cron jobs | Process renewals, expire grace periods, retry failed payments |
| Webhook handlers | Receive payment confirmations from Stripe/PayPal |
| Business logic | State machine transitions, proration math, retry policies |
| Admin panel | Manual overrides, refunds, customer management |

### The Solana On-Chain Version

```
┌───────────────────────────────────────────────────────────┐
│                 SOLANA BLOCKCHAIN                          │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │        SUBSCRIPTION BILLING PROGRAM (BPF)           │ │
│  │                                                     │ │
│  │  Instructions:                                      │ │
│  │  ┌────────────┐ ┌───────────┐ ┌──────────────────┐ │ │
│  │  │ initialize │ │  create   │ │    subscribe     │ │ │
│  │  │ _merchant  │ │  _plan    │ │ renew / cancel   │ │ │
│  │  └────────────┘ └───────────┘ │ change / close   │ │ │
│  │                               │ withdraw          │ │ │
│  │                               └──────────────────┘ │ │
│  │                                                     │ │
│  │  PDA Accounts (on-chain state):                     │ │
│  │  ┌──────────┐ ┌──────┐ ┌──────────────┐ ┌───────┐ │ │
│  │  │ Merchant │ │ Plan │ │ Subscription │ │Invoice│ │ │
│  │  │  Stats   │ │      │ │              │ │       │ │ │
│  │  └──────────┘ └──────┘ └──────────────┘ └───────┘ │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                           │
│  SPL Token CPI: Direct token transfers, no intermediary   │
│  Settlement: Instant (within same transaction)            │
│  Audit: Every state change = immutable on-chain tx        │
└───────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────┐
│                    CLIENT LAYER                            │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────────┐ │
│  │ CLI Tool │  │ TS SDK   │  │ Crank bot (off-chain)  │ │
│  └──────────┘  └──────────┘  │ triggers renewals      │ │
│                               └────────────────────────┘ │
└───────────────────────────────────────────────────────────┘

Trust model: Trust the code (verified, immutable).
Payment flow: Subscriber wallet → Treasury PDA (instant, atomic)
State: PDA accounts, deterministic addresses, globally readable
Audit: Every transaction is an immutable, public record
```

### Side-by-Side Comparison

| Aspect | Web2 (Stripe/Recurly) | Solana On-Chain |
|--------|----------------------|-----------------|
| **State storage** | PostgreSQL rows | PDA accounts (Merchant, Plan, Subscription, Invoice, Stats) |
| **Payment processing** | Stripe API → card networks (2-7 day settlement) | SPL Token CPI transfer (instant, atomic, ~400ms) |
| **Trust model** | Trust the operator + payment processor | Trust the code — verified, open-source, immutable |
| **Subscription state machine** | Application code (can have bugs, can be changed) | On-chain program (auditable, deterministic) |
| **Invoices** | Database records (mutable, deletable) | On-chain accounts (immutable receipts) |
| **Proration** | Server-side calculation (opaque) | On-chain calculation (transparent, verifiable) |
| **Renewals** | Cron jobs + webhooks | Permissionless cranking (anyone can trigger) |
| **Merchant analytics** | SQL queries on application DB | MerchantStats PDA (real-time, on-chain) |
| **Access control** | JWT/API keys, RBAC middleware | PDA seeds + signer verification (cryptographic) |
| **Audit trail** | Application logs (tamperable) | Blockchain transactions (immutable) |
| **Downtime** | Server outages affect billing | Solana network uptime (~99.9%) |
| **Cost per operation** | Server hosting + Stripe fees (2.9% + $0.30) | Transaction fee (~$0.00025) + rent (~$0.002/account) |
| **Chargebacks** | Major pain point (fraud, disputes) | Impossible — payments are pre-authorized |
| **Multi-currency** | Complex FX + settlement | Any SPL token (USDC, USDT, custom) — same code |
| **Scalability** | Vertical scaling, DB sharding | Horizontal (accounts are independent, parallel tx) |

### What's Gained

1. **Zero payment processor fees** — No Stripe 2.9%. Just ~$0.00025 per tx.
2. **Instant settlement** — No waiting 2-7 days for bank transfers.
3. **Immutable invoices** — Every payment is a permanent on-chain receipt.
4. **Permissionless integration** — Anyone can build on top, read state, trigger renewals.
5. **No chargebacks** — Payments are cryptographically authorized.
6. **Transparent proration** — Math is on-chain, verifiable by anyone.
7. **Global by default** — No geographic restrictions on merchants or subscribers.

### What's Lost (Tradeoffs)

1. **No automatic recurring charges** — Web2 systems pull from saved cards. On-chain requires subscriber to sign each renewal (or delegate via a crank bot).
2. **Account rent costs** — Each PDA costs ~0.002 SOL in rent. At scale, this is significant.
3. **No built-in dispute resolution** — Web2 has chargeback systems (imperfect but they exist).
4. **UX friction** — Subscribers need wallets and tokens. No "enter credit card."
5. **Upgrade complexity** — Program upgrades require careful migration (Web2: just deploy new code).
6. **Stack size limits** — Solana's 4KB stack forces boxing of large account structs.

---

## Account Model

Five PDA account types, all deterministically derived:

```
Merchant ["merchant", authority]
    ├── Plan ["plan", merchant, plan_id_bytes]       (N plans per merchant)
    │     └── Subscription ["subscription", plan, subscriber]
    │           └── Invoice ["invoice", subscription, payment_number_bytes]
    ├── MerchantStats ["stats", merchant]
    └── Treasury ["treasury", merchant]              (SPL token account)
```

### Account Sizes

| Account | Fields | Size (bytes) | Rent (SOL) |
|---------|--------|-------------|------------|
| Merchant | authority, mint, treasury, name(32), plan_count, bump | ~145 | ~0.0018 |
| Plan | merchant, plan_id, name(32), price, intervals, flags, bump | ~130 | ~0.0016 |
| Subscription | subscriber, plan, merchant, timestamps, status, bump | ~122 | ~0.0015 |
| Invoice | subscription, plan, amount, timestamps, number, bump | ~113 | ~0.0014 |
| MerchantStats | merchant, revenue, counters, bump | ~81 | ~0.0010 |

---

## Instructions

| # | Instruction | Who Signs | What It Does |
|---|------------|-----------|-------------|
| 1 | `initialize_merchant` | Merchant authority | Creates Merchant + Stats + Treasury accounts |
| 2 | `create_plan` | Merchant authority | Creates a new subscription Plan |
| 3 | `update_plan` | Merchant authority | Updates price/interval/grace/max (future subs only) |
| 4 | `deactivate_plan` | Merchant authority | Stops new subscriptions on this plan |
| 5 | `subscribe` | Subscriber | Creates Subscription + first Invoice, pays first cycle |
| 6 | `renew` | Subscriber (+ payer) | Pays next cycle, extends period, creates Invoice |
| 7 | `cancel` | Subscriber | Disables auto-renew, marks as Cancelled |
| 8 | `change_plan` | Subscriber | Prorated upgrade/downgrade between plans |
| 9 | `close_subscription` | Subscriber | Reclaims rent from expired/cancelled subscription |
| 10 | `withdraw` | Merchant authority | Transfers tokens from treasury to destination |

### Subscription State Machine

```
                 subscribe()
                     │
                     ▼
                 ┌────────┐
      renew() ──▶│ Active │◀── renew() (reactivates from PastDue)
                 └───┬────┘
                     │ period expires
                     ▼
                ┌──────────┐
                │ PastDue  │─── grace period expires ──▶ auto-cancel
                └────┬─────┘
                     │ cancel() or grace expires
                     ▼
               ┌───────────┐
               │ Cancelled │──── close_subscription() ──▶ account closed
               └───────────┘
```

---

## Design Decisions & Tradeoffs

### 1. SOL-less Renewal Design (Cranker Pattern)
The `renew` instruction separates `subscriber` (who authorizes the token transfer) from `payer` (who pays the tx fee + invoice rent). This enables **crank bots** — off-chain services that trigger renewals on behalf of subscribers, paying the gas fees.

**Web2 equivalent:** Stripe's background payment retry system.

### 2. Prorated Plan Changes
`change_plan` calculates credit from unused time on the old plan and applies it to the new plan price. This is the same proration model Stripe uses, but computed transparently on-chain.

### 3. Immutable Invoices
Each payment creates a new Invoice PDA (keyed by subscription + payment number). These are **append-only** — once created, they can never be modified. This provides an auditable payment history without relying on off-chain databases.

### 4. PDA-Owned Treasury
The treasury is a token account owned by the Merchant PDA (not the merchant's wallet). This means funds can only be withdrawn through the program's `withdraw` instruction, which enforces that only the authorized merchant wallet can access funds.

### 5. Account Boxing for Stack Safety
Solana enforces a 4KB stack limit per frame. The `ChangePlan` instruction requires 11 accounts — exceeding this limit. We use `Box<Account<...>>` to move large account structs to the heap, reducing the stack footprint by ~1KB.

### 6. MerchantStats as Separate PDA
Instead of adding counters to the Merchant account, stats live in a separate `MerchantStats` PDA. This keeps the Merchant account small and separates concerns — merchant config vs analytics.

---

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (1.79+)
- [Solana CLI](https://docs.solanalabs.com/cli/install) (v2.1.0 recommended)
- [Anchor](https://www.anchor-lang.com/docs/installation) (v0.31.0)
- [Node.js](https://nodejs.org/) (v18+)

### Build

```bash
# Clone
git clone https://github.com/babuClawd/solana-subscription-billing.git
cd solana-subscription-billing

# Build the SBF binary
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cargo-build-sbf --manifest-path programs/subscription_billing/Cargo.toml --sbf-out-dir target/deploy

# Note: `anchor build` may fail at IDL generation due to anchor-syn/host-rustc
# incompatibility. The SBF binary builds correctly. IDL is committed in idl/.
```

### Deploy

```bash
solana config set --url devnet
solana airdrop 5  # Need ~3.5 SOL for program deploy
solana program deploy target/deploy/subscription_billing.so
```

### Known Build Issues

The Solana SBF toolchain ships rustc 1.79, which doesn't support Rust Edition 2024. Some transitive dependencies (`blake3`, `constant_time_eq`) have released versions requiring edition2024. We pin these in `Cargo.toml`:

```toml
blake3 = "=1.5.5"
constant_time_eq = "=0.3.1"
```

Additionally, `indexmap`, `borsh`, and `proc-macro-crate` may need downgrading in `Cargo.lock`:
```bash
cargo update borsh@1.6.0 --precise 1.5.5
cargo update proc-macro-crate@3.4.0 --precise 3.2.0
cargo update indexmap@2.13.0 --precise 2.7.0
```

---

## CLI Client

```bash
cd client
npm install
```

### Quick Demo

Run the full end-to-end demo (creates mint, merchant, plan, subscribes):

```bash
npx ts-node src/index.ts demo
```

### Individual Commands

```bash
# Initialize merchant
npx ts-node src/index.ts init-merchant --name "My SaaS" --mint <USDC_MINT>

# Create a plan (price in atomic units, interval in seconds)
npx ts-node src/index.ts create-plan --name "Pro Monthly" --price 10000000 --interval 2592000

# Subscribe to a plan
npx ts-node src/index.ts subscribe --merchant <MERCHANT_PDA> --plan <PLAN_PDA>

# Cancel subscription
npx ts-node src/index.ts cancel --merchant <MERCHANT_PDA> --plan <PLAN_PDA>

# Withdraw treasury funds
npx ts-node src/index.ts withdraw --amount 5000000 --destination <TOKEN_ACCOUNT>

# View merchant info
npx ts-node src/index.ts show-merchant

# View plan details
npx ts-node src/index.ts show-plan --plan <PLAN_PDA>

# View subscription
npx ts-node src/index.ts show-subscription --subscription <SUB_PDA>
```

---

## Testing

17 integration tests covering all instructions, both happy paths and error cases. Tests run against the deployed Devnet program using ephemeral keypairs.

```bash
# Install test dependencies (from project root)
npm install

# Run the full test suite
npm test
```

### Test Coverage

| Category | Tests | What's Verified |
|----------|-------|-----------------|
| **Initialize Merchant** | 3 | Correct state, duplicate rejection, empty name validation |
| **Create Plan** | 3 | Correct state, zero price rejection, minimum interval validation |
| **Update Plan** | 2 | Price update, unauthorized access rejection |
| **Subscribe** | 2 | State + invoice + payment + stats, duplicate rejection |
| **Cancel** | 2 | State transition + stats update, double-cancel rejection |
| **Deactivate Plan** | 2 | Plan deactivation, subscription rejection on inactive plan |
| **Withdraw** | 2 | Treasury → destination transfer, excess withdrawal rejection |
| **Close Subscription** | 1 | Rent reclamation + account deletion |

```
  Subscription Billing Program
    Initialize Merchant
      ✔ creates a merchant with correct state
      ✔ rejects duplicate merchant initialization
      ✔ rejects empty merchant name
    Create Plan
      ✔ creates a plan with correct state
      ✔ rejects zero price
      ✔ rejects interval less than 60 seconds
    Update Plan
      ✔ updates plan price
      ✔ rejects unauthorized update
    Subscribe
      ✔ subscribes and creates invoice
      ✔ rejects duplicate subscription
    Cancel
      ✔ cancels an active subscription
      ✔ rejects cancelling an already cancelled subscription
    Deactivate Plan
      ✔ deactivates a plan
      ✔ rejects subscribing to a deactivated plan
    Withdraw
      ✔ withdraws funds from treasury
      ✔ rejects withdrawal exceeding treasury balance
    Close Subscription
      ✔ closes a cancelled subscription and reclaims rent

  17 passing (21s)
```

---

## Project Structure

```
solana-subscription-billing/
├── programs/
│   └── subscription_billing/
│       └── src/
│           ├── lib.rs              # Program entry, instruction routing
│           ├── state/              # Account definitions (Merchant, Plan, Subscription, Invoice, Stats)
│           ├── instructions/       # Instruction handlers (10 instructions)
│           └── errors/             # Custom error codes
├── idl/
│   └── subscription_billing.json  # Program IDL (committed for client/test use)
├── tests/
│   └── subscription_billing.test.ts  # 17 integration tests (Devnet)
├── client/
│   └── src/
│       └── index.ts               # TypeScript CLI client
├── Anchor.toml                    # Anchor configuration
├── Cargo.toml                     # Workspace config + dependency pins
├── LICENSE                        # MIT License
└── README.md                      # This file
```

---

## License

MIT

---

## Security Considerations

This program is deployed on **Devnet only** and has not been audited. Key security measures implemented:

- **Access control:** All merchant operations enforce `has_one = authority` via PDA seeds
- **Overflow protection:** All arithmetic uses `checked_add`/`checked_sub` with explicit error handling
- **PDA-owned treasury:** Funds can only be withdrawn through program-authorized CPI transfers
- **Input validation:** Plan names (1-32 chars), prices (> 0), intervals (≥ 60s), grace periods (≥ 0)
- **State machine enforcement:** Subscriptions follow Active → PastDue → Cancelled transitions; invalid transitions are rejected
- **Immutable invoices:** Once created, invoice data cannot be modified

**Not yet implemented:** Verifiable build, on-chain IDL upload, multisig upgrade authority. These would be required before mainnet deployment.

---

Built by [@babuClawd](https://github.com/babuClawd) for the [Superteam Earn bounty](https://superteam.fun/earn/listing/rebuild-production-backend-systems-as-on-chain-rust-programs).
