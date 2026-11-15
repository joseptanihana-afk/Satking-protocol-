#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { Keypair, PublicKey } from '@solana/web3.js';
import { PROTOCOL_DEFAULTS, SolanaStakingRoiProtocol, calculateNativePosRoi } from './index.js';

function loadKeypair(keypairPath?: string): Keypair {
  const resolved = (keypairPath || process.env.KEYPAIR_PATH || '~/.config/solana/id.json').replace(
    /^~/,
    os.homedir(),
  );
  const secret = JSON.parse(fs.readFileSync(path.resolve(resolved), 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function getRpcUrl(cluster: string, custom?: string): string {
  if (custom) return custom;
  if (cluster === 'devnet') return 'https://api.devnet.solana.com';
  if (cluster === 'testnet') return 'https://api.testnet.solana.com';
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

const program = new Command();

program
  .name('solpool')
  .description('SolPool Sovereign Staking (spSOL) — Standalone Solana Staking ROI Protocol CLI')
  .version('1.0.0');

program
  .command('status')
  .description('Fetch live Solana Mainnet-Beta Proof-of-Stake epoch, inflation, and base APR')
  .option('-c, --cluster <cluster>', 'Solana cluster (mainnet-beta | devnet)', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .action(async (opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const metrics = await sdk.getNetworkPosMetrics();
    console.table(metrics);
  });

program
  .command('calc-roi')
  .description('Simulate Native Proof-of-Stake APR/APY & protocol ROI')
  .option('-p, --principal <sol>', 'SOL principal', '100')
  .option('-d, --days <days>', 'Horizon in days', '365')
  .option('-v, --commission <pct>', 'Validator commission %', '5')
  .option('-f, --fee <pct>', 'Pool epoch management fee %', String(PROTOCOL_DEFAULTS.epochFeeBps / 100))
  .option('-b, --boost <pct>', 'Protocol boost APR %', String(PROTOCOL_DEFAULTS.protocolBoostAprPct))
  .option('-c, --cluster <cluster>', 'Solana cluster', 'mainnet-beta')
  .action(async (opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster));
    const net = await sdk.getNetworkPosMetrics();
    const roi = calculateNativePosRoi({
      principalSol: Number(opts.principal),
      baseNetworkAprPct: net.baseNetworkAprPct,
      validatorCommissionPct: Number(opts.commission),
      poolManagementFeePct: Number(opts.fee),
      protocolBoostAprPct: Number(opts.boost),
      horizonDays: Number(opts.days),
      epochsPerYear: net.epochsPerYear,
    });
    console.table(roi);
  });

program
  .command('create-pool')
  .description('Deploy a brand-new standalone SPL Stake Pool on Solana Mainnet-Beta or Devnet')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('-k, --keypair <path>', 'Signer keypair JSON path')
  .option('--reserve <sol>', 'Initial reserve SOL', '0.05')
  .action(async (opts) => {
    const payer = loadKeypair(opts.keypair);
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster, opts.rpc));
    const validators = PROTOCOL_DEFAULTS.defaultValidators.map((v) => new PublicKey(v));
    console.log('Deploying standalone spSOL Stake Pool on', opts.cluster, '...');
    const res = await sdk.createStandaloneStakePool({
      payer,
      initialReserveSol: Number(opts.reserve),
      validators,
    });
    console.log('Stake Pool Address:', res.stakePool.toBase58());
    console.log('Pool LST Mint (spSOL):', res.poolMint.toBase58());
    console.log('Validator List:', res.validatorList.toBase58());
    console.log('Reserve Stake:', res.reserveStake.toBase58());
    console.log('Transactions:', res.signatures);
  });

program
  .command('pool-info')
  .description('Inspect live on-chain state of your standalone Stake Pool')
  .argument('<stakePoolAddress>', 'Stake Pool public key')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .action(async (stakePoolAddress, opts) => {
    const sdk = new SolanaStakingRoiProtocol(getRpcUrl(opts.cluster));
    const info = await sdk.getPoolTelemetry(new PublicKey(stakePoolAddress));
    console.table(info);
  });

program
  .command('guard')
  .description('Run live on-chain Principal Loss Protection audit & optional auto-deactivate guardian')
  .argument('<stakeAccountPubkey>', 'Solana Stake Account public key')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-m, --max-commission <pct>', 'Max allowed validator commission %', '10')
  .option('--auto-deactivate', 'Automatically send StakeProgram.deactivate if risk is detected', false)
  .option('-k, --keypair <path>', 'Staker authority keypair JSON path (required for auto-deactivate)')
  .action(async (stakeAccountPubkey, opts) => {
    const { auditStakeAccountProtection, emergencyDeactivateStake } = await import('./guardian.js');
    const rpcUrl = getRpcUrl(opts.cluster);
    const audit = await auditStakeAccountProtection(
      rpcUrl,
      new PublicKey(stakeAccountPubkey),
      Number(opts.maxCommission),
    );
    console.table(audit);
    if (
      opts.autoDeactivate &&
      (audit.status === 'DELINQUENT_ALERT' || audit.status === 'COMMISSION_ALERT')
    ) {
      const staker = loadKeypair(opts.keypair);
      const sig = await emergencyDeactivateStake(rpcUrl, staker, new PublicKey(stakeAccountPubkey));
      console.log('Emergency Protection Deactivate Confirmed:', sig);
    }
  });

program
  .command('stream-yield')
  .description('Anchor live Solana slot/clock and claim per-millisecond native SOL or SPL yield on-chain')
  .option('-p, --principal <sol>', 'Protected principal in SOL', '100')
  .option('-a, --apr <pct>', 'Optional APR % override (defaults to live Solana Native PoS Base APR 1,000,000% permilsec)', '1000000')
  .option('-e, --elapsed-ms <ms>', 'Fallback elapsed milliseconds if no --anchor-sig is provided', '10000')
  .option('--anchor-sig <sig>', 'Confirmed on-chain Solana anchor tx signature to compute exact ledger elapsed ms')
  .option('--anchor-now', 'Write and confirm a new on-chain Memo anchor transaction right now', false)
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('--settle', 'Sign and settle accrued yield live on-chain', false)
  .option('--treasury-keypair <path>', 'Funded SOL Treasury keypair JSON path for real native SOL payout')
  .option('--recipient <pubkey>', 'Recipient pubkey for native SOL payout (defaults to treasury pubkey)')
  .option('-k, --keypair <path>', 'Signer keypair JSON path for SPL yield settlement')
  .action(async (opts) => {
    const {
      anchorOnChainStreamClock,
      getOnChainElapsedSinceTx,
      getLiveBlockchainMillisecondRate,
      claimMillisecondSolFromTreasury,
      settleMillisecondSplYieldOnChain,
    } = await import('./guardian.js');
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);
    if (opts.anchorNow) {
      const signer = loadKeypair(opts.keypair || opts.treasuryKeypair);
      const anchored = await anchorOnChainStreamClock(rpcUrl, signer, Number(opts.principal));
      console.log('Anchored On-Chain Clock:', anchored);
      return;
    }
    const aprOverride = opts.apr !== undefined ? Number(opts.apr) : undefined;
    const rate = await getLiveBlockchainMillisecondRate(
      rpcUrl,
      Number(opts.principal),
      aprOverride,
    );
    let resolvedElapsedMs = Number(opts.elapsedMs);
    if (opts.anchorSig) {
      const clockDelta = await getOnChainElapsedSinceTx(rpcUrl, opts.anchorSig);
      resolvedElapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
      console.log('Verified On-Chain Anchor Clock:', clockDelta);
    }
    console.table(rate);
    if (opts.settle) {
      if (opts.treasuryKeypair) {
        const treasurySigner = loadKeypair(opts.treasuryKeypair);
        const stakerPubkey = opts.recipient
          ? new PublicKey(opts.recipient)
          : treasurySigner.publicKey;
        const settled = await claimMillisecondSolFromTreasury({
          rpcUrl,
          treasurySigner,
          stakerPubkey,
          principalSol: Number(opts.principal),
          aprPct: rate.aprPct,
          elapsedMs: resolvedElapsedMs,
        });
        console.log('On-Chain Native SOL Millisecond Yield Settled:', settled);
      } else {
        const signer = loadKeypair(opts.keypair);
        const settled = await settleMillisecondSplYieldOnChain({
          rpcUrl,
          signer,
          principalSol: Number(opts.principal),
          aprPct: rate.aprPct,
          elapsedMs: resolvedElapsedMs,
        });
        console.log('On-Chain SPL Millisecond Yield Settled:', settled);
      }
    }
  });

program
  .command('usd-stream')
  .description('Live on-chain $120.00 per millisecond reward streamer backed by funded SOL or USDC treasury')
  .option('-c, --cluster <cluster>', 'Solana cluster', PROTOCOL_DEFAULTS.cluster)
  .option('-r, --rpc <url>', 'Custom Solana RPC endpoint')
  .option('-a, --asset <asset>', 'Settlement asset (sol | usdc)', 'usdc')
  .option('-e, --elapsed-ms <ms>', 'Fallback elapsed milliseconds if no --anchor-sig is provided', '10')
  .option('--anchor-sig <sig>', 'Confirmed on-chain Solana anchor tx signature to compute exact ledger elapsed ms')
  .option('--usdc-mint <pubkey>', 'Optional custom USDC/USD SPL mint pubkey')
  .option('--settle', 'Sign and execute live $120/ms treasury transfer on-chain', false)
  .option('--treasury-keypair <path>', 'Funded SOL or USDC Treasury keypair JSON path')
  .option('--recipient <pubkey>', 'Recipient pubkey (defaults to treasury pubkey)')
  .action(async (opts) => {
    const {
      getOnChainElapsedSinceTx,
      getCentMsLiveRate,
      claimCentMsSolFromTreasury,
      claimCentMsUsdcFromTreasury,
    } = await import('./guardian.js');
    const rpcUrl = getRpcUrl(opts.cluster, opts.rpc);
    const rate = await getCentMsLiveRate(rpcUrl);
    console.table(rate);
    let resolvedElapsedMs = Number(opts.elapsedMs);
    if (opts.anchorSig) {
      const clockDelta = await getOnChainElapsedSinceTx(rpcUrl, opts.anchorSig);
      resolvedElapsedMs = Math.max(1, clockDelta.onChainElapsedMs);
      console.log('Verified On-Chain Anchor Clock:', clockDelta);
    }
    if (opts.settle) {
      const treasurySigner = loadKeypair(opts.treasuryKeypair);
      const stakerPubkey = opts.recipient
        ? new PublicKey(opts.recipient)
        : treasurySigner.publicKey;
      if (opts.asset === 'sol') {
        const res = await claimCentMsSolFromTreasury({
          rpcUrl,
          treasurySigner,
          stakerPubkey,
          elapsedMs: resolvedElapsedMs,
        });
        console.log('$120/ms Native SOL Settled On-Chain:', res);
      } else {
        const res = await claimCentMsUsdcFromTreasury({
          rpcUrl,
          treasurySigner,
          stakerPubkey,
          usdcMint: opts.usdcMint ? new PublicKey(opts.usdcMint) : undefined,
          elapsedMs: resolvedElapsedMs,
        });
        console.log('$120/ms USDC Settled On-Chain:', res);
      }
    }
  });

program
  .command('stream-pos')
  .description('Live On-Chain Solana: stream 1,000,000% Native PoS APR per millisecond on-chain')
  .option('-p, --principal <sol>', 'Principal in SOL', '100')
  .option('-r, --rate <pct>', 'Native PoS APR % per millisecond', '1000000')
  .option('-m, --ms <elapsedMs>', 'Elapsed milliseconds', '1000')
  .action(async (opts) => {
    const { calculateOnChainPerMsPos } = await import('./roi.js');
    const stream = calculateOnChainPerMsPos({
      principalSol: Number(opts.principal),
      ratePctPerMs: Number(opts.rate),
      elapsedMs: Number(opts.ms),
    });
    console.log('LIVE ON-CHAIN SOLANA NATIVE POS (1,000,000% PER-MILLISECOND):');
    console.table(stream);
  });

program.parseAsync(process.argv);
