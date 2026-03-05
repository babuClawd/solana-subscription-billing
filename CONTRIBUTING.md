# Contributing to Solana Subscription Billing

Thanks for your interest in contributing! This project is open source and welcomes contributions from the Solana community.

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Solana CLI](https://docs.solanalabs.com/cli/install) (v1.18+)
- [Anchor](https://www.anchor-lang.com/docs/installation) (v0.30+)
- [Node.js](https://nodejs.org/) (v18+)

### Local Setup

```bash
# Clone the repo
git clone https://github.com/babuClawd/solana-subscription-billing.git
cd solana-subscription-billing

# Build the program
anchor build

# Run tests
anchor test
```

## How to Contribute

### Good First Contributions

- **Documentation:** Improve README, add examples, fix typos
- **Tests:** Add edge case tests, improve coverage
- **Client SDK:** Improve the TypeScript CLI client
- **Error messages:** Make error codes more descriptive

### Before You Start

1. Check existing [issues](https://github.com/babuClawd/solana-subscription-billing/issues) and [PRs](https://github.com/babuClawd/solana-subscription-billing/pulls)
2. Open an issue to discuss your idea before writing code
3. For security-related changes, read [SECURITY.md](SECURITY.md) first

### Making Changes

1. Fork the repo and create a branch from `master`
2. Make your changes — keep them focused and minimal
3. Add or update tests if applicable
4. Ensure CI passes (`anchor build`, `cargo clippy`, `cargo fmt`)
5. Write a clear commit message
6. Open a PR explaining **what**, **why**, and **how**

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add grace period notification
fix: correct overflow in invoice calculation
docs: update CLI usage examples
test: add cancel-after-expiry edge case
```

### Code Style

- **Rust:** Follow `cargo fmt` and `cargo clippy` with no warnings
- **TypeScript:** Standard formatting, explicit types
- **Tests:** Descriptive names, test one behavior per test

## Project Structure

```
programs/subscription_billing/
├── src/
│   ├── instructions/   # Instruction handlers
│   ├── state/          # Account structures
│   ├── errors/         # Custom error codes
│   └── lib.rs          # Program entry point
client/
├── src/index.ts        # CLI client
tests/
├── subscription_billing.test.ts
```

## Code of Conduct

Be respectful, constructive, and collaborative. We're all here to build.

## Questions?

Open an issue or reach out. Happy building! 🚀
