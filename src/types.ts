export type SolanaCluster = 'mainnet-beta' | 'devnet' | 'testnet' | 'custom';

export interface ValidatorSummary {
  votePubkey: string;
  nodePubkey: string;
  activatedStakeSol: number;
  commission: number;
  lastVote: number;
  epochCredits: number;
  delinquent: boolean;
  estimatedNetAprPct: number;
  estimatedNetApyPct: number;
}

export interface NetworkOverview {
  cluster: SolanaCluster;
  rpcEndpoint: string;
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  epochProgressPct: number;
  absoluteSlot: number;
  avgSlotTimeSec: number;
  estimatedEpochDays: number;
  epochsPerYear: number;
  inflationTotalPct: number;
  inflationValidatorPct: number;
  inflationFoundationPct: number;
  totalSupplySol: number;
  circulatingSupplySol: number;
  totalActivatedStakeSol: number;
  stakeParticipationPct: number;
  baseNetworkAprPct: number;
  baseNetworkApyPct: number;
  activeValidatorCount: number;
  delinquentValidatorCount: number;
  validators: ValidatorSummary[];
  fetchedAt: string;
}

export interface LivePoolValidator {
  voteAccountAddress: string;
  activeStakeSol: number;
  transientStakeSol: number;
  lastUpdateEpoch: number;
  status: string;
}

export interface LiveStakePoolData {
  address: string;
  name?: string;
  symbol?: string;
  programId: string;
  manager: string;
  staker: string;
  poolMint: string;
  reserveStake: string;
  validatorListAddress: string;
  managerFeeAccount: string;
  poolWithdrawAuthority: string;
  totalLamports: string;
  totalSol: number;
  poolTokenSupply: string;
  poolTokenSupplyUi: number;
  lstExchangeRate: number;
  lastUpdateEpoch: number;
  lastEpochTotalSol: number;
  lastEpochSupplyUi: number;
  realizedEpochAprPct: number;
  realizedEpochApyPct: number;
  epochFeePct: number;
  solDepositFeePct: number;
  solWithdrawalFeePct: number;
  stakeDepositFeePct: number;
  stakeWithdrawalFeePct: number;
  solReferralFeePct: number;
  maxValidators: number;
  validatorCount: number;
  validators: LivePoolValidator[];
}

export interface RoiProjectionPoint {
  day: number;
  epoch: number;
  totalSol: number;
  posYieldSol: number;
  boostYieldSol: number;
  feeDragSol: number;
  cumulativeRoiPct: number;
  usdValue: number;
}

export interface RoiCalculationResult {
  grossPosAprPct: number;
  netPosAprPct: number;
  protocolBoostAprPct: number;
  totalEffectiveAprPct: number;
  effectiveApyPct: number;
  projectedFinalSol: number;
  totalProfitSol: number;
  totalRoiPct: number;
  projectedFinalUsd: number;
  dailyYieldSol: number;
  epochYieldSol: number;
  perMsYieldSol?: number;
  isSimulatedOffChain?: boolean;
  lstAppreciation1Yr: number;
  points: RoiProjectionPoint[];
}

export interface ProtocolConfig {
  id: string;
  packageName: string;
  protocolName: string;
  tokenSymbol: string;
  tokenName: string;
  cluster: SolanaCluster;
  rpcUrl?: string;
  roiMode: 'native_pos_lst' | 'native_direct_stake' | 'hybrid_boosted_pool';
  payerPubkey: string;
  managerPubkey: string;
  stakerPubkey: string;
  maxValidators: number;
  epochFeeBps: number;
  solDepositFeeBps: number;
  solWithdrawalFeeBps: number;
  stakeDepositFeeBps: number;
  stakeWithdrawalFeeBps: number;
  referralFeePct: number;
  protocolBoostAprPct: number;
  initialReserveSol: number;
  selectedValidators: string[];
  stakePoolAddress?: string;
  poolMintAddress?: string;
  validatorListAddress?: string;
  reserveStakeAddress?: string;
  withdrawAuthorityAddress?: string;
  managerFeeAccountAddress?: string;
  status: 'draft' | 'tx_built' | 'deployed';
  deploymentSignatures?: string[];
  createdAt: string;
}

export interface BuiltTransactionStep {
  stepIndex: number;
  title: string;
  description: string;
  serializedBase64: string;
  signersRequired: string[];
  partialSignedBy: string[];
}

export interface BuildProtocolTxResponse {
  protocol: ProtocolConfig;
  addresses: {
    stakePool: string;
    poolMint: string;
    validatorList: string;
    reserveStake: string;
    withdrawAuthority: string;
    managerFeeAccount: string;
    programId: string;
  };
  estimatedRentSol: number;
  transactions: BuiltTransactionStep[];
}

export interface GeneratedPackageFile {
  path: string;
  language: string;
  content: string;
}

export interface StakeAccountProtectionAudit {
  stakeAccount: string;
  cluster: SolanaCluster;
  state: string;
  balanceSol: number;
  delegatedSol: number;
  rentExemptReserveSol: number;
  stakerAuthority: string;
  withdrawerAuthority: string;
  authoritySplitProtected: boolean;
  lockupEpoch: number;
  lockupTimestamp: number;
  voterPubkey: string | null;
  validatorCommission: number | null;
  validatorDelinquent: boolean;
  maxAllowedCommissionPct: number;
  protectionStatus: 'PROTECTED' | 'COMMISSION_ALERT' | 'DELINQUENT_ALERT' | 'UNDELEGATED';
  protectionNotes: string[];
  currentSlot: number;
  blockTimeUnix: number;
}

export interface OnChainAnchorClock {
  anchorSignature: string;
  anchorSlot: number;
  anchorBlockTimeMs: number;
  currentSlot: number;
  currentBlockTimeMs: number;
  slotDelta: number;
  onChainElapsedMs: number;
}

export interface WalletStakeAccountSummary {
  pubkey: string;
  state: string;
  balanceSol: number;
  delegatedSol: number;
  voterPubkey: string | null;
  stakerAuthority: string;
  withdrawerAuthority: string;
  authoritySplitProtected: boolean;
}

export interface MillisecondChainYieldSnapshot {
  cluster: SolanaCluster;
  anchorSignature?: string | null;
  anchorSlot: number;
  anchorBlockTimeMs: number;
  currentSlot?: number;
  currentBlockTimeMs?: number;
  slotDelta?: number;
  onChainElapsedMs?: number;
  principalSol: number;
  aprPct: number;
  perMillisecondTokens: string;
  perMillisecondSolExact: string;
  perSecondTokens: string;
  perSecondLamports: string;
  perDaySol: string;
  perEpochTokens: string;
  perYearTokens: string;
  nativePosAprPct: number;
}

export interface CentMillisecondStreamSnapshot {
  cluster: SolanaCluster;
  anchorSignature?: string | null;
  anchorSlot: number;
  anchorBlockTimeMs: number;
  currentSlot?: number;
  currentBlockTimeMs?: number;
  slotDelta?: number;
  onChainElapsedMs?: number;
  solUsdPrice: number;
  priceSource: string;
  rateCentPerMs: number;
  rateUsdPerMs: number;
  rateUsdPerSec: number;
  rateUsdPerDay: number;
  rateUsdPerYear: number;
  lamportsPerMsAtLivePrice: number;
  lamportsPerSecAtLivePrice: number;
  microUsdcPerMs: number;
  microUsdcPerSec: number;
  nativePosAprPct: number;
  requiredSolPrincipalForNativePos001CentMs: number;
  treasuryPubkey: string | null;
  treasurySolBalance: number | null;
  treasurySolRunwaySeconds: number | null;
  treasurySolRunwayMs: number | null;
  usdcMint: string;
  treasuryUsdcBalance: number | null;
  treasuryUsdcRunwaySeconds: number | null;
  treasuryUsdcRunwayMs: number | null;
}



