import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import { fileURLToPath } from "url";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Constants ----------
const PROGRAM_ID = new PublicKey(
  "2NxEGwW787jkeK5PSFMsQxPLy1MzXv1QUpuXhmRann2o"
);
const RPC_URL = "https://api.devnet.solana.com";

// ---------- IDL & Program Setup ----------

function loadIdl(): anchor.Idl {
  // Try committed idl/ first, then fall back to target/idl/ (local builds)
  const idlDir = path.resolve(__dirname, "../idl/subscription_billing.json");
  const idlTarget = path.resolve(__dirname, "../target/idl/subscription_billing.json");
  const idlPath = fs.existsSync(idlDir) ? idlDir : idlTarget;
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

interface AccountFetcher {
  fetch: (address: PublicKey) => Promise<Record<string, any>>;
}

function acct(
  prog: anchor.Program
): Record<string, AccountFetcher> {
  return prog.account as unknown as Record<string, AccountFetcher>;
}

// ---------- PDA Helpers ----------

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

// ---------- Test Helpers ----------

async function airdropAndConfirm(
  conn: Connection,
  to: PublicKey,
  lamports: number
): Promise<void> {
  const sig = await conn.requestAirdrop(to, lamports);
  await conn.confirmTransaction(sig, "confirmed");
}

async function fundFromMain(
  conn: Connection,
  mainKp: Keypair,
  to: PublicKey,
  lamports: number
): Promise<void> {
  const tx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: mainKp.publicKey,
      toPubkey: to,
      lamports,
    })
  );
  await anchor.web3.sendAndConfirmTransaction(conn, tx, [mainKp]);
}

function loadMainKeypair(): Keypair {
  const p = path.join(os.homedir(), ".config", "solana", "id.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// ---------- Test Suite ----------

describe("Subscription Billing Program", () => {
  const conn = new Connection(RPC_URL, "confirmed");
  const mainKp = loadMainKeypair();

  // Each test group uses a fresh keypair
  let authority: Keypair;
  let wallet: anchor.Wallet;
  let prog: anchor.Program;
  let mint: PublicKey;
  let authorityAta: PublicKey;
  let merchantPda: PublicKey;
  let statsPda: PublicKey;
  let treasuryPda: PublicKey;

  before(async function () {
    this.timeout(60_000);

    // Create fresh authority for this test run
    authority = Keypair.generate();
    wallet = new anchor.Wallet(authority);
    const provider = new anchor.AnchorProvider(conn, wallet, {
      commitment: "confirmed",
    });
    const idl = loadIdl();
    prog = new anchor.Program(idl, provider);

    // Fund authority
    await fundFromMain(conn, mainKp, authority.publicKey, 0.08 * LAMPORTS_PER_SOL);

    // Create test mint
    mint = await createMint(conn, authority, authority.publicKey, null, 6);

    // Mint 10,000 tokens to authority
    const ataAccount = await getOrCreateAssociatedTokenAccount(
      conn,
      authority,
      mint,
      authority.publicKey
    );
    authorityAta = ataAccount.address;
    await mintTo(conn, authority, mint, authorityAta, authority, 10_000_000_000);

    // Derive PDAs
    [merchantPda] = findMerchantPda(authority.publicKey);
    [statsPda] = findStatsPda(merchantPda);
    [treasuryPda] = findTreasuryPda(merchantPda);
  });

  // ====== MERCHANT TESTS ======

  describe("Initialize Merchant", () => {
    it("creates a merchant with correct state", async function () {
      this.timeout(30_000);

      await prog.methods
        .initializeMerchant("Test SaaS")
        .accountsPartial({
          merchant: merchantPda,
          stats: statsPda,
          paymentMint: mint,
          treasury: treasuryPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();

      const merchant = await acct(prog)["merchant"].fetch(merchantPda);
      assert.equal(merchant.name, "Test SaaS");
      assert.ok(
        (merchant.authority as PublicKey).equals(authority.publicKey),
        "authority mismatch"
      );
      assert.ok(
        (merchant.paymentMint as PublicKey).equals(mint),
        "mint mismatch"
      );
      assert.equal(
        (merchant.planCount as anchor.BN).toNumber(),
        0,
        "initial plan count should be 0"
      );

      const stats = await acct(prog)["merchantStats"].fetch(statsPda);
      assert.equal(
        (stats.totalRevenue as anchor.BN).toNumber(),
        0,
        "initial revenue should be 0"
      );
      assert.equal(
        (stats.activeSubscribers as anchor.BN).toNumber(),
        0,
        "initial subscribers should be 0"
      );
    });

    it("rejects duplicate merchant initialization", async function () {
      this.timeout(30_000);
      try {
        await prog.methods
          .initializeMerchant("Duplicate")
          .accountsPartial({
            merchant: merchantPda,
            stats: statsPda,
            paymentMint: mint,
            treasury: treasuryPda,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();
        assert.fail("Should have thrown");
      } catch (err: any) {
        assert.ok(
          err.message.includes("already in use") ||
            err.message.includes("0x0") ||
            err.transactionMessage?.includes("already in use"),
          `Unexpected error: ${err.message}`
        );
      }
    });

    it("rejects empty merchant name", async function () {
      this.timeout(30_000);
      const kp2 = Keypair.generate();
      await fundFromMain(conn, mainKp, kp2.publicKey, 0.05 * LAMPORTS_PER_SOL);

      const wallet2 = new anchor.Wallet(kp2);
      const provider2 = new anchor.AnchorProvider(conn, wallet2, {
        commitment: "confirmed",
      });
      const prog2 = new anchor.Program(loadIdl(), provider2);

      const [m2] = findMerchantPda(kp2.publicKey);
      const [s2] = findStatsPda(m2);
      const [t2] = findTreasuryPda(m2);

      try {
        await prog2.methods
          .initializeMerchant("")
          .accountsPartial({
            merchant: m2,
            stats: s2,
            paymentMint: mint,
            treasury: t2,
            authority: kp2.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([kp2])
          .rpc();
        assert.fail("Should reject empty name");
      } catch (err: any) {
        assert.ok(
          err.message.includes("InvalidMerchantName") ||
            err.message.includes("custom program error"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });

  // ====== PLAN TESTS ======

  let planPda: PublicKey;

  describe("Create Plan", () => {
    it("creates a plan with correct state", async function () {
      this.timeout(30_000);

      [planPda] = findPlanPda(merchantPda, 0);

      await prog.methods
        .createPlan(
          "Pro Monthly",
          new anchor.BN(10_000_000), // 10 tokens
          new anchor.BN(120), // 2 min interval
          new anchor.BN(60), // 1 min grace
          null // unlimited
        )
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const plan = await acct(prog)["plan"].fetch(planPda);
      assert.equal(plan.name, "Pro Monthly");
      assert.equal((plan.price as anchor.BN).toNumber(), 10_000_000);
      assert.equal((plan.intervalSeconds as anchor.BN).toNumber(), 120);
      assert.equal((plan.gracePeriodSeconds as anchor.BN).toNumber(), 60);
      assert.equal(plan.isActive, true);
      assert.equal(
        (plan.maxSubscribers as anchor.BN).toNumber(),
        0,
        "0 means unlimited"
      );
      assert.equal((plan.subscriberCount as anchor.BN).toNumber(), 0);

      // Check merchant plan_count incremented
      const merchant = await acct(prog)["merchant"].fetch(merchantPda);
      assert.equal((merchant.planCount as anchor.BN).toNumber(), 1);
    });

    it("rejects zero price", async function () {
      this.timeout(30_000);
      const [plan1] = findPlanPda(merchantPda, 1);
      try {
        await prog.methods
          .createPlan("Free Plan", new anchor.BN(0), new anchor.BN(120), new anchor.BN(0), null)
          .accountsPartial({
            merchant: merchantPda,
            plan: plan1,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc();
        assert.fail("Should reject zero price");
      } catch (err: any) {
        assert.ok(
          err.message.includes("InvalidPrice") ||
            err.message.includes("custom program error"),
          `Unexpected error: ${err.message}`
        );
      }
    });

    it("rejects interval less than 60 seconds", async function () {
      this.timeout(30_000);
      const [plan1] = findPlanPda(merchantPda, 1);
      try {
        await prog.methods
          .createPlan("Quick", new anchor.BN(1000), new anchor.BN(30), new anchor.BN(0), null)
          .accountsPartial({
            merchant: merchantPda,
            plan: plan1,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc();
        assert.fail("Should reject short interval");
      } catch (err: any) {
        assert.ok(
          err.message.includes("InvalidInterval") ||
            err.message.includes("custom program error"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });

  // ====== UPDATE & DEACTIVATE PLAN TESTS ======

  describe("Update Plan", () => {
    it("updates plan price", async function () {
      this.timeout(30_000);
      await prog.methods
        .updatePlan(new anchor.BN(20_000_000), null, null, null)
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const plan = await acct(prog)["plan"].fetch(planPda);
      assert.equal((plan.price as anchor.BN).toNumber(), 20_000_000);
      // Interval unchanged
      assert.equal((plan.intervalSeconds as anchor.BN).toNumber(), 120);
    });

    it("rejects unauthorized update", async function () {
      this.timeout(30_000);
      const rando = Keypair.generate();
      await fundFromMain(conn, mainKp, rando.publicKey, 0.01 * LAMPORTS_PER_SOL);

      const randoWallet = new anchor.Wallet(rando);
      const randoProv = new anchor.AnchorProvider(conn, randoWallet, {
        commitment: "confirmed",
      });
      const randoProg = new anchor.Program(loadIdl(), randoProv);

      // Derive the merchant PDA for the rando (wrong authority)
      try {
        await randoProg.methods
          .updatePlan(new anchor.BN(1), null, null, null)
          .accountsPartial({
            merchant: merchantPda,
            plan: planPda,
            authority: rando.publicKey,
          })
          .signers([rando])
          .rpc();
        assert.fail("Should reject unauthorized");
      } catch (err: any) {
        // has_one = authority constraint will fail
        assert.ok(
          err.message.includes("ConstraintHasOne") ||
            err.message.includes("ConstraintSeeds") ||
            err.message.includes("has_one") ||
            err.message.includes("2003") ||
            err.message.includes("2006") ||
            err.message.includes("custom program error"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });

  // ====== SUBSCRIPTION TESTS ======

  let subPda: PublicKey;
  let invoicePda: PublicKey;

  describe("Subscribe", () => {
    before(async function () {
      this.timeout(15_000);
      // Reset plan price to 10 tokens for subscription tests
      await prog.methods
        .updatePlan(new anchor.BN(10_000_000), null, null, null)
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();
    });

    it("subscribes and creates invoice", async function () {
      this.timeout(30_000);

      [subPda] = findSubscriptionPda(planPda, authority.publicKey);
      [invoicePda] = findInvoicePda(subPda, 0);

      const balBefore = (await getAccount(conn, authorityAta)).amount;

      await prog.methods
        .subscribe()
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          subscription: subPda,
          invoice: invoicePda,
          stats: statsPda,
          subscriberTokenAccount: authorityAta,
          treasury: treasuryPda,
          subscriber: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      // Check subscription state
      const sub = await acct(prog)["subscription"].fetch(subPda);
      assert.ok(
        (sub.subscriber as PublicKey).equals(authority.publicKey),
        "subscriber mismatch"
      );
      assert.ok("active" in (sub.status as object), "should be Active");
      assert.equal((sub.paymentsMade as anchor.BN).toNumber(), 1);
      assert.equal(sub.autoRenew, true);

      // Check payment was deducted
      const balAfter = (await getAccount(conn, authorityAta)).amount;
      assert.equal(
        Number(balBefore - balAfter),
        10_000_000,
        "should deduct plan price"
      );

      // Check invoice
      const invoice = await acct(prog)["invoice"].fetch(invoicePda);
      assert.equal((invoice.amount as anchor.BN).toNumber(), 10_000_000);
      assert.equal((invoice.invoiceNumber as anchor.BN).toNumber(), 0);

      // Check stats updated
      const stats = await acct(prog)["merchantStats"].fetch(statsPda);
      assert.equal((stats.activeSubscribers as anchor.BN).toNumber(), 1);
      assert.equal(
        (stats.totalRevenue as anchor.BN).toNumber(),
        10_000_000,
        "revenue should reflect payment"
      );
      assert.equal((stats.totalInvoices as anchor.BN).toNumber(), 1);

      // Check plan subscriber count
      const plan = await acct(prog)["plan"].fetch(planPda);
      assert.equal((plan.subscriberCount as anchor.BN).toNumber(), 1);
    });

    it("rejects duplicate subscription", async function () {
      this.timeout(30_000);
      const [dupSub] = findSubscriptionPda(planPda, authority.publicKey);
      const [dupInv] = findInvoicePda(dupSub, 0);
      try {
        await prog.methods
          .subscribe()
          .accountsPartial({
            merchant: merchantPda,
            plan: planPda,
            subscription: dupSub,
            invoice: dupInv,
            stats: statsPda,
            subscriberTokenAccount: authorityAta,
            treasury: treasuryPda,
            subscriber: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([authority])
          .rpc();
        assert.fail("Should reject duplicate subscription");
      } catch (err: any) {
        assert.ok(
          err.message.includes("already in use") ||
            err.message.includes("0x0"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });

  // ====== CANCEL TESTS ======

  describe("Cancel", () => {
    it("cancels an active subscription", async function () {
      this.timeout(30_000);

      await prog.methods
        .cancel()
        .accountsPartial({
          merchant: merchantPda,
          plan: planPda,
          subscription: subPda,
          stats: statsPda,
          subscriber: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const sub = await acct(prog)["subscription"].fetch(subPda);
      assert.ok("cancelled" in (sub.status as object), "should be Cancelled");
      assert.equal(sub.autoRenew, false);

      // Stats decremented
      const stats = await acct(prog)["merchantStats"].fetch(statsPda);
      assert.equal((stats.activeSubscribers as anchor.BN).toNumber(), 0);
      assert.equal((stats.totalCancellations as anchor.BN).toNumber(), 1);
    });

    it("rejects cancelling an already cancelled subscription", async function () {
      this.timeout(30_000);
      try {
        await prog.methods
          .cancel()
          .accountsPartial({
            merchant: merchantPda,
            plan: planPda,
            subscription: subPda,
            stats: statsPda,
            subscriber: authority.publicKey,
          })
          .signers([authority])
          .rpc();
        assert.fail("Should reject double cancel");
      } catch (err: any) {
        assert.ok(
          err.message.includes("AlreadyCancelled") ||
            err.message.includes("custom program error"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });

  // ====== DEACTIVATE PLAN TESTS ======

  describe("Deactivate Plan", () => {
    // We need a second plan for this test to not break subscribe tests
    let plan2Pda: PublicKey;

    before(async function () {
      this.timeout(30_000);
      [plan2Pda] = findPlanPda(merchantPda, 1);
      await prog.methods
        .createPlan(
          "Basic Monthly",
          new anchor.BN(5_000_000),
          new anchor.BN(60),
          new anchor.BN(0),
          null
        )
        .accountsPartial({
          merchant: merchantPda,
          plan: plan2Pda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();
    });

    it("deactivates a plan", async function () {
      this.timeout(30_000);
      await prog.methods
        .deactivatePlan()
        .accountsPartial({
          merchant: merchantPda,
          plan: plan2Pda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const plan = await acct(prog)["plan"].fetch(plan2Pda);
      assert.equal(plan.isActive, false);
    });

    it("rejects subscribing to a deactivated plan", async function () {
      this.timeout(30_000);
      const subscriber = Keypair.generate();
      await fundFromMain(
        conn,
        mainKp,
        subscriber.publicKey,
        0.02 * LAMPORTS_PER_SOL
      );

      const subAta = await getOrCreateAssociatedTokenAccount(
        conn,
        subscriber,
        mint,
        subscriber.publicKey
      );
      await mintTo(conn, authority, mint, subAta.address, authority, 100_000_000);

      const subWallet = new anchor.Wallet(subscriber);
      const subProv = new anchor.AnchorProvider(conn, subWallet, {
        commitment: "confirmed",
      });
      const subProg = new anchor.Program(loadIdl(), subProv);

      const [subSubPda] = findSubscriptionPda(plan2Pda, subscriber.publicKey);
      const [subInvPda] = findInvoicePda(subSubPda, 0);

      try {
        await subProg.methods
          .subscribe()
          .accountsPartial({
            merchant: merchantPda,
            plan: plan2Pda,
            subscription: subSubPda,
            invoice: subInvPda,
            stats: statsPda,
            subscriberTokenAccount: subAta.address,
            treasury: treasuryPda,
            subscriber: subscriber.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([subscriber])
          .rpc();
        assert.fail("Should reject subscription to deactivated plan");
      } catch (err: any) {
        assert.ok(
          err.message.includes("PlanNotActive") ||
            err.message.includes("custom program error"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });

  // ====== WITHDRAW TESTS ======

  describe("Withdraw", () => {
    it("withdraws funds from treasury", async function () {
      this.timeout(30_000);

      const treasuryBefore = (await getAccount(conn, treasuryPda)).amount;
      const destBefore = (await getAccount(conn, authorityAta)).amount;

      // Treasury should have 10 tokens from the subscription
      assert.ok(Number(treasuryBefore) >= 10_000_000, "treasury should have funds");

      await prog.methods
        .withdraw(new anchor.BN(5_000_000))
        .accountsPartial({
          merchant: merchantPda,
          treasury: treasuryPda,
          destination: authorityAta,
          authority: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([authority])
        .rpc();

      const treasuryAfter = (await getAccount(conn, treasuryPda)).amount;
      const destAfter = (await getAccount(conn, authorityAta)).amount;

      assert.equal(
        Number(treasuryBefore - treasuryAfter),
        5_000_000,
        "treasury should decrease by withdrawal amount"
      );
      assert.equal(
        Number(destAfter - destBefore),
        5_000_000,
        "destination should increase by withdrawal amount"
      );
    });

    it("rejects withdrawal exceeding treasury balance", async function () {
      this.timeout(30_000);
      try {
        await prog.methods
          .withdraw(new anchor.BN(999_999_999_999))
          .accountsPartial({
            merchant: merchantPda,
            treasury: treasuryPda,
            destination: authorityAta,
            authority: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([authority])
          .rpc();
        assert.fail("Should reject excessive withdrawal");
      } catch (err: any) {
        assert.ok(
          err.message.includes("InsufficientTreasuryBalance") ||
            err.message.includes("custom program error"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });

  // ====== CLOSE SUBSCRIPTION TESTS ======

  describe("Close Subscription", () => {
    it("closes a cancelled subscription and reclaims rent", async function () {
      this.timeout(30_000);

      const balBefore = await conn.getBalance(authority.publicKey);

      await prog.methods
        .closeSubscription()
        .accountsPartial({
          plan: planPda,
          subscription: subPda,
          merchant: merchantPda,
          subscriber: authority.publicKey,
        })
        .signers([authority])
        .rpc();

      const balAfter = await conn.getBalance(authority.publicKey);
      // Should have gotten rent back (minus tx fee)
      assert.ok(
        balAfter > balBefore - 10_000, // accounting for tx fee
        "should reclaim rent SOL"
      );

      // Account should no longer exist
      try {
        await acct(prog)["subscription"].fetch(subPda);
        assert.fail("Account should be closed");
      } catch (err: any) {
        assert.ok(
          err.message.includes("Account does not exist") ||
            err.message.includes("could not find"),
          `Unexpected error: ${err.message}`
        );
      }
    });
  });

  // ====== RENEW VALIDATION TESTS ======
  // These tests exercise the on-chain guard conditions for the renew instruction
  // using a fresh subscription so they don't depend on the shared subPda (which
  // is closed by the Close Subscription suite above).

  describe("Renew (validation)", () => {
    let renewKp: anchor.web3.Keypair;
    let renewMerchantPda: PublicKey;
    let renewStatsPda: PublicKey;
    let renewTreasuryPda: PublicKey;
    let renewPlanPda: PublicKey;
    let renewSubPda: PublicKey;
    let renewInvoicePda: PublicKey;
    let renewAta: PublicKey;

    before(async function () {
      this.timeout(60_000);

      // Fresh keypair so these tests are independent of suite-level shared state
      renewKp = anchor.web3.Keypair.generate();

      // Airdrop SOL to fund tx fees and rent
      const sig = await conn.requestAirdrop(
        renewKp.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await conn.confirmTransaction(sig, "confirmed");

      // Derive PDAs
      [renewMerchantPda] = findMerchantPda(renewKp.publicKey);
      [renewStatsPda] = findStatsPda(renewMerchantPda);
      [renewTreasuryPda] = findTreasuryPda(renewMerchantPda);

      // Init merchant (reuse the suite-level mint)
      const renewWallet = new anchor.Wallet(renewKp);
      const renewProv = new anchor.AnchorProvider(conn, renewWallet, {
        commitment: "confirmed",
      });
      const renewProg = new anchor.Program(loadIdl(), renewProv);

      await renewProg.methods
        .initializeMerchant("RenewTestMerchant")
        .accountsPartial({
          merchant: renewMerchantPda,
          stats: renewStatsPda,
          paymentMint: mint,
          treasury: renewTreasuryPda,
          authority: renewKp.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([renewKp])
        .rpc();

      // Create a plan with a 1-hour interval (so period is not yet due)
      [renewPlanPda] = findPlanPda(renewMerchantPda, 0);
      await renewProg.methods
        .createPlan(
          "Renew Test Plan",
          new anchor.BN(10_000_000), // 10 tokens
          new anchor.BN(3600),       // 1-hour interval — won't expire in test
          new anchor.BN(300),        // 5-minute grace period
          null
        )
        .accountsPartial({
          merchant: renewMerchantPda,
          plan: renewPlanPda,
          authority: renewKp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([renewKp])
        .rpc();

      // Create a token account for renewKp and mint tokens
      const renewAtaInfo = await getOrCreateAssociatedTokenAccount(
        conn,
        renewKp,
        mint,
        renewKp.publicKey
      );
      renewAta = renewAtaInfo.address;
      await mintTo(conn, authority, mint, renewAta, authority, 100_000_000);

      // Subscribe
      [renewSubPda] = findSubscriptionPda(renewPlanPda, renewKp.publicKey);
      [renewInvoicePda] = findInvoicePda(renewSubPda, 0);

      await renewProg.methods
        .subscribe()
        .accountsPartial({
          merchant: renewMerchantPda,
          plan: renewPlanPda,
          subscription: renewSubPda,
          invoice: renewInvoicePda,
          stats: renewStatsPda,
          subscriberTokenAccount: renewAta,
          treasury: renewTreasuryPda,
          subscriber: renewKp.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([renewKp])
        .rpc();
    });

    it("rejects renewal when period is not yet due", async function () {
      this.timeout(30_000);

      const renewWallet = new anchor.Wallet(renewKp);
      const renewProv = new anchor.AnchorProvider(conn, renewWallet, {
        commitment: "confirmed",
      });
      const renewProg = new anchor.Program(loadIdl(), renewProv);

      // Invoice #1 (next renewal)
      const [nextInvoicePda] = findInvoicePda(renewSubPda, 1);

      try {
        await renewProg.methods
          .renew()
          .accountsPartial({
            merchant: renewMerchantPda,
            plan: renewPlanPda,
            subscription: renewSubPda,
            invoice: nextInvoicePda,
            stats: renewStatsPda,
            subscriberTokenAccount: renewAta,
            treasury: renewTreasuryPda,
            subscriber: renewKp.publicKey,
            payer: renewKp.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([renewKp])
          .rpc();
        assert.fail("Should have rejected renewal not yet due");
      } catch (err: any) {
        assert.ok(
          err.message.includes("RenewalNotDue") ||
            err.message.includes("not due for renewal"),
          `Expected RenewalNotDue, got: ${err.message}`
        );
      }
    });

    it("rejects renewal when auto-renew is disabled", async function () {
      this.timeout(30_000);

      const renewWallet = new anchor.Wallet(renewKp);
      const renewProv = new anchor.AnchorProvider(conn, renewWallet, {
        commitment: "confirmed",
      });
      const renewProg = new anchor.Program(loadIdl(), renewProv);

      // Cancel the subscription (sets auto_renew = false)
      await renewProg.methods
        .cancel()
        .accountsPartial({
          merchant: renewMerchantPda,
          plan: renewPlanPda,
          subscription: renewSubPda,
          stats: renewStatsPda,
          subscriber: renewKp.publicKey,
        })
        .signers([renewKp])
        .rpc();

      // Verify auto_renew is now false
      const sub = await acct(renewProg)["subscription"].fetch(renewSubPda);
      assert.equal(sub.autoRenew, false, "auto_renew should be false after cancel");

      // Invoice #1 (next renewal)
      const [nextInvoicePda] = findInvoicePda(renewSubPda, 1);

      try {
        await renewProg.methods
          .renew()
          .accountsPartial({
            merchant: renewMerchantPda,
            plan: renewPlanPda,
            subscription: renewSubPda,
            invoice: nextInvoicePda,
            stats: renewStatsPda,
            subscriberTokenAccount: renewAta,
            treasury: renewTreasuryPda,
            subscriber: renewKp.publicKey,
            payer: renewKp.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([renewKp])
          .rpc();
        assert.fail("Should have rejected renewal with auto-renew disabled");
      } catch (err: any) {
        // The renew handler checks auto_renew before checking period — so we expect
        // AlreadyCancelled (the error reused for auto_renew=false guard).
        assert.ok(
          err.message.includes("AlreadyCancelled") ||
            err.message.includes("already been cancelled"),
          `Expected AlreadyCancelled, got: ${err.message}`
        );
      }
    });
  });
});
