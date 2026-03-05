# Security Policy

## Supported Versions

| Version | Supported | Network |
|---------|-----------|---------|
| latest  | ✅        | Devnet  |

> **Note:** This program is deployed on **Devnet only** and has **not been audited**. Do not use in production with real funds without a professional security audit.

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly:

1. **Do NOT open a public issue.** Security vulnerabilities must be reported privately.
2. **Email:** Send details to **babuhaldiya@gmail.com** with the subject line `[SECURITY] solana-subscription-billing`.
3. **Include:**
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### Response Timeline

- **Acknowledgment:** Within 48 hours
- **Assessment:** Within 7 days
- **Fix (if confirmed):** Best effort, typically within 14 days

## Security Measures

The program implements the following security controls:

- **Authority checks** on all privileged instructions (merchant management, plan creation)
- **PDA-based account derivation** to prevent account spoofing
- **Token account ownership validation** before transfers
- **Overflow-safe arithmetic** using checked math operations
- **Rent-exempt account initialization** to prevent garbage collection attacks

## Scope

This policy applies to:
- The Anchor program in `programs/subscription_billing/`
- The TypeScript client SDK in `client/`
- The test suite in `tests/`

Infrastructure, CI/CD, and deployment tooling are out of scope.

## Disclaimer

This software is provided "as is" without warranty. It is experimental and intended for educational and development purposes on Solana Devnet. Use at your own risk.
