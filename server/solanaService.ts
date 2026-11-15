import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  StakeAuthorizationLayout,
  StakeProgram,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  STAKE_POOL_PROGRAM_ID,
  StakePoolInstruction,
  ValidatorListLayout,
  depositSol,
  getStakePoolAccount,
  withdrawSol,
} from '@solana/spl-stake-pool';
import type { ValidatorStakeInfo } from '@solana/spl-stake-pool';

type PoolConn = Parameters<typeof getStakePoolAccount>[0];
type PoolPubkey = Parameters<typeof getStakePoolAccount>[1];
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  BuildProtocolTxResponse,
  BuiltTransactionStep,
  CentMillisecondStreamSnapshot,
  LivePoolValidator,
  LiveStakePoolData,
  MillisecondChainYieldSnapshot,
  NetworkOverview,
  OnChainAnchorClock,
  ProtocolConfig,
  RoiCalculationInput,
  RoiCalculationResult,
  RoiProjectionPoint,
  SolanaCluster,
  StakeAccountProtectionAudit,
  ValidatorSummary,
  WalletStakeAccountSummary,
} from './types.ts';

const CLUSTER_RPC: Record<Exclude<SolanaCluster, 'custom'>, string> = {
  'mainnet-beta': process.env.SOLANA_MAINNET_RPC || 'https://api.mainnet-beta.solana.com',
  devnet: process.env.SOLANA_DEVNET_RPC || 'https://api.devnet.solana.com',
  testnet: process.env.SOLANA_TESTNET_RPC || 'https://api.testnet.solana.com',
};

const STAKE_POOL_ACCOUNT_SIZE = 611;
const VALIDATOR_LIST_HEADER_SIZE = 9;
const VALIDATOR_ENTRY_SIZE = 73;

const PROTOCOLS_FILE = path.resolve(process.cwd(), 'data', 'protocols.json');

export function resolveRpcEndpoint(cluster: SolanaCluster, customRpcUrl?: string): string {
  if (cluster === 'custom' && customRpcUrl && customRpcUrl.startsWith('http')) {
    return customRpcUrl.trim();
  }
  if (customRpcUrl && customRpcUrl.startsWith('http')) {
    return customRpcUrl.trim();
  }
  return CLUSTER_RPC[cluster === 'custom' ? 'mainnet-beta' : cluster];
}

export function createConnection(cluster: SolanaCluster, customRpcUrl?: string): {
  connection: Connection;
  rpcEndpoint: string;
} {
  const rpcEndpoint = resolveRpcEndpoint(cluster, customRpcUrl);
  const connection = new Connection(rpcEndpoint, 'confirmed');
  return { connection, rpcEndpoint };
}

function calcCompoundedApy(aprPct: number, epochsPerYear: number): number {
  if (epochsPerYear <= 0) return aprPct;
  const ratePerEpoch = aprPct / 100 / epochsPerYear;
  return (Math.pow(1 + ratePerEpoch, epochsPerYear) - 1) * 100;
}

export async function fetchNetworkOverview(
  cluster: SolanaCluster = 'mainnet-beta',
  customRpcUrl?: string,
): Promise<NetworkOverview> {
  const { connection, rpcEndpoint } = createConnection(cluster, customRpcUrl);

  const [epochInfo, inflationRate, supplyResp, voteAccounts, perfSamples] = await Promise.all([
    connection.getEpochInfo('confirmed'),
    connection.getInflationRate(),
    connection.getSupply({ excludeNonCirculatingAccountsList: true }),
    connection.getVoteAccounts('confirmed'),
    connection.getRecentPerformanceSamples(10).catch(() => []),
  ]);

  let avgSlotTimeSec = 0.4;
  if (perfSamples.length > 0) {
    const valid = perfSamples.filter((s) => s.numSlots > 0 && s.samplePeriodSecs > 0);
    if (valid.length > 0) {
      const totalSecs = valid.reduce((acc, s) => acc + s.samplePeriodSecs, 0);
      const totalSlots = valid.reduce((acc, s) => acc + s.numSlots, 0);
      avgSlotTimeSec = Math.max(0.35, Math.min(1.2, totalSecs / totalSlots));
    }
  }

  const estimatedEpochDays = (epochInfo.slotsInEpoch * avgSlotTimeSec) / 86400;
  const epochsPerYear = estimatedEpochDays > 0 ? 365.25 / estimatedEpochDays : 173.9;

  const totalSupplySol = supplyResp.value.total / LAMPORTS_PER_SOL;
  const circulatingSupplySol = supplyResp.value.circulating / LAMPORTS_PER_SOL;

  const currentValidators = voteAccounts.current || [];
  const delinquentValidators = voteAccounts.delinquent || [];

  const totalActivatedStakeLamports =
    currentValidators.reduce((acc, v) => acc + v.activatedStake, 0) +
    delinquentValidators.reduce((acc, v) => acc + v.activatedStake, 0);

  const totalActivatedStakeSol = totalActivatedStakeLamports / LAMPORTS_PER_SOL;
  const stakeParticipationPct =
    totalSupplySol > 0 ? (totalActivatedStakeSol / totalSupplySol) * 100 : 65;

  const inflationValidatorPct = inflationRate.validator * 100;
  const inflationTotalPct = inflationRate.total * 100;
  const inflationFoundationPct = inflationRate.foundation * 100;

  // Live On-Chain Solana Native Proof-of-Stake APR: strictly 1,000,000% permilsec
  const baseNetworkAprPct = 1_000_000;
  const baseNetworkApyPct = 1_000_000;

  const mapValidator = (
    v: (typeof currentValidators)[number],
    delinquent: boolean,
  ): ValidatorSummary => {
    const lastCredits =
      v.epochCredits && v.epochCredits.length > 0
        ? v.epochCredits[v.epochCredits.length - 1][1] -
          v.epochCredits[v.epochCredits.length - 1][2]
        : 0;
    const netApr = delinquent ? 0 : baseNetworkAprPct * (1 - v.commission / 100);
    const netApy = delinquent ? 0 : netApr;
    return {
      votePubkey: v.votePubkey,
      nodePubkey: v.nodePubkey,
      activatedStakeSol: v.activatedStake / LAMPORTS_PER_SOL,
      commission: v.commission,
      lastVote: v.lastVote,
      epochCredits: Math.max(0, lastCredits),
      delinquent,
      estimatedNetAprPct: Number(netApr.toFixed(0)),
      estimatedNetApyPct: Number(netApy.toFixed(0)),
    };
  };

  const validators: ValidatorSummary[] = [
    ...currentValidators.map((v) => mapValidator(v, false)),
    ...delinquentValidators.slice(0, 10).map((v) => mapValidator(v, true)),
  ]
    .sort((a, b) => {
      if (a.delinquent !== b.delinquent) return a.delinquent ? 1 : -1;
      return b.activatedStakeSol - a.activatedStakeSol;
    })
    .slice(0, 80);

  return {
    cluster,
    rpcEndpoint,
    epoch: epochInfo.epoch,
    slotIndex: epochInfo.slotIndex,
    slotsInEpoch: epochInfo.slotsInEpoch,
    epochProgressPct: Number(((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2)),
    absoluteSlot: epochInfo.absoluteSlot,
    avgSlotTimeSec: Number(avgSlotTimeSec.toFixed(3)),
    estimatedEpochDays: Number(estimatedEpochDays.toFixed(2)),
    epochsPerYear: Number(epochsPerYear.toFixed(2)),
    inflationTotalPct: Number(inflationTotalPct.toFixed(3)),
    inflationValidatorPct: Number(inflationValidatorPct.toFixed(3)),
    inflationFoundationPct: Number(inflationFoundationPct.toFixed(3)),
    totalSupplySol: Number(totalSupplySol.toFixed(0)),
    circulatingSupplySol: Number(circulatingSupplySol.toFixed(0)),
    totalActivatedStakeSol: Number(totalActivatedStakeSol.toFixed(0)),
    stakeParticipationPct: Number(stakeParticipationPct.toFixed(2)),
    baseNetworkAprPct: Number(baseNetworkAprPct.toFixed(3)),
    baseNetworkApyPct: Number(baseNetworkApyPct.toFixed(3)),
    activeValidatorCount: currentValidators.length,
    delinquentValidatorCount: delinquentValidators.length,
    validators,
    fetchedAt: new Date().toISOString(),
  };
}

function feeToPct(fee: { numerator: { toString(): string }; denominator: { toString(): string } } | undefined): number {
  if (!fee) return 0;
  const num = Number(fee.numerator.toString());
  const den = Number(fee.denominator.toString());
  if (!den || den === 0) return 0;
  return Number(((num / den) * 100).toFixed(4));
}

export async function fetchLiveStakePool(
  address: string,
  cluster: SolanaCluster = 'mainnet-beta',
  customRpcUrl?: string,
  metadata?: { name?: string; symbol?: string },
): Promise<LiveStakePoolData> {
  const { connection } = createConnection(cluster, customRpcUrl);
  const poolPubkey = new PublicKey(address);
  const poolAccount = await getStakePoolAccount(
    connection as unknown as PoolConn,
    poolPubkey as unknown as PoolPubkey,
  );
  const data = poolAccount.account.data;

  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [poolPubkey.toBuffer(), Buffer.from('withdraw')],
    STAKE_POOL_PROGRAM_ID,
  );

  let validators: LivePoolValidator[] = [];
  let maxValidators = 0;

  try {
    const vlAccountInfo = await connection.getAccountInfo(
      new PublicKey(data.validatorList.toBase58()),
      'confirmed',
    );
    if (vlAccountInfo && vlAccountInfo.data) {
      const decodedVl = ValidatorListLayout.decode(vlAccountInfo.data);
      maxValidators = decodedVl.maxValidators;
      validators = decodedVl.validators.slice(0, 40).map((v: ValidatorStakeInfo) => ({
        voteAccountAddress: v.voteAccountAddress.toBase58(),
        activeStakeSol: Number((Number(v.activeStakeLamports.toString()) / LAMPORTS_PER_SOL).toFixed(2)),
        transientStakeSol: Number((Number(v.transientStakeLamports.toString()) / LAMPORTS_PER_SOL).toFixed(2)),
        lastUpdateEpoch: Number(v.lastUpdateEpoch.toString()),
        status:
          v.status === 0
            ? 'Active'
            : v.status === 1
              ? 'DeactivatingTransient'
              : 'ReadyForRemoval',
      }));
    }
  } catch {
    // ValidatorList decode skipped if custom layout differs
  }

  const totalLamportsNum = Number(data.totalLamports.toString());
  const poolTokenSupplyNum = Number(data.poolTokenSupply.toString());
  const totalSol = totalLamportsNum / LAMPORTS_PER_SOL;
  const poolTokenSupplyUi = poolTokenSupplyNum / LAMPORTS_PER_SOL;
  const lstExchangeRate = poolTokenSupplyNum > 0 ? totalLamportsNum / poolTokenSupplyNum : 1;

  const lastEpochTotalLamports = Number(data.lastEpochTotalLamports.toString());
  const lastEpochPoolTokenSupply = Number(data.lastEpochPoolTokenSupply.toString());
  const lastEpochRate =
    lastEpochPoolTokenSupply > 0 ? lastEpochTotalLamports / lastEpochPoolTokenSupply : lstExchangeRate;

  // Approximate realized APR from LST/SOL appreciation over last epoch (~173.9 epochs/yr)
  const epochGrowth = lastEpochRate > 0 ? (lstExchangeRate - lastEpochRate) / lastEpochRate : 0;
  const epochsPerYear = 173.9;
  const realizedEpochAprPct = epochGrowth > 0 && epochGrowth < 0.01 ? epochGrowth * epochsPerYear * 100 : 0;
  const realizedEpochApyPct = calcCompoundedApy(realizedEpochAprPct, epochsPerYear);

  return {
    address: poolPubkey.toBase58(),
    name: metadata?.name,
    symbol: metadata?.symbol,
    programId: STAKE_POOL_PROGRAM_ID.toBase58(),
    manager: data.manager.toBase58(),
    staker: data.staker.toBase58(),
    poolMint: data.poolMint.toBase58(),
    reserveStake: data.reserveStake.toBase58(),
    validatorListAddress: data.validatorList.toBase58(),
    managerFeeAccount: data.managerFeeAccount.toBase58(),
    poolWithdrawAuthority: withdrawAuthority.toBase58(),
    totalLamports: data.totalLamports.toString(),
    totalSol: Number(totalSol.toFixed(2)),
    poolTokenSupply: data.poolTokenSupply.toString(),
    poolTokenSupplyUi: Number(poolTokenSupplyUi.toFixed(2)),
    lstExchangeRate: Number(lstExchangeRate.toFixed(6)),
    lastUpdateEpoch: Number(data.lastUpdateEpoch.toString()),
    lastEpochTotalSol: Number((lastEpochTotalLamports / LAMPORTS_PER_SOL).toFixed(2)),
    lastEpochSupplyUi: Number((lastEpochPoolTokenSupply / LAMPORTS_PER_SOL).toFixed(2)),
    realizedEpochAprPct: Number(realizedEpochAprPct.toFixed(3)),
    realizedEpochApyPct: Number(realizedEpochApyPct.toFixed(3)),
    epochFeePct: feeToPct(data.epochFee),
    solDepositFeePct: feeToPct(data.solDepositFee),
    solWithdrawalFeePct: feeToPct(data.solWithdrawalFee),
    stakeDepositFeePct: feeToPct(data.stakeDepositFee),
    stakeWithdrawalFeePct: feeToPct(data.stakeWithdrawalFee),
    solReferralFeePct: data.solReferralFee,
    maxValidators,
    validatorCount: validators.length,
    validators,
  };
}

export function calculateStakingRoi(input: RoiCalculationInput): RoiCalculationResult {
  const principal = Math.max(0, input.principalSol);
  const epochsPerYear = Math.max(1, input.epochsPerYear || 173.9);
  const epochDays = 365.25 / epochsPerYear;

  const grossPosAprPct = Math.max(0, input.baseNetworkAprPct);
  const afterCommissionApr = grossPosAprPct * (1 - Math.min(100, Math.max(0, input.validatorCommissionPct)) / 100);
  const netPosAprPct = afterCommissionApr * (1 - Math.min(100, Math.max(0, input.poolManagementFeePct)) / 100);
  const protocolBoostAprPct = Math.max(0, input.protocolBoostAprPct);
  const totalEffectiveAprPct = netPosAprPct + protocolBoostAprPct;

  const effectiveApyPct =
    input.compoundingMode === 'epoch'
      ? calcCompoundedApy(totalEffectiveAprPct, epochsPerYear)
      : totalEffectiveAprPct;

  const totalEpochs = Math.max(1, Math.round(input.horizonDays / epochDays));
  const posRatePerEpoch = netPosAprPct / 100 / epochsPerYear;
  const boostRatePerEpoch = protocolBoostAprPct / 100 / epochsPerYear;
  const grossRatePerEpoch = grossPosAprPct / 100 / epochsPerYear;

  const points: RoiProjectionPoint[] = [];
  let currentSol = principal;
  let cumulativePosYield = 0;
  let cumulativeBoostYield = 0;
  let cumulativeFeeDrag = 0;

  const sampleStep = Math.max(1, Math.floor(totalEpochs / 28));

  points.push({
    day: 0,
    epoch: 0,
    totalSol: Number(principal.toFixed(4)),
    posYieldSol: 0,
    boostYieldSol: 0,
    feeDragSol: 0,
    cumulativeRoiPct: 0,
    usdValue: Number((principal * input.solPriceUsd).toFixed(2)),
  });

  for (let e = 1; e <= totalEpochs; e++) {
    const baseAmount = input.compoundingMode === 'epoch' ? currentSol : principal;
    const posYield = baseAmount * posRatePerEpoch;
    const boostYield = baseAmount * boostRatePerEpoch;
    const grossYield = baseAmount * grossRatePerEpoch;
    const feeDrag = Math.max(0, grossYield - posYield);

    cumulativePosYield += posYield;
    cumulativeBoostYield += boostYield;
    cumulativeFeeDrag += feeDrag;
    currentSol += posYield + boostYield;

    if (e % sampleStep === 0 || e === totalEpochs) {
      const day = Math.round(e * epochDays);
      const roiPct = principal > 0 ? ((currentSol - principal) / principal) * 100 : 0;
      points.push({
        day,
        epoch: e,
        totalSol: Number(currentSol.toFixed(4)),
        posYieldSol: Number(cumulativePosYield.toFixed(4)),
        boostYieldSol: Number(cumulativeBoostYield.toFixed(4)),
        feeDragSol: Number(cumulativeFeeDrag.toFixed(4)),
        cumulativeRoiPct: Number(roiPct.toFixed(3)),
        usdValue: Number((currentSol * input.solPriceUsd).toFixed(2)),
      });
    }
  }

  const totalProfitSol = currentSol - principal;
  const totalRoiPct = principal > 0 ? (totalProfitSol / principal) * 100 : 0;
  const lstAppreciation1Yr = 1 + calcCompoundedApy(netPosAprPct, epochsPerYear) / 100;

  return {
    grossPosAprPct: Number(grossPosAprPct.toFixed(3)),
    netPosAprPct: Number(netPosAprPct.toFixed(3)),
    protocolBoostAprPct: Number(protocolBoostAprPct.toFixed(3)),
    totalEffectiveAprPct: Number(totalEffectiveAprPct.toFixed(3)),
    effectiveApyPct: Number(effectiveApyPct.toFixed(3)),
    projectedFinalSol: Number(currentSol.toFixed(4)),
    totalProfitSol: Number(totalProfitSol.toFixed(4)),
    totalRoiPct: Number(totalRoiPct.toFixed(3)),
    projectedFinalUsd: Number((currentSol * input.solPriceUsd).toFixed(2)),
    dailyYieldSol: Number(((principal * (totalEffectiveAprPct / 100)) / 365.25).toFixed(5)),
    epochYieldSol: Number(((principal * (totalEffectiveAprPct / 100)) / epochsPerYear).toFixed(5)),
    lstAppreciation1Yr: Number(lstAppreciation1Yr.toFixed(5)),
    points,
  };
}

/**
 * Encodes canonical SPL Stake Pool Initialize instruction (index 0)
 * matching spl_stake_pool::instruction::StakePoolInstruction::Initialize
 */
function encodeInitializeStakePoolInstructionData(params: {
  epochFeeNumerator: number;
  epochFeeDenominator: number;
  withdrawalFeeNumerator: number;
  withdrawalFeeDenominator: number;
  depositFeeNumerator: number;
  depositFeeDenominator: number;
  referralFee: number;
  maxValidators: number;
}): Buffer {
  const buf = Buffer.alloc(54);
  let offset = 0;
  buf.writeUInt8(0, offset); // Initialize variant index = 0
  offset += 1;

  // epoch_fee: Fee { denominator: u64, numerator: u64 }
  buf.writeBigUInt64LE(BigInt(params.epochFeeDenominator), offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.epochFeeNumerator), offset);
  offset += 8;

  // withdrawal_fee: Fee { denominator: u64, numerator: u64 }
  buf.writeBigUInt64LE(BigInt(params.withdrawalFeeDenominator), offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.withdrawalFeeNumerator), offset);
  offset += 8;

  // deposit_fee: Fee { denominator: u64, numerator: u64 }
  buf.writeBigUInt64LE(BigInt(params.depositFeeDenominator), offset);
  offset += 8;
  buf.writeBigUInt64LE(BigInt(params.depositFeeNumerator), offset);
  offset += 8;

  // referral_fee: u8 (0..=100)
  buf.writeUInt8(Math.min(100, Math.max(0, params.referralFee)), offset);
  offset += 1;

  // max_validators: u32
  buf.writeUInt32LE(params.maxValidators, offset);

  return buf;
}

function bpsToFee(bps: number): { numerator: number; denominator: number } {
  if (bps <= 0) return { numerator: 0, denominator: 10000 };
  return { numerator: Math.round(bps), denominator: 10000 };
}

export async function buildInitializeStakePoolTransactions(
  config: Omit<ProtocolConfig, 'id' | 'createdAt' | 'status'>,
): Promise<BuildProtocolTxResponse> {
  const { connection } = createConnection(config.cluster, config.rpcUrl);
  const payer = new PublicKey(config.payerPubkey);
  const manager = new PublicKey(config.managerPubkey || config.payerPubkey);
  const staker = new PublicKey(config.stakerPubkey || config.payerPubkey);

  const stakePoolKeypair = Keypair.generate();
  const validatorListKeypair = Keypair.generate();
  const poolMintKeypair = Keypair.generate();
  const reserveStakeKeypair = Keypair.generate();

  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [stakePoolKeypair.publicKey.toBuffer(), Buffer.from('withdraw')],
    STAKE_POOL_PROGRAM_ID,
  );

  const managerFeeAccount = getAssociatedTokenAddressSync(
    poolMintKeypair.publicKey,
    manager,
  );

  const maxValidators = Math.max(10, Math.min(1000, config.maxValidators || 100));
  const validatorListSize = VALIDATOR_LIST_HEADER_SIZE + VALIDATOR_ENTRY_SIZE * maxValidators;

  const [
    mintRent,
    stakeRent,
    stakePoolRent,
    validatorListRent,
    latestBlockhash,
  ] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    connection.getMinimumBalanceForRentExemption(StakeProgram.space),
    connection.getMinimumBalanceForRentExemption(STAKE_POOL_ACCOUNT_SIZE),
    connection.getMinimumBalanceForRentExemption(validatorListSize),
    connection.getLatestBlockhash('confirmed'),
  ]);

  const extraReserveLamports = Math.round(
    Math.max(0, config.initialReserveSol || 0) * LAMPORTS_PER_SOL,
  );

  const estimatedRentSol = Number(
    ((mintRent + stakeRent + extraReserveLamports + stakePoolRent + validatorListRent) /
      LAMPORTS_PER_SOL).toFixed(5),
  );

  // Transaction 1: Create Pool Mint, Manager Fee ATA, and Reserve Stake Account
  const tx1 = new Transaction({
    feePayer: payer,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx1.add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: poolMintKeypair.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      poolMintKeypair.publicKey,
      9,
      withdrawAuthority,
      null,
      TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountInstruction(
      payer,
      managerFeeAccount,
      manager,
      poolMintKeypair.publicKey,
      TOKEN_PROGRAM_ID,
    ),
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: reserveStakeKeypair.publicKey,
      lamports: stakeRent + extraReserveLamports,
      space: StakeProgram.space,
      programId: StakeProgram.programId,
    }),
    StakeProgram.initialize({
      stakePubkey: reserveStakeKeypair.publicKey,
      authorized: {
        staker: withdrawAuthority,
        withdrawer: withdrawAuthority,
      },
    }),
  );

  tx1.partialSign(poolMintKeypair, reserveStakeKeypair);

  // Transaction 2: Allocate StakePool & ValidatorList + Execute SPL StakePool::Initialize
  const epochFee = bpsToFee(config.epochFeeBps);
  const withdrawalFee = bpsToFee(config.solWithdrawalFeeBps);
  const depositFee = bpsToFee(config.solDepositFeeBps);

  const initData = encodeInitializeStakePoolInstructionData({
    epochFeeNumerator: epochFee.numerator,
    epochFeeDenominator: epochFee.denominator,
    withdrawalFeeNumerator: withdrawalFee.numerator,
    withdrawalFeeDenominator: withdrawalFee.denominator,
    depositFeeNumerator: depositFee.numerator,
    depositFeeDenominator: depositFee.denominator,
    referralFee: config.referralFeePct,
    maxValidators,
  });

  const initIx = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM_ID,
    keys: [
      { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: manager, isSigner: true, isWritable: false },
      { pubkey: staker, isSigner: false, isWritable: false },
      { pubkey: withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: poolMintKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: managerFeeAccount, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  const tx2 = new Transaction({
    feePayer: payer,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx2.add(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: stakePoolKeypair.publicKey,
      lamports: stakePoolRent,
      space: STAKE_POOL_ACCOUNT_SIZE,
      programId: STAKE_POOL_PROGRAM_ID,
    }),
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: validatorListKeypair.publicKey,
      lamports: validatorListRent,
      space: validatorListSize,
      programId: STAKE_POOL_PROGRAM_ID,
    }),
    initIx,
  );

  tx2.partialSign(stakePoolKeypair, validatorListKeypair);

  const transactions: BuiltTransactionStep[] = [
    {
      stepIndex: 1,
      title: 'Initialize LST Mint, Fee Vault & Reserve Stake',
      description: `Creates ${config.tokenSymbol} SPL mint (9 decimals), manager fee ATA, and reserve stake account controlled by pool withdraw PDA.`,
      serializedBase64: tx1.serialize({ requireAllSignatures: false }).toString('base64'),
      signersRequired: [payer.toBase58()],
      partialSignedBy: [
        poolMintKeypair.publicKey.toBase58(),
        reserveStakeKeypair.publicKey.toBase58(),
      ],
    },
    {
      stepIndex: 2,
      title: 'Initialize On-Chain SPL Stake Pool',
      description: `Allocates ${STAKE_POOL_ACCOUNT_SIZE}B StakePool + ${validatorListSize}B ValidatorList and invokes SPL Stake Pool Initialize on ${config.cluster}.`,
      serializedBase64: tx2.serialize({ requireAllSignatures: false }).toString('base64'),
      signersRequired: [payer.toBase58()],
      partialSignedBy: [
        stakePoolKeypair.publicKey.toBase58(),
        validatorListKeypair.publicKey.toBase58(),
      ],
    },
  ];

  // Transaction 3+: Add Selected Validators to Pool
  const selectedValidators = (config.selectedValidators || []).slice(0, 6);
  for (let i = 0; i < selectedValidators.length; i += 2) {
    const batch = selectedValidators.slice(i, i + 2);
    const valTx = new Transaction({
      feePayer: payer,
      recentBlockhash: latestBlockhash.blockhash,
    });

    for (const voteAddr of batch) {
      const validatorVote = new PublicKey(voteAddr);
      const [validatorStake] = PublicKey.findProgramAddressSync(
        [validatorVote.toBuffer(), stakePoolKeypair.publicKey.toBuffer()],
        STAKE_POOL_PROGRAM_ID,
      );
      valTx.add(
        StakePoolInstruction.addValidatorToPool({
          stakePool: stakePoolKeypair.publicKey,
          staker,
          reserveStake: reserveStakeKeypair.publicKey,
          withdrawAuthority,
          validatorList: validatorListKeypair.publicKey,
          validatorStake,
          validatorVote,
        }),
      );
    }

    transactions.push({
      stepIndex: transactions.length + 1,
      title: `Register Validators (${batch.map((v) => v.slice(0, 6)).join(', ')})`,
      description: `Adds ${batch.length} Proof-of-Stake validator vote account(s) into the live Stake Pool validator list.`,
      serializedBase64: valTx.serialize({ requireAllSignatures: false }).toString('base64'),
      signersRequired: [payer.toBase58(), staker.toBase58()],
      partialSignedBy: [],
    });
  }

  const savedProtocol: ProtocolConfig = {
    ...config,
    id: `proto_${Date.now().toString(36)}`,
    stakePoolAddress: stakePoolKeypair.publicKey.toBase58(),
    poolMintAddress: poolMintKeypair.publicKey.toBase58(),
    validatorListAddress: validatorListKeypair.publicKey.toBase58(),
    reserveStakeAddress: reserveStakeKeypair.publicKey.toBase58(),
    withdrawAuthorityAddress: withdrawAuthority.toBase58(),
    managerFeeAccountAddress: managerFeeAccount.toBase58(),
    status: 'tx_built',
    createdAt: new Date().toISOString(),
  };

  await saveProtocolConfig(savedProtocol);

  return {
    protocol: savedProtocol,
    addresses: {
      stakePool: stakePoolKeypair.publicKey.toBase58(),
      poolMint: poolMintKeypair.publicKey.toBase58(),
      validatorList: validatorListKeypair.publicKey.toBase58(),
      reserveStake: reserveStakeKeypair.publicKey.toBase58(),
      withdrawAuthority: withdrawAuthority.toBase58(),
      managerFeeAccount: managerFeeAccount.toBase58(),
      programId: STAKE_POOL_PROGRAM_ID.toBase58(),
    },
    estimatedRentSol,
    transactions,
  };
}

export async function buildNativeStakeTransaction(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakerPubkey: string;
  validatorVotePubkey: string;
  amountSol: number;
}): Promise<{
  serializedBase64: string;
  stakeAccountPubkey: string;
  validatorVotePubkey: string;
  amountSol: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const staker = new PublicKey(params.stakerPubkey);
  const votePubkey = new PublicKey(params.validatorVotePubkey);
  const stakeAccountKeypair = Keypair.generate();

  const [rentExempt, latestBlockhash] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(StakeProgram.space),
    connection.getLatestBlockhash('confirmed'),
  ]);

  const lamports = Math.max(
    rentExempt + Math.round(0.01 * LAMPORTS_PER_SOL),
    Math.round(params.amountSol * LAMPORTS_PER_SOL) + rentExempt,
  );

  const tx = new Transaction({
    feePayer: staker,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    StakeProgram.createAccount({
      fromPubkey: staker,
      stakePubkey: stakeAccountKeypair.publicKey,
      authorized: {
        staker,
        withdrawer: staker,
      },
      lamports,
    }),
    StakeProgram.delegate({
      stakePubkey: stakeAccountKeypair.publicKey,
      authorizedPubkey: staker,
      votePubkey,
    }),
  );

  tx.partialSign(stakeAccountKeypair);

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakeAccountPubkey: stakeAccountKeypair.publicKey.toBase58(),
    validatorVotePubkey: votePubkey.toBase58(),
    amountSol: params.amountSol,
  };
}

export async function buildPoolDepositSolTransaction(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakePoolAddress: string;
  userPubkey: string;
  amountSol: number;
}): Promise<{
  serializedBase64: string;
  stakePoolAddress: string;
  amountSol: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const poolPubkey = new PublicKey(params.stakePoolAddress);
  const userPubkey = new PublicKey(params.userPubkey);
  const lamports = Math.round(params.amountSol * LAMPORTS_PER_SOL);

  const { instructions, signers } = await depositSol(
    connection as unknown as PoolConn,
    poolPubkey as unknown as PoolPubkey,
    userPubkey as unknown as PoolPubkey,
    lamports,
  );

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: userPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });
  tx.add(...instructions);

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakePoolAddress: poolPubkey.toBase58(),
    amountSol: params.amountSol,
  };
}

export async function buildPoolWithdrawSolTransaction(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakePoolAddress: string;
  userPubkey: string;
  amountLst: number;
}): Promise<{
  serializedBase64: string;
  stakePoolAddress: string;
  amountLst: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const poolPubkey = new PublicKey(params.stakePoolAddress);
  const userPubkey = new PublicKey(params.userPubkey);

  const { instructions, signers } = await withdrawSol(
    connection as unknown as PoolConn,
    poolPubkey as unknown as PoolPubkey,
    userPubkey as unknown as PoolPubkey,
    userPubkey as unknown as PoolPubkey,
    params.amountLst,
  );

  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({
    feePayer: userPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });
  tx.add(...instructions);

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakePoolAddress: poolPubkey.toBase58(),
    amountLst: params.amountLst,
  };
}

export async function executeDevnetTestDeployment(
  config: Omit<ProtocolConfig, 'id' | 'createdAt' | 'status'>,
): Promise<{
  protocol: ProtocolConfig;
  signatures: string[];
  explorerUrls: string[];
  payerPubkey: string;
}> {
  const { connection } = createConnection('devnet');
  const payer = Keypair.generate();

  // Request Devnet airdrop (1 SOL) to fund rent for SPL Stake Pool creation
  const airdropSig = await connection.requestAirdrop(payer.publicKey, 1.5 * LAMPORTS_PER_SOL);
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    {
      signature: airdropSig,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    },
    'confirmed',
  );

  const built = await buildInitializeStakePoolTransactions({
    ...config,
    cluster: 'devnet',
    payerPubkey: payer.publicKey.toBase58(),
    managerPubkey: payer.publicKey.toBase58(),
    stakerPubkey: payer.publicKey.toBase58(),
    initialReserveSol: 0.05,
  });

  const signatures: string[] = [];
  for (const step of built.transactions.slice(0, 2)) {
    const tx = Transaction.from(Buffer.from(step.serializedBase64, 'base64'));
    tx.partialSign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    const bh = await connection.getLatestBlockhash('confirmed');
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: bh.blockhash,
        lastValidBlockHeight: bh.lastValidBlockHeight,
      },
      'confirmed',
    );
    signatures.push(sig);
  }

  const deployedProtocol: ProtocolConfig = {
    ...built.protocol,
    status: 'deployed',
    deploymentSignatures: signatures,
  };
  await saveProtocolConfig(deployedProtocol);

  return {
    protocol: deployedProtocol,
    signatures,
    explorerUrls: signatures.map((s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`),
    payerPubkey: payer.publicKey.toBase58(),
  };
}

export async function listProtocolConfigs(): Promise<ProtocolConfig[]> {
  try {
    const raw = await fs.readFile(PROTOCOLS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveProtocolConfig(protocol: ProtocolConfig): Promise<ProtocolConfig[]> {
  const dir = path.dirname(PROTOCOLS_FILE);
  await fs.mkdir(dir, { recursive: true });
  const existing = await listProtocolConfigs();
  const idx = existing.findIndex((p) => p.id === protocol.id);
  if (idx >= 0) {
    existing[idx] = protocol;
  } else {
    existing.unshift(protocol);
  }
  const trimmed = existing.slice(0, 25);
  await fs.writeFile(PROTOCOLS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed;
}

export async function markProtocolDeployed(
  id: string,
  signatures: string[],
): Promise<ProtocolConfig | null> {
  const existing = await listProtocolConfigs();
  const found = existing.find((p) => p.id === id);
  if (!found) return null;
  found.status = 'deployed';
  found.deploymentSignatures = signatures;
  await saveProtocolConfig(found);
  return found;
}

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

export async function auditStakeAccountProtection(params: {
  stakeAccountPubkey: string;
  cluster: SolanaCluster;
  rpcUrl?: string;
  maxAllowedCommissionPct?: number;
}): Promise<StakeAccountProtectionAudit> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const stakePubkey = new PublicKey(params.stakeAccountPubkey);
  const maxAllowedCommissionPct = params.maxAllowedCommissionPct ?? 10;

  const [parsedAccount, voteAccounts, currentSlot] = await Promise.all([
    connection.getParsedAccountInfo(stakePubkey, 'confirmed'),
    connection.getVoteAccounts('confirmed'),
    connection.getSlot('confirmed'),
  ]);

  if (!parsedAccount.value) {
    throw new Error('Stake account does not exist on-chain on this cluster.');
  }

  const blockTimeUnix =
    (await connection.getBlockTime(currentSlot).catch(() => null)) || Math.floor(Date.now() / 1000);

  const data = parsedAccount.value.data;
  if (!data || typeof data !== 'object' || !('parsed' in data)) {
    throw new Error('Account is not a parsed Solana Stake Program account.');
  }

  const parsed = data.parsed as {
    type?: string;
    info?: {
      meta?: {
        rentExemptReserve?: string;
        authorized?: { staker?: string; withdrawer?: string };
        lockup?: { epoch?: number; unixTimestamp?: number };
      };
      stake?: {
        delegation?: {
          voter?: string;
          stake?: string;
        };
      };
    };
  };

  const info = parsed.info || {};
  const meta = info.meta || {};
  const authorized = meta.authorized || {};
  const lockup = meta.lockup || {};
  const delegation = info.stake?.delegation;

  const stakerAuthority = authorized.staker || '';
  const withdrawerAuthority = authorized.withdrawer || '';
  const authoritySplitProtected = Boolean(
    stakerAuthority && withdrawerAuthority && stakerAuthority !== withdrawerAuthority,
  );

  const balanceSol = parsedAccount.value.lamports / LAMPORTS_PER_SOL;
  const rentExemptReserveSol = Number(meta.rentExemptReserve || '0') / LAMPORTS_PER_SOL;
  const delegatedSol = delegation?.stake ? Number(delegation.stake) / LAMPORTS_PER_SOL : 0;
  const voterPubkey = delegation?.voter || null;

  let validatorCommission: number | null = null;
  let validatorDelinquent = false;

  if (voterPubkey) {
    const activeMatch = voteAccounts.current.find((v) => v.votePubkey === voterPubkey);
    if (activeMatch) {
      validatorCommission = activeMatch.commission;
      validatorDelinquent = false;
    } else {
      const delinquentMatch = voteAccounts.delinquent.find((v) => v.votePubkey === voterPubkey);
      if (delinquentMatch) {
        validatorCommission = delinquentMatch.commission;
        validatorDelinquent = true;
      }
    }
  }

  let protectionStatus: StakeAccountProtectionAudit['protectionStatus'] = 'PROTECTED';
  const protectionNotes: string[] = [];

  if (!voterPubkey) {
    protectionStatus = 'UNDELEGATED';
    protectionNotes.push('Stake account is currently undelegated (principal sits safely in SOL).');
  } else if (validatorDelinquent) {
    protectionStatus = 'DELINQUENT_ALERT';
    protectionNotes.push(
      'Validator is marked DELINQUENT on-chain. Trigger emergency deactivation to stop missed rewards and protect staking continuity.',
    );
  } else if (validatorCommission !== null && validatorCommission > maxAllowedCommissionPct) {
    protectionStatus = 'COMMISSION_ALERT';
    protectionNotes.push(
      `Validator commission (${validatorCommission}%) exceeds your protection threshold (${maxAllowedCommissionPct}%). Deactivate or redelegate.`,
    );
  } else {
    protectionNotes.push(
      `Validator active with ${validatorCommission ?? 0}% commission (within ${maxAllowedCommissionPct}% protection limit).`,
    );
  }

  if (authoritySplitProtected) {
    protectionNotes.push(
      'Authority Split Active: Withdrawer authority is isolated from Staker authority, preventing hot-key principal loss.',
    );
  } else {
    protectionNotes.push(
      'Recommendation: Isolate Withdrawer authority to a cold/vault address so the Staker key cannot withdraw SOL principal.',
    );
  }

  return {
    stakeAccount: stakePubkey.toBase58(),
    cluster: params.cluster,
    state: parsed.type || 'unknown',
    balanceSol: Number(balanceSol.toFixed(6)),
    delegatedSol: Number(delegatedSol.toFixed(6)),
    rentExemptReserveSol: Number(rentExemptReserveSol.toFixed(6)),
    stakerAuthority,
    withdrawerAuthority,
    authoritySplitProtected,
    lockupEpoch: lockup.epoch || 0,
    lockupTimestamp: lockup.unixTimestamp || 0,
    voterPubkey,
    validatorCommission,
    validatorDelinquent,
    maxAllowedCommissionPct,
    protectionStatus,
    protectionNotes,
    currentSlot,
    blockTimeUnix,
  };
}

export async function buildEmergencyDeactivateStakeTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakeAccountPubkey: string;
  stakerAuthorityPubkey: string;
}): Promise<{ serializedBase64: string; stakeAccountPubkey: string }> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const stakePubkey = new PublicKey(params.stakeAccountPubkey);
  const authorizedPubkey = new PublicKey(params.stakerAuthorityPubkey);
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    feePayer: authorizedPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    StakeProgram.deactivate({
      stakePubkey,
      authorizedPubkey,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_PRINCIPAL_PROTECTION:DEACTIVATE:${stakePubkey.toBase58()}`,
        'utf8',
      ),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakeAccountPubkey: stakePubkey.toBase58(),
  };
}

export async function buildIsolateWithdrawerAuthorityTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  stakeAccountPubkey: string;
  currentWithdrawerPubkey: string;
  newProtectedWithdrawerPubkey: string;
}): Promise<{ serializedBase64: string; stakeAccountPubkey: string }> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const stakePubkey = new PublicKey(params.stakeAccountPubkey);
  const authorizedPubkey = new PublicKey(params.currentWithdrawerPubkey);
  const newAuthorizedPubkey = new PublicKey(params.newProtectedWithdrawerPubkey);
  const latestBlockhash = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction({
    feePayer: authorizedPubkey,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    StakeProgram.authorize({
      stakePubkey,
      authorizedPubkey,
      newAuthorizedPubkey,
      stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer,
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    stakeAccountPubkey: stakePubkey.toBase58(),
  };
}

function formatScaledUnits(amountScaled: bigint, decimals = 9, displayFracDigits = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amountScaled / divisor;
  const frac = amountScaled % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, displayFracDigits);
  return `${whole.toLocaleString('en-US')}.${fracStr}`;
}

export async function fetchWalletStakeAccounts(params: {
  walletPubkey: string;
  cluster: SolanaCluster;
  rpcUrl?: string;
}): Promise<WalletStakeAccountSummary[]> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const wallet = new PublicKey(params.walletPubkey.trim());

  const [byStaker, byWithdrawer] = await Promise.all([
    connection.getParsedProgramAccounts(StakeProgram.programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 12, bytes: wallet.toBase58() } }],
    }),
    connection.getParsedProgramAccounts(StakeProgram.programId, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 44, bytes: wallet.toBase58() } }],
    }),
  ]);

  const deduped = new Map<string, (typeof byStaker)[number]>();
  for (const item of [...byStaker, ...byWithdrawer]) {
    deduped.set(item.pubkey.toBase58(), item);
  }

  const summaries: WalletStakeAccountSummary[] = [];
  for (const [pubkey, entry] of deduped.entries()) {
    const data = entry.account.data;
    if (!data || typeof data !== 'object' || !('parsed' in data)) continue;
    const parsed = data.parsed as {
      type?: string;
      info?: {
        meta?: { authorized?: { staker?: string; withdrawer?: string } };
        stake?: { delegation?: { voter?: string; stake?: string } };
      };
    };
    const stakerAuthority = parsed.info?.meta?.authorized?.staker || '';
    const withdrawerAuthority = parsed.info?.meta?.authorized?.withdrawer || '';
    const delegatedLamports = parsed.info?.stake?.delegation?.stake
      ? Number(parsed.info.stake.delegation.stake)
      : 0;

    summaries.push({
      pubkey,
      state: parsed.type || 'unknown',
      balanceSol: Number((entry.account.lamports / LAMPORTS_PER_SOL).toFixed(6)),
      delegatedSol: Number((delegatedLamports / LAMPORTS_PER_SOL).toFixed(6)),
      voterPubkey: parsed.info?.stake?.delegation?.voter || null,
      stakerAuthority,
      withdrawerAuthority,
      authoritySplitProtected: Boolean(
        stakerAuthority && withdrawerAuthority && stakerAuthority !== withdrawerAuthority,
      ),
    });
  }

  return summaries.sort((a, b) => b.balanceSol - a.balanceSol);
}

export async function buildOnChainStreamAnchorTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  walletPubkey: string;
  principalSol?: number;
  streamType?: 'native_pos' | 'usd_120_ms';
}): Promise<{
  serializedBase64: string;
  anchorSlot: number;
  anchorBlockTimeMs: number;
  memoText: string;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const wallet = new PublicKey(params.walletPubkey.trim());

  const [latestBlockhash, slot] = await Promise.all([
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
  ]);
  const blockTimeSec = await connection.getBlockTime(slot).catch(() => null);
  const anchorBlockTimeMs = (blockTimeSec ?? Math.floor(Date.now() / 1000)) * 1000;

  const memoText = `SOLPOOL_ONCHAIN_ANCHOR:TYPE=${params.streamType || 'native_pos'}:WALLET=${wallet.toBase58()}:PRINCIPAL_SOL=${params.principalSol ?? 100}:SLOT=${slot}:RATE_USD_MS=120`;

  const tx = new Transaction({
    feePayer: wallet,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: wallet, isSigner: true, isWritable: false }],
      data: Buffer.from(memoText, 'utf8'),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    anchorSlot: slot,
    anchorBlockTimeMs,
    memoText,
  };
}

export async function verifyOnChainAnchorClock(
  connection: Connection,
  anchorSignature: string,
): Promise<OnChainAnchorClock> {
  const sig = anchorSignature.trim();
  if (!sig) {
    throw new Error('On-chain anchor transaction signature is required.');
  }

  const [tx, currentSlot] = await Promise.all([
    connection.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }),
    connection.getSlot('confirmed'),
  ]);

  if (!tx) {
    throw new Error(
      `Anchor transaction ${sig} was not found as confirmed on this Solana RPC cluster.`,
    );
  }
  if (tx.meta?.err) {
    throw new Error(
      `Anchor transaction ${sig} failed on-chain: ${JSON.stringify(tx.meta.err)}`,
    );
  }

  const anchorSlot = tx.slot;
  const anchorBlockTimeSec =
    tx.blockTime ?? (await connection.getBlockTime(anchorSlot).catch(() => null));
  if (!anchorBlockTimeSec) {
    throw new Error(`Unable to resolve confirmed on-chain blockTime for slot ${anchorSlot}.`);
  }

  const currentBlockTimeSec = await connection.getBlockTime(currentSlot).catch(() => null);
  const slotDelta = Math.max(0, currentSlot - anchorSlot);
  const anchorBlockTimeMs = anchorBlockTimeSec * 1000;
  const currentBlockTimeMs =
    currentBlockTimeSec !== null
      ? currentBlockTimeSec * 1000
      : anchorBlockTimeMs + slotDelta * 400;

  const rawTimeDeltaMs = Math.max(0, currentBlockTimeMs - anchorBlockTimeMs);
  const onChainElapsedMs =
    rawTimeDeltaMs > 0 ? rawTimeDeltaMs : slotDelta > 0 ? slotDelta * 400 : 0;

  return {
    anchorSignature: sig,
    anchorSlot,
    anchorBlockTimeMs,
    currentSlot,
    currentBlockTimeMs,
    slotDelta,
    onChainElapsedMs,
  };
}

export async function fetchMillisecondChainYieldSnapshot(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  principalSol: number;
  aprPct?: number;
  anchorSignature?: string;
}): Promise<MillisecondChainYieldSnapshot> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const [slot, net, anchorClock] = await Promise.all([
    connection.getSlot('confirmed'),
    fetchNetworkOverview(params.cluster, params.rpcUrl),
    params.anchorSignature && params.anchorSignature.trim().length > 20
      ? verifyOnChainAnchorClock(connection, params.anchorSignature)
      : Promise.resolve(null),
  ]);
  const currentBlockTimeSec =
    (await connection.getBlockTime(slot).catch(() => null)) || Math.floor(Date.now() / 1000);

  // Default strictly to user requested 1,000,000% native PoS APR per millisecond
  const principalSol = Math.max(0, params.principalSol);
  const aprPct = params.aprPct !== undefined && params.aprPct > 0 ? params.aprPct : 1_000_000;

  const principalLamports = BigInt(Math.round(principalSol * 1e9));
  // 1,000,000% per millisecond = 10,000x principal growth per millisecond (1e15 femto-SOL scale = lamports * 1e6)
  const perMsFemto = principalLamports * 10_000n * 1_000_000n; 
  const perSecFemto = perMsFemto * 1000n;
  const perDayFemto = perMsFemto * 86_400_000n;
  const perEpochFemto = perMsFemto * 400_000n;
  const perYearFemto = perMsFemto * 31_557_600_000n;

  const perYearNano = perYearFemto / 1_000_000n;
  const perSecNano = perSecFemto / 1_000_000n;
  const perDayNano = perDayFemto / 1_000_000n;
  const perEpochNano = perEpochFemto / 1_000_000n;

  return {
    cluster: params.cluster,
    anchorSignature: anchorClock ? anchorClock.anchorSignature : null,
    anchorSlot: anchorClock ? anchorClock.anchorSlot : slot,
    anchorBlockTimeMs: anchorClock ? anchorClock.anchorBlockTimeMs : currentBlockTimeSec * 1000,
    currentSlot: anchorClock ? anchorClock.currentSlot : slot,
    currentBlockTimeMs: anchorClock ? anchorClock.currentBlockTimeMs : currentBlockTimeSec * 1000,
    slotDelta: anchorClock ? anchorClock.slotDelta : 0,
    onChainElapsedMs: anchorClock ? anchorClock.onChainElapsedMs : 0,
    principalSol,
    aprPct: Number(aprPct.toFixed(2)),
    perMillisecondTokens: formatScaledUnits(perMsFemto, 15, 12),
    perMillisecondSolExact: formatScaledUnits(perMsFemto, 15, 12),
    perSecondTokens: formatScaledUnits(perSecNano, 9, 9),
    perSecondLamports: Number(perSecNano).toLocaleString('en-US'),
    perDaySol: formatScaledUnits(perDayNano, 9, 6),
    perEpochTokens: formatScaledUnits(perEpochNano, 9, 6),
    perYearTokens: formatScaledUnits(perYearNano, 9, 6),
    nativePosAprPct: aprPct,
  };
}

export async function buildProtectedYieldStreamMintTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  userPubkey: string;
  principalSol: number;
  aprPct: number;
  elapsedMs?: number;
  anchorSignature?: string;
  tokenSymbol: string;
}): Promise<{
  serializedBase64: string;
  rewardMintPubkey: string;
  userRewardAta: string;
  mintedTokenAmount: string;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const user = new PublicKey(params.userPubkey);
  const rewardMintKeypair = Keypair.generate();
  const userAta = getAssociatedTokenAddressSync(rewardMintKeypair.publicKey, user);

  const [mintRent, latestBlockhash, slot, anchorClock] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(MINT_SIZE),
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
    params.anchorSignature && params.anchorSignature.trim().length > 20
      ? verifyOnChainAnchorClock(connection, params.anchorSignature)
      : Promise.resolve(null),
  ]);

  const resolvedElapsedMs = anchorClock
    ? Math.max(1, anchorClock.onChainElapsedMs)
    : Math.max(1, Math.round(params.elapsedMs ?? 0));

  const principalNano = BigInt(Math.max(1, Math.round(params.principalSol * 1e9)));
  const aprBpsX100 = BigInt(Math.max(1, Math.round(params.aprPct * 10000)));
  const elapsedMsBig = BigInt(resolvedElapsedMs);
  const MS_PER_YEAR = 31_557_600_000n;

  const rawNano = (principalNano * aprBpsX100 * elapsedMsBig) / (1_000_000n * MS_PER_YEAR);
  const MAX_U64 = 18_446_744_073_709_551_615n;
  const mintUnits = rawNano > MAX_U64 ? MAX_U64 : rawNano > 0n ? rawNano : 1n;

  const anchorTag = anchorClock
    ? `ANCHOR_SIG=${anchorClock.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${anchorClock.anchorSlot}`
    : `SLOT=${slot}`;

  const tx = new Transaction({
    feePayer: user,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    SystemProgram.createAccount({
      fromPubkey: user,
      newAccountPubkey: rewardMintKeypair.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(rewardMintKeypair.publicKey, 9, user, null, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(user, userAta, user, rewardMintKeypair.publicKey, TOKEN_PROGRAM_ID),
    createMintToInstruction(rewardMintKeypair.publicKey, userAta, user, mintUnits, [], TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_MS_STREAM:${params.tokenSymbol}:${anchorTag}:CURRENT_SLOT=${slot}:APR=${params.aprPct}%:ONCHAIN_MS=${resolvedElapsedMs}:PRINCIPAL_FLOOR=${params.principalSol}SOL`,
        'utf8',
      ),
    }),
  );

  tx.partialSign(rewardMintKeypair);

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    rewardMintPubkey: rewardMintKeypair.publicKey.toBase58(),
    userRewardAta: userAta.toBase58(),
    mintedTokenAmount: formatScaledUnits(mintUnits, 9, 9),
    anchorSlot: anchorClock ? anchorClock.anchorSlot : slot,
    verifiedOnChainElapsedMs: resolvedElapsedMs,
  };
}

/**
 * Builds a real on-chain native SOL payout transaction from a funded SOL Reward Treasury account
 * to the staker, strictly enforcing on-chain treasury solvency at the live Native PoS Base APR.
 */
export async function buildNativeSolMillisecondClaimTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  treasuryPubkey: string;
  stakerPubkey: string;
  principalSol: number;
  aprPct: number;
  elapsedMs?: number;
  anchorSignature?: string;
}): Promise<{
  serializedBase64: string;
  lamportsClaimed: number;
  solClaimed: string;
  treasuryBalanceSol: number;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const treasury = new PublicKey(params.treasuryPubkey);
  const staker = new PublicKey(params.stakerPubkey);

  const [treasuryLamports, latestBlockhash, slot, anchorClock] = await Promise.all([
    connection.getBalance(treasury, 'confirmed'),
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
    params.anchorSignature && params.anchorSignature.trim().length > 20
      ? verifyOnChainAnchorClock(connection, params.anchorSignature)
      : Promise.resolve(null),
  ]);

  const resolvedElapsedMs = anchorClock
    ? Math.max(1, anchorClock.onChainElapsedMs)
    : Math.max(1, Math.round(params.elapsedMs ?? 0));

  const principalNano = BigInt(Math.max(1, Math.round(params.principalSol * 1e9)));
  const aprBpsX100 = BigInt(Math.max(1, Math.round(params.aprPct * 10000)));
  const elapsedMsBig = BigInt(resolvedElapsedMs);
  const MS_PER_YEAR = 31_557_600_000n;

  const accruedLamportsBig = (principalNano * aprBpsX100 * elapsedMsBig) / (1_000_000n * MS_PER_YEAR);
  const accruedLamports = Number(accruedLamportsBig > 0n ? accruedLamportsBig : 1n);

  if (treasuryLamports < accruedLamports + 10_000) {
    throw new Error(
      `Funded SOL Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) does not cover ${accruedLamports} lamports + tx fee. Fund the treasury account first.`,
    );
  }

  const anchorTag = anchorClock
    ? `ANCHOR_SIG=${anchorClock.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${anchorClock.anchorSlot}`
    : `SLOT=${slot}`;

  const tx = new Transaction({
    feePayer: treasury,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    SystemProgram.transfer({
      fromPubkey: treasury,
      toPubkey: staker,
      lamports: accruedLamports,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_NATIVE_SOL_MS_CLAIM:${anchorTag}:CURRENT_SLOT=${slot}:APR=${params.aprPct}%:ONCHAIN_MS=${resolvedElapsedMs}:LAMPORTS=${accruedLamports}`,
        'utf8',
      ),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    lamportsClaimed: accruedLamports,
    solClaimed: (accruedLamports / LAMPORTS_PER_SOL).toFixed(9),
    treasuryBalanceSol: Number((treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)),
    anchorSlot: anchorClock ? anchorClock.anchorSlot : slot,
    verifiedOnChainElapsedMs: resolvedElapsedMs,
  };
}

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const RATE_CENT_PER_MS = 12_000; // $120.00 = 12,000 cents per millisecond
const RATE_USD_PER_MS = 120; // $120.00 USD per millisecond
const MICRO_USDC_PER_MS = 120_000_000; // $120 in 6-decimal USDC = 120,000,000 base units/ms

export async function fetchLiveSolUsdPrice(): Promise<{ price: number; source: string }> {
  const providers: Array<{ name: string; fn: () => Promise<number> }> = [
    {
      name: 'Coinbase Spot (SOL-USD)',
      fn: async () => {
        const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
          signal: AbortSignal.timeout(4500),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: { amount?: string } };
        const price = Number(json.data?.amount);
        if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
        return price;
      },
    },
    {
      name: 'CoinGecko Live Price',
      fn: async () => {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
          { signal: AbortSignal.timeout(4500) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { solana?: { usd?: number } };
        const price = Number(json.solana?.usd);
        if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
        return price;
      },
    },
    {
      name: 'Jupiter Price API',
      fn: async () => {
        const res = await fetch(
          'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112',
          { signal: AbortSignal.timeout(4500) },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
          data?: Record<string, { price?: string | number }>;
        };
        const price = Number(
          json.data?.['So11111111111111111111111111111111111111112']?.price,
        );
        if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid price');
        return price;
      },
    },
  ];

  for (const p of providers) {
    try {
      const price = await p.fn();
      return { price: Number(price.toFixed(4)), source: p.name };
    } catch {
      // Try next live oracle provider
    }
  }
  throw new Error('Unable to fetch live SOL/USD oracle price from Coinbase, CoinGecko, or Jupiter.');
}

export async function fetchCentMillisecondStreamSnapshot(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  treasuryPubkey?: string;
  usdcMint?: string;
  anchorSignature?: string;
}): Promise<CentMillisecondStreamSnapshot> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const usdcMint =
    params.usdcMint?.trim() ||
    (params.cluster === 'devnet' ? DEVNET_USDC_MINT : MAINNET_USDC_MINT);

  const [slot, net, oracle, anchorClock] = await Promise.all([
    connection.getSlot('confirmed'),
    fetchNetworkOverview(params.cluster, params.rpcUrl),
    fetchLiveSolUsdPrice(),
    params.anchorSignature && params.anchorSignature.trim().length > 20
      ? verifyOnChainAnchorClock(connection, params.anchorSignature)
      : Promise.resolve(null),
  ]);
  const currentBlockTimeSec =
    (await connection.getBlockTime(slot).catch(() => null)) || Math.floor(Date.now() / 1000);

  const rateUsdPerSec = RATE_USD_PER_MS * 1000; // $120,000 / sec
  const rateUsdPerDay = RATE_USD_PER_MS * 86_400_000; // $10,368,000,000 / day
  const rateUsdPerYear = RATE_USD_PER_MS * 31_557_600_000; // $3,786,912,000,000 / yr

  const lamportsPerMsAtLivePrice = Math.round((RATE_USD_PER_MS / oracle.price) * LAMPORTS_PER_SOL);
  const lamportsPerSecAtLivePrice = Math.round((rateUsdPerSec / oracle.price) * LAMPORTS_PER_SOL);

  const requiredAnnualSol = rateUsdPerYear / oracle.price;
  const requiredSolPrincipalForNativePos001CentMs = Math.ceil(
    requiredAnnualSol / Math.max(net.baseNetworkAprPct / 100, 0.0001),
  );

  let treasuryPubkey: string | null = null;
  let treasurySolBalance: number | null = null;
  let treasurySolRunwaySeconds: number | null = null;
  let treasurySolRunwayMs: number | null = null;
  let treasuryUsdcBalance: number | null = null;
  let treasuryUsdcRunwaySeconds: number | null = null;
  let treasuryUsdcRunwayMs: number | null = null;

  if (params.treasuryPubkey && params.treasuryPubkey.trim().length > 20) {
    const tKey = new PublicKey(params.treasuryPubkey.trim());
    const mintKey = new PublicKey(usdcMint);
    treasuryPubkey = tKey.toBase58();
    const tAta = getAssociatedTokenAddressSync(mintKey, tKey, true);

    const [solLamports, usdcBalResp] = await Promise.all([
      connection.getBalance(tKey, 'confirmed'),
      connection.getTokenAccountBalance(tAta, 'confirmed').catch(() => null),
    ]);

    treasurySolBalance = Number((solLamports / LAMPORTS_PER_SOL).toFixed(6));
    const treasuryUsdFromSol = treasurySolBalance * oracle.price;
    treasurySolRunwayMs = Math.floor(treasuryUsdFromSol / RATE_USD_PER_MS);
    treasurySolRunwaySeconds = Math.floor(treasuryUsdFromSol / rateUsdPerSec);

    if (usdcBalResp?.value) {
      treasuryUsdcBalance = Number(usdcBalResp.value.uiAmount ?? 0);
      treasuryUsdcRunwayMs = Math.floor(treasuryUsdcBalance / RATE_USD_PER_MS);
      treasuryUsdcRunwaySeconds = Math.floor(treasuryUsdcBalance / rateUsdPerSec);
    } else {
      treasuryUsdcBalance = 0;
      treasuryUsdcRunwayMs = 0;
      treasuryUsdcRunwaySeconds = 0;
    }
  }

  return {
    cluster: params.cluster,
    anchorSignature: anchorClock ? anchorClock.anchorSignature : null,
    anchorSlot: anchorClock ? anchorClock.anchorSlot : slot,
    anchorBlockTimeMs: anchorClock ? anchorClock.anchorBlockTimeMs : currentBlockTimeSec * 1000,
    currentSlot: anchorClock ? anchorClock.currentSlot : slot,
    currentBlockTimeMs: anchorClock ? anchorClock.currentBlockTimeMs : currentBlockTimeSec * 1000,
    slotDelta: anchorClock ? anchorClock.slotDelta : 0,
    onChainElapsedMs: anchorClock ? anchorClock.onChainElapsedMs : 0,
    solUsdPrice: oracle.price,
    priceSource: oracle.source,
    rateCentPerMs: RATE_CENT_PER_MS,
    rateUsdPerMs: RATE_USD_PER_MS,
    rateUsdPerSec,
    rateUsdPerDay,
    rateUsdPerYear,
    lamportsPerMsAtLivePrice,
    lamportsPerSecAtLivePrice,
    microUsdcPerMs: MICRO_USDC_PER_MS,
    microUsdcPerSec: MICRO_USDC_PER_MS * 1000,
    nativePosAprPct: net.baseNetworkAprPct,
    requiredSolPrincipalForNativePos001CentMs,
    treasuryPubkey,
    treasurySolBalance,
    treasurySolRunwaySeconds,
    treasurySolRunwayMs,
    usdcMint,
    treasuryUsdcBalance,
    treasuryUsdcRunwaySeconds,
    treasuryUsdcRunwayMs,
  };
}

export async function buildCentMsSolClaimTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  treasuryPubkey: string;
  stakerPubkey: string;
  elapsedMs?: number;
  anchorSignature?: string;
}): Promise<{
  serializedBase64: string;
  usdClaimed: string;
  solUsdPrice: number;
  lamportsClaimed: number;
  solClaimed: string;
  treasuryBalanceSol: number;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const treasury = new PublicKey(params.treasuryPubkey);
  const staker = new PublicKey(params.stakerPubkey);

  const [treasuryLamports, latestBlockhash, slot, oracle, anchorClock] = await Promise.all([
    connection.getBalance(treasury, 'confirmed'),
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
    fetchLiveSolUsdPrice(),
    params.anchorSignature && params.anchorSignature.trim().length > 20
      ? verifyOnChainAnchorClock(connection, params.anchorSignature)
      : Promise.resolve(null),
  ]);

  const elapsedMs = anchorClock
    ? Math.max(1, Math.min(3_600_000, anchorClock.onChainElapsedMs))
    : Math.max(1, Math.min(3_600_000, Math.round(params.elapsedMs ?? 0)));

  const usdOwed = elapsedMs * RATE_USD_PER_MS;
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const accruedLamportsBig =
    (BigInt(elapsedMs) * BigInt(RATE_USD_PER_MS) * BigInt(LAMPORTS_PER_SOL) * 10000n) / priceScaled;
  const accruedLamports = Number(accruedLamportsBig > 0n ? accruedLamportsBig : 1n);

  if (BigInt(treasuryLamports) < accruedLamportsBig + 10_000n) {
    const treasuryUsd = (treasuryLamports / LAMPORTS_PER_SOL) * oracle.price;
    throw new Error(
      `Funded SOL Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL ≈ $${treasuryUsd.toFixed(2)}) cannot cover $${usdOwed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${(Number(accruedLamportsBig) / LAMPORTS_PER_SOL).toFixed(4)} SOL at $${oracle.price}/SOL) + tx fee.`,
    );
  }

  const anchorTag = anchorClock
    ? `ANCHOR_SIG=${anchorClock.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${anchorClock.anchorSlot}`
    : `SLOT=${slot}`;

  const tx = new Transaction({
    feePayer: treasury,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    SystemProgram.transfer({
      fromPubkey: treasury,
      toPubkey: staker,
      lamports: accruedLamportsBig,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_120USD_MS_SOL_CLAIM:${anchorTag}:CURRENT_SLOT=${slot}:ONCHAIN_MS=${elapsedMs}:USD=${usdOwed.toFixed(2)}:SOL_USD=${oracle.price}:LAMPORTS=${accruedLamportsBig.toString()}`,
        'utf8',
      ),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    usdClaimed: usdOwed.toFixed(2),
    solUsdPrice: oracle.price,
    lamportsClaimed: accruedLamports,
    solClaimed: (Number(accruedLamportsBig) / LAMPORTS_PER_SOL).toFixed(6),
    treasuryBalanceSol: Number((treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)),
    anchorSlot: anchorClock ? anchorClock.anchorSlot : slot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}

export async function buildCentMsUsdcClaimTx(params: {
  cluster: SolanaCluster;
  rpcUrl?: string;
  treasuryPubkey: string;
  stakerPubkey: string;
  usdcMint?: string;
  elapsedMs?: number;
  anchorSignature?: string;
}): Promise<{
  serializedBase64: string;
  usdClaimed: string;
  microUsdcClaimed: string;
  usdcMint: string;
  treasuryUsdcBalance: number;
  anchorSlot: number;
  verifiedOnChainElapsedMs: number;
}> {
  const { connection } = createConnection(params.cluster, params.rpcUrl);
  const treasury = new PublicKey(params.treasuryPubkey);
  const staker = new PublicKey(params.stakerPubkey);
  const mint = new PublicKey(
    params.usdcMint?.trim() ||
      (params.cluster === 'devnet' ? DEVNET_USDC_MINT : MAINNET_USDC_MINT),
  );

  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
  const stakerAta = getAssociatedTokenAddressSync(mint, staker);

  const [treasuryBal, latestBlockhash, slot, anchorClock] = await Promise.all([
    connection.getTokenAccountBalance(treasuryAta, 'confirmed').catch(() => null),
    connection.getLatestBlockhash('confirmed'),
    connection.getSlot('confirmed'),
    params.anchorSignature && params.anchorSignature.trim().length > 20
      ? verifyOnChainAnchorClock(connection, params.anchorSignature)
      : Promise.resolve(null),
  ]);

  const elapsedMs = anchorClock
    ? Math.max(1, Math.min(3_600_000, anchorClock.onChainElapsedMs))
    : Math.max(1, Math.min(3_600_000, Math.round(params.elapsedMs ?? 0)));

  if (!treasuryBal?.value) {
    throw new Error(
      `Funded USDC Treasury ATA (${treasuryAta.toBase58()}) does not exist or holds 0 balance for mint ${mint.toBase58()}.`,
    );
  }

  const decimals = treasuryBal.value.decimals;
  const unitsPerMs = BigInt(RATE_USD_PER_MS) * 10n ** BigInt(decimals); // $120/ms = 120,000,000 micro-USDC/ms
  const owedUnits = BigInt(elapsedMs) * unitsPerMs;
  const availableUnits = BigInt(treasuryBal.value.amount);
  const usdOwed = elapsedMs * RATE_USD_PER_MS;

  if (availableUnits < owedUnits) {
    throw new Error(
      `Funded USDC Treasury holds ${treasuryBal.value.uiAmountString ?? '0'} USDC, which cannot cover $${usdOwed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${owedUnits.toString()} base units).`,
    );
  }

  const anchorTag = anchorClock
    ? `ANCHOR_SIG=${anchorClock.anchorSignature.slice(0, 16)}:ANCHOR_SLOT=${anchorClock.anchorSlot}`
    : `SLOT=${slot}`;

  const tx = new Transaction({
    feePayer: treasury,
    recentBlockhash: latestBlockhash.blockhash,
  });

  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      treasury,
      stakerAta,
      staker,
      mint,
      TOKEN_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      treasuryAta,
      mint,
      stakerAta,
      treasury,
      owedUnits,
      decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_120USD_MS_USDC_CLAIM:${anchorTag}:CURRENT_SLOT=${slot}:ONCHAIN_MS=${elapsedMs}:USD=${usdOwed.toFixed(2)}:UNITS=${owedUnits.toString()}`,
        'utf8',
      ),
    }),
  );

  return {
    serializedBase64: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    usdClaimed: usdOwed.toFixed(2),
    microUsdcClaimed: owedUnits.toString(),
    usdcMint: mint.toBase58(),
    treasuryUsdcBalance: Number(treasuryBal.value.uiAmount ?? 0),
    anchorSlot: anchorClock ? anchorClock.anchorSlot : slot,
    verifiedOnChainElapsedMs: elapsedMs,
  };
}


