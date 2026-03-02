#!/usr/bin/env node
/**
 * Subscription Billing CLI — interact with the on-chain program from the terminal.
 *
 * Usage:
 *   npx ts-node src/index.ts init-merchant --name "Acme SaaS" --mint <USDC_MINT>
 *   npx ts-node src/index.ts create-plan --name "Pro Monthly" --price 10000000 --interval 2592000
 *   npx ts-node src/index.ts subscribe --plan <PLAN_PUBKEY>
 *   npx ts-node src/index.ts renew --subscription <SUB_PUBKEY>
 *   npx ts-node src/index.ts cancel --subscription <SUB_PUBKEY>
 *   npx ts-node src/index.ts withdraw --amount 5000000
 *   npx ts-node src/index.ts show-merchant
 *   npx ts-node src/index.ts show-plan --plan <PLAN_PUBKEY>
 *   npx ts-node src/index.ts show-subscription --subscription <SUB_PUBKEY>
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

// ---------- Helpers ----------

function loadKeypair(kpPath?: string): Keypair {
  const p =
    kpPath || path.join(os.homedir(), ".config", "solana", "id.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function getConnection(rpcUrl?: string): Connection {
  return new Connection(rpcUrl || clusterApiUrl("devnet"), "confirmed");
}

function loadIdl(): any {
  const idlPath = path.resolve(
    __dirname,
    "../../target/idl/subscription_billing.json"
  );
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

function getProgram(
  connection: Connection,
  wallet: anchor.Wallet
): anchor.Program {
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const idl = loadIdl();
  return new anchor.Program(idl, provider);
}

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

function findPlanPda(
  merchant: PublicKey,
  planId: number
): [PublicKey, number] {
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

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function formatStatus(status: any): string {
  if (status.active) return "Active";
  if (status.pastDue) return "PastDue";
  if (status.cancelled) return "Cancelled";
  return JSON.stringify(status);
}

// ---------- CLI ----------

const program = new Command();

program
  .name("billing-cli")
  .description("CLI for the Solana Subscription Billing program")
  .version("0.1.0")
  .option("-k, --keypair <path>", "Path to keypair JSON")
  .option("-u, --url <url>", "RPC URL (default: devnet)");

// ---- init-merchant ----
program
  .command("init-merchant")
  .description("Initialize a new merchant account")
  .requiredOption("--name <name>", "Merchant name (max 32 chars)")
  .requiredOption("--mint <pubkey>", "SPL token mint for payments (e.g. USDC)")
  .action(async (opts) => {
    const parent = program.opts();
    const kp = loadKeypair(parent.keypair);
    const conn = getConnection(parent.url);
    const wallet = new anchor.Wallet(kp);
    const prog = getProgram(conn, wallet);

    const [merchantPda] = findMerchantPda(kp.publicKey);
    const [statsPda] = findStatsPda(merchantPda);
    const [treasuryPda] = findTreasuryPda(merchantPda);
    const mint = new PublicKey(opts.mint);

    console.log("Initializing merchant...");
    console.log(`  Merchant PDA: ${merchantPda}`);
    console.log(`  Stats PDA:    ${statsPda}`);
    console.log(`  Treasury PDA: ${treasuryPda}`);

    const tx = await prog.methods
      .initializeMerchant(opts.name)
      .accounts({
        merchant: merchantPda,
        stats: statsPda,
        paymentMint: mint,
        treasury: treasuryPda,
        authority: kp.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([kp])
      .rpc();

    console.log(`\n✅ Merchant initialized!`);
    console.log(`   Tx: ${tx}`);
    console.log(
      `   Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );
  });

// ---- create-plan ----
program
  .command("create-plan")
  .description("Create a subscription plan")
  .requiredOption("--name <name>", "Plan name")
  .requiredOption("--price <lamports>", "Price per cycle (token atomic units)")
  .requiredOption("--interval <seconds>", "Billing interval in seconds")
  .option("--grace <seconds>", "Grace period in seconds", "86400")
  .option("--max-subscribers <n>", "Max subscribers (0 = unlimited)", "0")
  .action(async (opts) => {
    const parent = program.opts();
    const kp = loadKeypair(parent.keypair);
    const conn = getConnection(parent.url);
    const wallet = new anchor.Wallet(kp);
    const prog = getProgram(conn, wallet);

    const [merchantPda] = findMerchantPda(kp.publicKey);

    // Fetch merchant to get plan_count
    const merchantAccount = await (prog.account as any).merchant.fetch(merchantPda);
    const planCount = (merchantAccount as any).planCount.toNumber();
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
      .accounts({
        merchant: merchantPda,
        plan: planPda,
        authority: kp.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([kp])
      .rpc();

    console.log(`\n✅ Plan created!`);
    console.log(`   Plan ID: ${planCount}`);
    console.log(`   Tx: ${tx}`);
    console.log(
      `   Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );
  });

// ---- subscribe ----
program
  .command("subscribe")
  .description("Subscribe to a plan")
  .requiredOption("--merchant <pubkey>", "Merchant PDA")
  .requiredOption("--plan <pubkey>", "Plan PDA")
  .action(async (opts) => {
    const parent = program.opts();
    const kp = loadKeypair(parent.keypair);
    const conn = getConnection(parent.url);
    const wallet = new anchor.Wallet(kp);
    const prog = getProgram(conn, wallet);

    const merchantPda = new PublicKey(opts.merchant);
    const planPda = new PublicKey(opts.plan);
    const [subscriptionPda] = findSubscriptionPda(planPda, kp.publicKey);
    const [invoicePda] = findInvoicePda(subscriptionPda, 0);
    const [statsPda] = findStatsPda(merchantPda);

    const merchantAccount = await (prog.account as any).merchant.fetch(merchantPda);
    const mint = (merchantAccount as any).paymentMint as PublicKey;
    const treasury = (merchantAccount as any).treasury as PublicKey;

    const subscriberAta = getAssociatedTokenAddressSync(mint, kp.publicKey);

    console.log("Subscribing...");
    console.log(`  Subscription PDA: ${subscriptionPda}`);

    const tx = await prog.methods
      .subscribe()
      .accounts({
        merchant: merchantPda,
        plan: planPda,
        subscription: subscriptionPda,
        invoice: invoicePda,
        stats: statsPda,
        subscriberTokenAccount: subscriberAta,
        treasury: treasury,
        subscriber: kp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([kp])
      .rpc();

    console.log(`\n✅ Subscribed!`);
    console.log(`   Tx: ${tx}`);
    console.log(
      `   Explorer: https://explorer.solana.com/tx/${tx}?cluster=devnet`
    );
  });

// ---- cancel ----
program
  .command("cancel")
  .description("Cancel a subscription")
  .requiredOption("--merchant <pubkey>", "Merchant PDA")
  .requiredOption("--plan <pubkey>", "Plan PDA")
  .action(async (opts) => {
    const parent = program.opts();
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
      .accounts({
        merchant: merchantPda,
        plan: planPda,
        subscription: subscriptionPda,
        stats: statsPda,
        subscriber: kp.publicKey,
      } as any)
      .signers([kp])
      .rpc();

    console.log(`\n✅ Subscription cancelled.`);
    console.log(`   Tx: ${tx}`);
  });

// ---- withdraw ----
program
  .command("withdraw")
  .description("Withdraw funds from treasury")
  .requiredOption("--amount <tokens>", "Amount in token atomic units")
  .requiredOption("--destination <pubkey>", "Destination token account")
  .action(async (opts) => {
    const parent = program.opts();
    const kp = loadKeypair(parent.keypair);
    const conn = getConnection(parent.url);
    const wallet = new anchor.Wallet(kp);
    const prog = getProgram(conn, wallet);

    const [merchantPda] = findMerchantPda(kp.publicKey);
    const merchantAccount = await (prog.account as any).merchant.fetch(merchantPda);
    const treasury = (merchantAccount as any).treasury as PublicKey;

    const tx = await prog.methods
      .withdraw(new anchor.BN(opts.amount))
      .accounts({
        merchant: merchantPda,
        treasury: treasury,
        destination: new PublicKey(opts.destination),
        authority: kp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([kp])
      .rpc();

    console.log(`\n✅ Withdrawn ${opts.amount} tokens.`);
    console.log(`   Tx: ${tx}`);
  });

// ---- show-merchant ----
program
  .command("show-merchant")
  .description("Display merchant account info")
  .option("--authority <pubkey>", "Merchant authority (default: your keypair)")
  .action(async (opts) => {
    const parent = program.opts();
    const kp = loadKeypair(parent.keypair);
    const conn = getConnection(parent.url);
    const wallet = new anchor.Wallet(kp);
    const prog = getProgram(conn, wallet);

    const authority = opts.authority
      ? new PublicKey(opts.authority)
      : kp.publicKey;
    const [merchantPda] = findMerchantPda(authority);
    const [statsPda] = findStatsPda(merchantPda);

    const merchant = (await (prog.account as any).merchant.fetch(merchantPda)) as any;
    const stats = (await (prog.account as any).merchantStats.fetch(statsPda)) as any;

    console.log(`\n=== Merchant: ${merchant.name} ===`);
    console.log(`  PDA:          ${merchantPda}`);
    console.log(`  Authority:    ${merchant.authority}`);
    console.log(`  Payment Mint: ${merchant.paymentMint}`);
    console.log(`  Treasury:     ${merchant.treasury}`);
    console.log(`  Plans:        ${merchant.planCount}`);
    console.log(`\n--- Stats ---`);
    console.log(`  Revenue:       ${stats.totalRevenue}`);
    console.log(`  Active Subs:   ${stats.activeSubscribers}`);
    console.log(`  Total Subs:    ${stats.totalSubscriptions}`);
    console.log(`  Invoices:      ${stats.totalInvoices}`);
    console.log(`  Cancellations: ${stats.totalCancellations}`);
  });

// ---- show-plan ----
program
  .command("show-plan")
  .description("Display plan details")
  .requiredOption("--plan <pubkey>", "Plan PDA")
  .action(async (opts) => {
    const parent = program.opts();
    const kp = loadKeypair(parent.keypair);
    const conn = getConnection(parent.url);
    const wallet = new anchor.Wallet(kp);
    const prog = getProgram(conn, wallet);

    const plan = (await (prog.account as any).plan.fetch(
      new PublicKey(opts.plan)
    )) as any;

    const intervalDays = (plan.intervalSeconds.toNumber() / 86400).toFixed(1);
    const graceDays = (plan.gracePeriodSeconds.toNumber() / 86400).toFixed(1);

    console.log(`\n=== Plan: ${plan.name} ===`);
    console.log(`  PDA:         ${opts.plan}`);
    console.log(`  Merchant:    ${plan.merchant}`);
    console.log(`  Plan ID:     ${plan.planId}`);
    console.log(`  Price:       ${plan.price} tokens/cycle`);
    console.log(`  Interval:    ${plan.intervalSeconds}s (${intervalDays} days)`);
    console.log(`  Grace:       ${plan.gracePeriodSeconds}s (${graceDays} days)`);
    console.log(`  Active:      ${plan.isActive}`);
    console.log(
      `  Subscribers: ${plan.subscriberCount}${
        plan.maxSubscribers > 0 ? ` / ${plan.maxSubscribers}` : " (unlimited)"
      }`
    );
  });

// ---- show-subscription ----
program
  .command("show-subscription")
  .description("Display subscription details")
  .requiredOption("--subscription <pubkey>", "Subscription PDA")
  .action(async (opts) => {
    const parent = program.opts();
    const kp = loadKeypair(parent.keypair);
    const conn = getConnection(parent.url);
    const wallet = new anchor.Wallet(kp);
    const prog = getProgram(conn, wallet);

    const sub = (await (prog.account as any).subscription.fetch(
      new PublicKey(opts.subscription)
    )) as any;

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
  });

// ---- demo ----
program
  .command("demo")
  .description("Run a full demo: create mint, init merchant, create plan, subscribe")
  .action(async () => {
    const parent = program.opts();
    const kp = loadKeypair(parent.keypair);
    const conn = getConnection(parent.url);
    const wallet = new anchor.Wallet(kp);
    const prog = getProgram(conn, wallet);

    console.log("🚀 Running full demo on devnet...\n");
    console.log(`Wallet: ${kp.publicKey}`);
    const bal = await conn.getBalance(kp.publicKey);
    console.log(`Balance: ${bal / LAMPORTS_PER_SOL} SOL\n`);

    // Step 1: Create a test SPL mint
    console.log("1️⃣  Creating test SPL token mint...");
    const mint = await createMint(conn, kp, kp.publicKey, null, 6);
    console.log(`   Mint: ${mint}\n`);

    // Step 2: Create ATA and mint tokens to self
    console.log("2️⃣  Minting 1000 test tokens to wallet...");
    const ata = await getOrCreateAssociatedTokenAccount(
      conn,
      kp,
      mint,
      kp.publicKey
    );
    await mintTo(conn, kp, mint, ata.address, kp, 1_000_000_000); // 1000 tokens with 6 decimals
    console.log(`   ATA: ${ata.address}\n`);

    // Step 3: Initialize merchant
    console.log("3️⃣  Initializing merchant...");
    const [merchantPda] = findMerchantPda(kp.publicKey);
    const [statsPda] = findStatsPda(merchantPda);
    const [treasuryPda] = findTreasuryPda(merchantPda);

    const tx1 = await prog.methods
      .initializeMerchant("Demo SaaS Co")
      .accounts({
        merchant: merchantPda,
        stats: statsPda,
        paymentMint: mint,
        treasury: treasuryPda,
        authority: kp.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([kp])
      .rpc();
    console.log(`   Merchant: ${merchantPda}`);
    console.log(`   Tx: https://explorer.solana.com/tx/${tx1}?cluster=devnet\n`);

    // Step 4: Create plan
    console.log("4️⃣  Creating 'Pro Monthly' plan (10 tokens, 120s interval for demo)...");
    const [planPda] = findPlanPda(merchantPda, 0);

    const tx2 = await prog.methods
      .createPlan(
        "Pro Monthly",
        new anchor.BN(10_000_000), // 10 tokens
        new anchor.BN(120), // 2 min interval for testing
        new anchor.BN(60), // 1 min grace
        null
      )
      .accounts({
        merchant: merchantPda,
        plan: planPda,
        authority: kp.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([kp])
      .rpc();
    console.log(`   Plan: ${planPda}`);
    console.log(`   Tx: https://explorer.solana.com/tx/${tx2}?cluster=devnet\n`);

    // Step 5: Subscribe
    console.log("5️⃣  Subscribing to plan...");
    const [subPda] = findSubscriptionPda(planPda, kp.publicKey);
    const [invoicePda] = findInvoicePda(subPda, 0);

    const tx3 = await prog.methods
      .subscribe()
      .accounts({
        merchant: merchantPda,
        plan: planPda,
        subscription: subPda,
        invoice: invoicePda,
        stats: statsPda,
        subscriberTokenAccount: ata.address,
        treasury: treasuryPda,
        subscriber: kp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .signers([kp])
      .rpc();
    console.log(`   Subscription: ${subPda}`);
    console.log(`   Tx: https://explorer.solana.com/tx/${tx3}?cluster=devnet\n`);

    // Step 6: Show results
    console.log("6️⃣  Final state:\n");
    const merchant = (await (prog.account as any).merchant.fetch(merchantPda)) as any;
    const stats = (await (prog.account as any).merchantStats.fetch(statsPda)) as any;
    const sub = (await (prog.account as any).subscription.fetch(subPda)) as any;

    console.log(`   Merchant: ${merchant.name}`);
    console.log(`   Revenue: ${stats.totalRevenue} (atomic units)`);
    console.log(`   Active subscribers: ${stats.activeSubscribers}`);
    console.log(`   Subscription status: ${formatStatus(sub.status)}`);
    console.log(`   Period ends: ${formatTimestamp(sub.currentPeriodEnd.toNumber())}`);
    console.log(`\n🎉 Demo complete! All transactions on Devnet.`);
  });

program.parse();
