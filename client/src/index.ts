#!/usr/bin/env node
/**
 * Subscription Billing CLI — interact with the on-chain program from the terminal.
 *
 * Usage:
 *   npx ts-node src/index.ts demo
 *   npx ts-node src/index.ts init-merchant --name "Acme SaaS" --mint <USDC_MINT>
 *   npx ts-node src/index.ts create-plan --name "Pro Monthly" --price 10000000 --interval 2592000
 *   npx ts-node src/index.ts subscribe --plan <PLAN_PUBKEY>
 *   npx ts-node src/index.ts cancel --merchant <MERCHANT_PDA> --plan <PLAN_PDA>
 *   npx ts-node src/index.ts withdraw --amount 5000000 --destination <TOKEN_ACCOUNT>
 *   npx ts-node src/index.ts show-merchant
 *   npx ts-node src/index.ts show-plan --plan <PLAN_PDA>
 *   npx ts-node src/index.ts show-subscription --subscription <SUB_PDA>
 */

import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------- Constants ----------
const PROGRAM_ID = new PublicKey(
  "2NxEGwW787jkeK5PSFMsQxPLy1MzXv1QUpuXhmRann2o"
);

// ---------- IDL Type ----------
// We load the IDL at runtime from the JSON file. Anchor's Program class
// accepts `Idl` but the hand-crafted IDL is compatible at runtime.
type SubscriptionBillingIDL = anchor.Idl;

// ---------- Account Data Interfaces ----------

interface MerchantAccount {
  authority: PublicKey;
  paymentMint: PublicKey;
  treasury: PublicKey;
  name: string;
  planCount: anchor.BN;
  bump: number;
}

interface MerchantStatsAccount {
  merchant: PublicKey;
  totalRevenue: anchor.BN;
  activeSubscribers: anchor.BN;
  totalInvoices: anchor.BN;
  totalSubscriptions: anchor.BN;
  totalCancellations: anchor.BN;
  bump: number;
}

interface PlanAccount {
  merchant: PublicKey;
  planId: anchor.BN;
  name: string;
  price: anchor.BN;
  intervalSeconds: anchor.BN;
  gracePeriodSeconds: anchor.BN;
  isActive: boolean;
  maxSubscribers: anchor.BN;
  subscriberCount: anchor.BN;
  bump: number;
}

interface SubscriptionAccount {
  subscriber: PublicKey;
  plan: PublicKey;
  merchant: PublicKey;
  createdAt: anchor.BN;
  currentPeriodEnd: anchor.BN;
  status: { active: {} } | { pastDue: {} } | { cancelled: {} };
  paymentsMade: anchor.BN;
  autoRenew: boolean;
  bump: number;
}

// ---------- Helpers ----------

function loadKeypair(kpPath?: string): Keypair {
  const p = kpPath || path.join(os.homedir(), ".config", "solana", "id.json");
  if (!fs.existsSync(p)) {
    throw new Error(
      `Keypair file not found: ${p}\n` +
        `Run 'solana-keygen new' to create one, or pass --keypair <path>.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function getConnection(rpcUrl?: string): Connection {
  return new Connection(rpcUrl || clusterApiUrl("devnet"), "confirmed");
}

function loadIdl(): SubscriptionBillingIDL {
  // Try committed idl/ first, then fall back to target/idl/ (local builds)
  const idlDir = path.resolve(__dirname, "../../idl/subscription_billing.json");
  const idlTarget = path.resolve(__dirname, "../../target/idl/subscription_billing.json");
  const idlPath = fs.existsSync(idlDir) ? idlDir : idlTarget;
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `IDL not found. Looked in:\n  ${idlDir}\n  ${idlTarget}\n` +
        `Ensure the project is built (see README for build instructions).`
    );
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

function getProgram(
  connection: Connection,
  wallet: anchor.Wallet
): anchor.Program<SubscriptionBillingIDL> {
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = loadIdl();
  return new anchor.Program(idl, provider);
}

/**
 * Type-safe account fetcher for runtime-loaded IDLs.
 * Anchor's AccountNamespace doesn't expose index signatures for dynamic IDLs,
 * so we cast through a record type to access named account namespaces.
 */
interface AccountFetcher {
  fetch: (address: PublicKey) => Promise<Record<string, unknown>>;
  fetchNullable: (address: PublicKey) => Promise<Record<string, unknown> | null>;
}

function accounts(prog: anchor.Program<SubscriptionBillingIDL>): Record<string, AccountFetcher> {
  return prog.account as unknown as Record<string, AccountFetcher>;
}

/** Fetch a program account, returning null if it doesn't exist. */
async function fetchAccountOrNull<T>(
  fetcher: AccountFetcher,
  address: PublicKey
): Promise<T | null> {
  try {
    return (await fetcher.fetch(address)) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Account does not exist") || msg.includes("could not find")) {
      return null;
    }
    throw err;
  }
}

// ---------- PDA Derivation ----------

function findMerchantPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("merchant"), authority.toBuffer()],
    PROGRAM_ID
  );
}

function findStatsPda(merchant: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("stats"), merchant.toBuffer()],
    PROGRAM_ID
  );
}

function findTreasuryPda(merchant: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("treasury"), merchant.toBuffer()],
    PROGRAM_ID
  );
}

function findPlanPda(merchant: PublicKey, planId: number): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(planId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("plan"), merchant.toBuffer(), buf],
    PROGRAM_ID
  );
}

function findSubscriptionPda(
  plan: PublicKey,
  subscriber: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("subscription"), plan.toBuffer(), subscriber.toBuffer()],
    PROGRAM_ID
  );
}

function findInvoicePda(
  subscription: PublicKey,
  invoiceNumber: number
): [PublicKey, number] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(invoiceNumber));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("invoice"), subscription.toBuffer(), buf],
    PROGRAM_ID
  );
}

// ---------- Formatting ----------

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function formatStatus(
  status: { active: {} } | { pastDue: {} } | { cancelled: {} }
): string {
  if ("active" in status) return "Active";
  if ("pastDue" in status) return "PastDue";
  if ("cancelled" in status) return "Cancelled";
  return JSON.stringify(status);
}

function formatTokenAmount(amount: anchor.BN | number, decimals = 6): string {
  const raw = typeof amount === "number" ? amount : amount.toNumber();
  return (raw / 10 ** decimals).toFixed(decimals);
}

function explorerTxUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function explorerAddrUrl(addr: string | PublicKey): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

/** Parse Anchor/Solana errors into human-readable messages. */
function formatError(err: unknown): string {
  if (err instanceof anchor.AnchorError) {
    return `Program error: ${err.error.errorMessage} (code ${err.error.errorCode.number})`;
  }
  if (err instanceof Error) {
    // Check for "already in use" (account already initialized)
    if (err.message.includes("already in use")) {
      return "Account already exists. This merchant/plan/subscription has already been initialized.";
    }
    // Check for insufficient funds
    if (err.message.includes("insufficient funds") || err.message.includes("InsufficientFunds")) {
      return "Insufficient token balance for this operation.";
    }
    // Custom program error codes
    const match = err.message.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (match) {
      const code = parseInt(match[1], 16);
      if (code === 0) return "Account already exists (already initialized).";
      return `Program error code: ${code} (${match[1]})`;
    }
    return err.message;
  }
  return String(err);
}

// ---------- CLI Setup ----------

const cli = new Command();

cli
  .name("billing-cli")
  .description("CLI for the Solana Subscription Billing program")
  .version("0.1.0")
  .option("-k, --keypair <path>", "Path to keypair JSON")
  .option("-u, --url <url>", "RPC URL (default: devnet)");

// ---- init-merchant ----
cli
  .command("init-merchant")
  .description("Initialize a new merchant account")
  .requiredOption("--name <name>", "Merchant name (max 32 chars)")
  .requiredOption("--mint <pubkey>", "SPL token mint for payments (e.g. USDC)")
  .action(async (opts) => {
    try {
      const parent = cli.opts();
      const kp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);
      const wallet = new anchor.Wallet(kp);
      const prog = getProgram(conn, wallet);

      const [merchantPda] = findMerchantPda(kp.publicKey);
      const [statsPda] = findStatsPda(merchantPda);
      const [treasuryPda] = findTreasuryPda(merchantPda);
      const mint = new PublicKey(opts.mint);

      // Check if already initialized
      const existing = await fetchAccountOrNull<MerchantAccount>(
        accounts(prog)["merchant"],
        merchantPda
      );
      if (existing) {
        console.log(`\n⚠️  Merchant already exists for this wallet.`);
        console.log(`   PDA: ${merchantPda}`);
        console.log(`   Name: ${existing.name}`);
        console.log(`   Use 'show-merchant' to see details.`);
        return;
      }

      console.log("Initializing merchant...");
      console.log(`  Merchant PDA: ${merchantPda}`);
      console.log(`  Stats PDA:    ${statsPda}`);
      console.log(`  Treasury PDA: ${treasuryPda}`);

      const tx = await prog.methods
        .initializeMerchant(opts.name)
        .accountsPartial({
          merchant: merchantPda,
          stats: statsPda,
          paymentMint: mint,
          treasury: treasuryPda,
          authority: kp.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([kp])
        .rpc();

      console.log(`\n✅ Merchant initialized!`);
      console.log(`   Tx: ${tx}`);
      console.log(`   Explorer: ${explorerTxUrl(tx)}`);
    } catch (err) {
      console.error(`\n❌ Failed to initialize merchant: ${formatError(err)}`);
      process.exit(1);
    }
  });

// ---- create-plan ----
cli
  .command("create-plan")
  .description("Create a subscription plan")
  .requiredOption("--name <name>", "Plan name")
  .requiredOption("--price <lamports>", "Price per cycle (token atomic units)")
  .requiredOption("--interval <seconds>", "Billing interval in seconds")
  .option("--grace <seconds>", "Grace period in seconds", "86400")
  .option("--max-subscribers <n>", "Max subscribers (0 = unlimited)", "0")
  .action(async (opts) => {
    try {
      const parent = cli.opts();
      const kp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);
      const wallet = new anchor.Wallet(kp);
      const prog = getProgram(conn, wallet);

      const [merchantPda] = findMerchantPda(kp.publicKey);

      const merchantAccount = await accounts(prog)["merchant"].fetch(merchantPda) as unknown as MerchantAccount;
      const planCount = merchantAccount.planCount.toNumber();
      const [planPda] = findPlanPda(merchantPda, planCount);

      console.log(`Creating plan #${planCount}...`);
      console.log(`  Plan PDA: ${planPda}`);

      const maxSubs = parseInt(opts.maxSubscribers);
      const tx = await prog.methods
        .createPlan(
          opts.name,
          new anchor.BN(opts.price),
          new anchor.BN(opts.interval),
          new anchor.BN(opts.grace),
          maxSubs > 0 ? new anchor.BN(maxSubs) : null
        )
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          authority: kp.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([kp])
        .rpc();

      console.log(`\n✅ Plan created!`);
      console.log(`   Plan ID: ${planCount}`);
      console.log(`   Tx: ${tx}`);
      console.log(`   Explorer: ${explorerTxUrl(tx)}`);
    } catch (err) {
      console.error(`\n❌ Failed to create plan: ${formatError(err)}`);
      process.exit(1);
    }
  });

// ---- subscribe ----
cli
  .command("subscribe")
  .description("Subscribe to a plan")
  .requiredOption("--merchant <pubkey>", "Merchant PDA")
  .requiredOption("--plan <pubkey>", "Plan PDA")
  .action(async (opts) => {
    try {
      const parent = cli.opts();
      const kp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);
      const wallet = new anchor.Wallet(kp);
      const prog = getProgram(conn, wallet);

      const merchantPda = new PublicKey(opts.merchant);
      const planPda = new PublicKey(opts.plan);
      const [subscriptionPda] = findSubscriptionPda(planPda, kp.publicKey);
      const [invoicePda] = findInvoicePda(subscriptionPda, 0);
      const [statsPda] = findStatsPda(merchantPda);

      // Check for existing subscription
      const existingSub = await fetchAccountOrNull<SubscriptionAccount>(
        accounts(prog)["subscription"],
        subscriptionPda
      );
      if (existingSub) {
        console.log(`\n⚠️  Already subscribed to this plan.`);
        console.log(`   Status: ${formatStatus(existingSub.status)}`);
        console.log(`   Period ends: ${formatTimestamp(existingSub.currentPeriodEnd.toNumber())}`);
        return;
      }

      const merchantAccount = await accounts(prog)["merchant"].fetch(merchantPda) as unknown as MerchantAccount;
      const subscriberAta = getAssociatedTokenAddressSync(
        merchantAccount.paymentMint,
        kp.publicKey
      );

      console.log("Subscribing...");
      console.log(`  Subscription PDA: ${subscriptionPda}`);

      const tx = await prog.methods
        .subscribe()
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          subscription: subscriptionPda,
          invoice: invoicePda,
          stats: statsPda,
          subscriberTokenAccount: subscriberAta,
          treasury: merchantAccount.treasury,
          subscriber: kp.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([kp])
        .rpc();

      console.log(`\n✅ Subscribed!`);
      console.log(`   Tx: ${tx}`);
      console.log(`   Explorer: ${explorerTxUrl(tx)}`);
    } catch (err) {
      console.error(`\n❌ Failed to subscribe: ${formatError(err)}`);
      process.exit(1);
    }
  });

// ---- cancel ----
cli
  .command("cancel")
  .description("Cancel a subscription")
  .requiredOption("--merchant <pubkey>", "Merchant PDA")
  .requiredOption("--plan <pubkey>", "Plan PDA")
  .action(async (opts) => {
    try {
      const parent = cli.opts();
      const kp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);
      const wallet = new anchor.Wallet(kp);
      const prog = getProgram(conn, wallet);

      const merchantPda = new PublicKey(opts.merchant);
      const planPda = new PublicKey(opts.plan);
      const [subscriptionPda] = findSubscriptionPda(planPda, kp.publicKey);
      const [statsPda] = findStatsPda(merchantPda);

      const tx = await prog.methods
        .cancel()
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          subscription: subscriptionPda,
          stats: statsPda,
          subscriber: kp.publicKey,
        })
        .signers([kp])
        .rpc();

      console.log(`\n✅ Subscription cancelled.`);
      console.log(`   Tx: ${tx}`);
      console.log(`   Explorer: ${explorerTxUrl(tx)}`);
    } catch (err) {
      console.error(`\n❌ Failed to cancel: ${formatError(err)}`);
      process.exit(1);
    }
  });

// ---- withdraw ----
cli
  .command("withdraw")
  .description("Withdraw funds from treasury")
  .requiredOption("--amount <tokens>", "Amount in token atomic units")
  .requiredOption("--destination <pubkey>", "Destination token account")
  .action(async (opts) => {
    try {
      const parent = cli.opts();
      const kp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);
      const wallet = new anchor.Wallet(kp);
      const prog = getProgram(conn, wallet);

      const [merchantPda] = findMerchantPda(kp.publicKey);
      const merchantAccount = await accounts(prog)["merchant"].fetch(merchantPda) as unknown as MerchantAccount;

      const tx = await prog.methods
        .withdraw(new anchor.BN(opts.amount))
        .accountsPartial({
          merchant: merchantPda,
          treasury: merchantAccount.treasury,
          destination: new PublicKey(opts.destination),
          authority: kp.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([kp])
        .rpc();

      console.log(`\n✅ Withdrawn ${opts.amount} tokens.`);
      console.log(`   Tx: ${tx}`);
      console.log(`   Explorer: ${explorerTxUrl(tx)}`);
    } catch (err) {
      console.error(`\n❌ Failed to withdraw: ${formatError(err)}`);
      process.exit(1);
    }
  });

// ---- show-merchant ----
cli
  .command("show-merchant")
  .description("Display merchant account info")
  .option("--authority <pubkey>", "Merchant authority (default: your keypair)")
  .action(async (opts) => {
    try {
      const parent = cli.opts();
      const kp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);
      const wallet = new anchor.Wallet(kp);
      const prog = getProgram(conn, wallet);

      const authority = opts.authority
        ? new PublicKey(opts.authority)
        : kp.publicKey;
      const [merchantPda] = findMerchantPda(authority);
      const [statsPda] = findStatsPda(merchantPda);

      const merchant = await fetchAccountOrNull<MerchantAccount>(
        accounts(prog)["merchant"],
        merchantPda
      );
      if (!merchant) {
        console.log(`\n⚠️  No merchant found for authority: ${authority}`);
        console.log(`   Expected PDA: ${merchantPda}`);
        return;
      }

      const stats = await accounts(prog)["merchantStats"].fetch(statsPda) as unknown as MerchantStatsAccount;

      console.log(`\n=== Merchant: ${merchant.name} ===`);
      console.log(`  PDA:          ${merchantPda}`);
      console.log(`  Authority:    ${merchant.authority}`);
      console.log(`  Payment Mint: ${merchant.paymentMint}`);
      console.log(`  Treasury:     ${merchant.treasury}`);
      console.log(`  Plans:        ${merchant.planCount}`);
      console.log(`\n--- Stats ---`);
      console.log(`  Revenue:       ${stats.totalRevenue} tokens`);
      console.log(`  Active Subs:   ${stats.activeSubscribers}`);
      console.log(`  Total Subs:    ${stats.totalSubscriptions}`);
      console.log(`  Invoices:      ${stats.totalInvoices}`);
      console.log(`  Cancellations: ${stats.totalCancellations}`);
    } catch (err) {
      console.error(`\n❌ Failed to fetch merchant: ${formatError(err)}`);
      process.exit(1);
    }
  });

// ---- show-plan ----
cli
  .command("show-plan")
  .description("Display plan details")
  .requiredOption("--plan <pubkey>", "Plan PDA")
  .action(async (opts) => {
    try {
      const parent = cli.opts();
      const kp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);
      const wallet = new anchor.Wallet(kp);
      const prog = getProgram(conn, wallet);

      const plan = await accounts(prog)["plan"].fetch(new PublicKey(opts.plan)) as unknown as PlanAccount;

      const intervalDays = (plan.intervalSeconds.toNumber() / 86400).toFixed(1);
      const graceDays = (plan.gracePeriodSeconds.toNumber() / 86400).toFixed(1);

      console.log(`\n=== Plan: ${plan.name} ===`);
      console.log(`  PDA:         ${opts.plan}`);
      console.log(`  Merchant:    ${plan.merchant}`);
      console.log(`  Plan ID:     ${plan.planId}`);
      console.log(`  Price:       ${plan.price} tokens/cycle`);
      console.log(
        `  Interval:    ${plan.intervalSeconds}s (${intervalDays} days)`
      );
      console.log(`  Grace:       ${plan.gracePeriodSeconds}s (${graceDays} days)`);
      console.log(`  Active:      ${plan.isActive}`);
      console.log(
        `  Subscribers: ${plan.subscriberCount}${
          plan.maxSubscribers.toNumber() > 0
            ? ` / ${plan.maxSubscribers}`
            : " (unlimited)"
        }`
      );
    } catch (err) {
      console.error(`\n❌ Failed to fetch plan: ${formatError(err)}`);
      process.exit(1);
    }
  });

// ---- show-subscription ----
cli
  .command("show-subscription")
  .description("Display subscription details")
  .requiredOption("--subscription <pubkey>", "Subscription PDA")
  .action(async (opts) => {
    try {
      const parent = cli.opts();
      const kp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);
      const wallet = new anchor.Wallet(kp);
      const prog = getProgram(conn, wallet);

      const sub = await accounts(prog)["subscription"].fetch(
        new PublicKey(opts.subscription)
      ) as unknown as SubscriptionAccount;

      console.log(`\n=== Subscription ===`);
      console.log(`  PDA:         ${opts.subscription}`);
      console.log(`  Subscriber:  ${sub.subscriber}`);
      console.log(`  Plan:        ${sub.plan}`);
      console.log(`  Merchant:    ${sub.merchant}`);
      console.log(`  Status:      ${formatStatus(sub.status)}`);
      console.log(`  Created:     ${formatTimestamp(sub.createdAt.toNumber())}`);
      console.log(
        `  Period End:  ${formatTimestamp(sub.currentPeriodEnd.toNumber())}`
      );
      console.log(`  Payments:    ${sub.paymentsMade}`);
      console.log(`  Auto-renew:  ${sub.autoRenew}`);
    } catch (err) {
      console.error(`\n❌ Failed to fetch subscription: ${formatError(err)}`);
      process.exit(1);
    }
  });

// ---- demo ----
cli
  .command("demo")
  .description(
    "Run a full end-to-end demo: create mint, init merchant, create plan, subscribe.\n" +
      "Uses an ephemeral keypair funded from the main wallet so it's safe to run multiple times."
  )
  .action(async () => {
    try {
      const parent = cli.opts();
      const fundingKp = loadKeypair(parent.keypair);
      const conn = getConnection(parent.url);

      console.log("🚀 Running full demo on devnet...\n");
      console.log(`Funding wallet: ${fundingKp.publicKey}`);
      const bal = await conn.getBalance(fundingKp.publicKey);
      console.log(`Balance: ${bal / LAMPORTS_PER_SOL} SOL`);

      if (bal < 0.1 * LAMPORTS_PER_SOL) {
        console.error(
          "\n❌ Insufficient SOL. Need at least 0.1 SOL for demo. Run: solana airdrop 1"
        );
        process.exit(1);
      }

      // Create ephemeral keypair for this demo run (ensures idempotency)
      const demoKp = Keypair.generate();
      console.log(`Demo keypair:   ${demoKp.publicKey} (ephemeral)\n`);

      // Fund the demo keypair
      console.log("0️⃣  Funding demo keypair with 0.05 SOL...");
      const fundTx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: fundingKp.publicKey,
          toPubkey: demoKp.publicKey,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        })
      );
      await anchor.web3.sendAndConfirmTransaction(conn, fundTx, [fundingKp]);
      console.log(`   Funded ✓\n`);

      const wallet = new anchor.Wallet(demoKp);
      const prog = getProgram(conn, wallet);

      // Step 1: Create a test SPL mint
      console.log("1️⃣  Creating test SPL token mint...");
      const mint = await createMint(conn, demoKp, demoKp.publicKey, null, 6);
      console.log(`   Mint: ${mint}\n`);

      // Step 2: Create ATA and mint tokens
      console.log("2️⃣  Minting 1,000 test tokens to demo wallet...");
      const ata = await getOrCreateAssociatedTokenAccount(
        conn,
        demoKp,
        mint,
        demoKp.publicKey
      );
      await mintTo(conn, demoKp, mint, ata.address, demoKp, 1_000_000_000);
      console.log(`   ATA: ${ata.address}\n`);

      // Step 3: Initialize merchant
      console.log("3️⃣  Initializing merchant...");
      const [merchantPda] = findMerchantPda(demoKp.publicKey);
      const [statsPda] = findStatsPda(merchantPda);
      const [treasuryPda] = findTreasuryPda(merchantPda);

      const tx1 = await prog.methods
        .initializeMerchant("Demo SaaS Co")
        .accountsPartial({
          merchant: merchantPda,
          stats: statsPda,
          paymentMint: mint,
          treasury: treasuryPda,
          authority: demoKp.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([demoKp])
        .rpc();
      console.log(`   Merchant: ${merchantPda}`);
      console.log(`   Tx: ${explorerTxUrl(tx1)}\n`);

      // Step 4: Create plan
      console.log(
        "4️⃣  Creating 'Pro Monthly' plan (10 tokens, 120s interval for demo)..."
      );
      const [planPda] = findPlanPda(merchantPda, 0);

      const tx2 = await prog.methods
        .createPlan(
          "Pro Monthly",
          new anchor.BN(10_000_000), // 10 tokens (6 decimals)
          new anchor.BN(120), // 2 min interval for testing
          new anchor.BN(60), // 1 min grace
          null
        )
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          authority: demoKp.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([demoKp])
        .rpc();
      console.log(`   Plan: ${planPda}`);
      console.log(`   Tx: ${explorerTxUrl(tx2)}\n`);

      // Step 5: Subscribe
      console.log("5️⃣  Subscribing to plan...");
      const [subPda] = findSubscriptionPda(planPda, demoKp.publicKey);
      const [invoicePda] = findInvoicePda(subPda, 0);

      const tx3 = await prog.methods
        .subscribe()
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          subscription: subPda,
          invoice: invoicePda,
          stats: statsPda,
          subscriberTokenAccount: ata.address,
          treasury: treasuryPda,
          subscriber: demoKp.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([demoKp])
        .rpc();
      console.log(`   Subscription: ${subPda}`);
      console.log(`   Tx: ${explorerTxUrl(tx3)}\n`);

      // Step 6: Show results
      console.log("6️⃣  Final state:\n");
      const merchant = await accounts(prog)["merchant"].fetch(merchantPda) as unknown as MerchantAccount;
      const stats = await accounts(prog)["merchantStats"].fetch(statsPda) as unknown as MerchantStatsAccount;
      const sub = await accounts(prog)["subscription"].fetch(subPda) as unknown as SubscriptionAccount;

      console.log(`   Merchant:     ${merchant.name}`);
      console.log(`   Revenue:      ${formatTokenAmount(stats.totalRevenue)} tokens`);
      console.log(`   Active subs:  ${stats.activeSubscribers}`);
      console.log(`   Sub status:   ${formatStatus(sub.status)}`);
      console.log(
        `   Period ends:  ${formatTimestamp(sub.currentPeriodEnd.toNumber())}`
      );
      console.log(`\n🎉 Demo complete! All transactions on Devnet.`);
      console.log(
        `\n💡 Explore the accounts:`
      );
      console.log(`   Merchant: ${explorerAddrUrl(merchantPda)}`);
      console.log(`   Plan:     ${explorerAddrUrl(planPda)}`);
      console.log(`   Sub:      ${explorerAddrUrl(subPda)}`);
    } catch (err) {
      console.error(`\n❌ Demo failed: ${formatError(err)}`);
      process.exit(1);
    }
  });

cli.parse();
