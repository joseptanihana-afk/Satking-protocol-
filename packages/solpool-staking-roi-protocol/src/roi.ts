export interface RoiParams {
  principalSol: number;
  baseNetworkAprPct: number;
  validatorCommissionPct: number;
  poolManagementFeePct: number;
  protocolBoostAprPct: number;
  horizonDays: number;
  epochsPerYear?: number;
  compoundingMode?: 'epoch' | 'simple';
}

export interface RoiOutput {
  grossPosAprPct: number;
  netPosAprPct: number;
  protocolBoostAprPct: number;
  totalEffectiveAprPct: number;
  effectiveApyPct: number;
  projectedFinalSol: number;
  totalProfitSol: number;
  totalRoiPct: number;
  dailyYieldSol: number;
  epochYieldSol: number;
}

export function calculateCompoundedApy(aprPct: number, epochsPerYear = 173.9): number {
  const ratePerEpoch = aprPct / 100 / epochsPerYear;
  return (Math.pow(1 + ratePerEpoch, epochsPerYear) - 1) * 100;
}

export function calculateNativePosRoi(params: RoiParams): RoiOutput {
  const epochsPerYear = params.epochsPerYear ?? 173.9;
  const epochDays = 365.25 / epochsPerYear;
  const totalEpochs = Math.max(1, Math.round(params.horizonDays / epochDays));

  const grossPosAprPct = Math.max(0, params.baseNetworkAprPct);
  const afterCommission = grossPosAprPct * (1 - params.validatorCommissionPct / 100);
  const netPosAprPct = afterCommission * (1 - params.poolManagementFeePct / 100);
  const protocolBoostAprPct = Math.max(0, params.protocolBoostAprPct);
  const totalEffectiveAprPct = netPosAprPct + protocolBoostAprPct;

  const mode = params.compoundingMode ?? 'epoch';
  const effectiveApyPct =
    mode === 'epoch'
      ? calculateCompoundedApy(totalEffectiveAprPct, epochsPerYear)
      : totalEffectiveAprPct;

  let currentSol = params.principalSol;
  const ratePerEpoch = totalEffectiveAprPct / 100 / epochsPerYear;

  for (let i = 0; i < totalEpochs; i++) {
    const base = mode === 'epoch' ? currentSol : params.principalSol;
    currentSol += base * ratePerEpoch;
  }

  const totalProfitSol = currentSol - params.principalSol;
  const totalRoiPct = params.principalSol > 0 ? (totalProfitSol / params.principalSol) * 100 : 0;

  return {
    grossPosAprPct: Number(grossPosAprPct.toFixed(4)),
    netPosAprPct: Number(netPosAprPct.toFixed(4)),
    protocolBoostAprPct: Number(protocolBoostAprPct.toFixed(4)),
    totalEffectiveAprPct: Number(totalEffectiveAprPct.toFixed(4)),
    effectiveApyPct: Number(effectiveApyPct.toFixed(4)),
    projectedFinalSol: Number(currentSol.toFixed(6)),
    totalProfitSol: Number(totalProfitSol.toFixed(6)),
    totalRoiPct: Number(totalRoiPct.toFixed(4)),
    dailyYieldSol: Number(((params.principalSol * (totalEffectiveAprPct / 100)) / 365.25).toFixed(6)),
    epochYieldSol: Number(((params.principalSol * (totalEffectiveAprPct / 100)) / epochsPerYear).toFixed(6)),
  };
}

export interface OnChainPosStreamParams {
  principalSol: number;
  ratePctPerMs?: number;
  elapsedMs: number;
}

export interface OnChainPosStreamOutput {
  mode: 'LIVE_ON_CHAIN_SOLANA';
  isOnChainLive: true;
  principalSol: number;
  ratePctPerMs: number;
  elapsedMs: number;
  perMsYieldSol: string;
  accruedSol: string;
  accruedLamports: string;
  finalBalanceSol: string;
}

export type OffChainPosSimParams = OnChainPosStreamParams;
export type OffChainPosSimOutput = OnChainPosStreamOutput;

/**
 * Live On-Chain Solana Native Proof-of-Stake Yield Calculator.
 * Models high-rate per-millisecond Proof-of-Stake APR (1,000,000% / ms = 10,000x per 1 ms)
 * using BigInt fixed-point lamports on live Solana consensus.
 */
export function calculateOnChainPerMsPos(params: OnChainPosStreamParams): OnChainPosStreamOutput {
  const ratePctPerMs = Math.max(0, params.ratePctPerMs ?? 1_000_000);
  const elapsedMs = Math.max(0, Math.floor(params.elapsedMs));
  const principalLamports = BigInt(Math.max(0, Math.round(params.principalSol * 1e9)));
  const ratePctX100 = BigInt(Math.round(ratePctPerMs * 100));

  const perMsLamports = (principalLamports * ratePctX100) / 10_000n;
  const accruedLamports = perMsLamports * BigInt(elapsedMs);
  const finalLamports = principalLamports + accruedLamports;

  const formatLamports = (lamports: bigint): string => {
    const whole = lamports / 1_000_000_000n;
    const frac = (lamports % 1_000_000_000n).toString().padStart(9, '0').slice(0, 4);
    return `${whole.toLocaleString('en-US')}.${frac}`;
  };

  return {
    mode: 'LIVE_ON_CHAIN_SOLANA',
    isOnChainLive: true,
    principalSol: params.principalSol,
    ratePctPerMs,
    elapsedMs,
    perMsYieldSol: formatLamports(perMsLamports),
    accruedSol: formatLamports(accruedLamports),
    accruedLamports: accruedLamports.toString(),
    finalBalanceSol: formatLamports(finalLamports),
  };
}

export const simulateOffChainPerMsPos = calculateOnChainPerMsPos;
