import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Coins,
  DollarSign,
  Layers,
  Lock,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import type {
  CentMillisecondStreamSnapshot,
  ProtocolConfig,
  SolanaCluster,
  StakeAccountProtectionAudit,
  WalletStakeAccountSummary,
} from '../types';
import {
  type SolanaWalletProvider,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
} from '../utils/solanaWallet';

interface ProtectionGuardianProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  protocols: ProtocolConfig[];
  tokenSymbol: string;
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  onConnectWallet: () => void;
}

interface OffChainSimLedgerEntry {
  id: string;
  action: 'CLAIM_TO_SIM_WALLET' | 'COMPOUND_PRINCIPAL' | 'RESET';
  amountSol: string;
  elapsedMs: number;
  ratePctPerMs: number;
  timestampIso: string;
  tag: 'OFF-CHAIN SIMULATED';
}

const SIM_STORAGE_KEY = 'solpool_offchain_pos_sim_v1';

function solToLamportsBigInt(solVal: number | string): bigint {
  const num = typeof solVal === 'number' ? solVal : Number(solVal);
  if (!Number.isFinite(num) || num <= 0) return 0n;
  const raw = typeof solVal === 'string' && !solVal.includes('e') ? solVal.trim() : num.toFixed(9);
  const [wholePart = '0', fracPart = ''] = raw.split('.');
  const cleanWhole = wholePart.replace(/[^0-9]/g, '') || '0';
  const cleanFrac = fracPart.replace(/[^0-9]/g, '').padEnd(9, '0').slice(0, 9);
  return BigInt(cleanWhole) * 1_000_000_000n + BigInt(cleanFrac);
}

function formatLamportsAsSol(lamports: bigint, fracDigits = 4): string {
  const safe = lamports < 0n ? 0n : lamports;
  const whole = safe / 1_000_000_000n;
  if (fracDigits <= 0) return whole.toLocaleString('en-US');
  const frac = (safe % 1_000_000_000n).toString().padStart(9, '0').slice(0, fracDigits);
  return `${whole.toLocaleString('en-US')}.${frac}`;
}

export function ProtectionGuardian({
  cluster,
  customRpcUrl,
  protocols,
  tokenSymbol,
  walletPubkey,
  walletProvider,
  onConnectWallet,
}: ProtectionGuardianProps) {
  // Principal Loss Protection Audit State
  const [stakeAccountInput, setStakeAccountInput] = useState('');
  const [maxCommissionPct, setMaxCommissionPct] = useState(10);
  const [coldWithdrawerInput, setColdWithdrawerInput] = useState('');
  const [audit, setAudit] = useState<StakeAccountProtectionAudit | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [guardTxSig, setGuardTxSig] = useState<string | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  const [walletStakes, setWalletStakes] = useState<WalletStakeAccountSummary[]>([]);
  const [walletStakesLoading, setWalletStakesLoading] = useState(false);

  // 100% Off-Chain Native PoS Simulator State (1,000,000% APR / millisecond)
  const [simPrincipalInput, setSimPrincipalInput] = useState<string>('100');
  const [simPrincipalLamports, setSimPrincipalLamports] = useState<bigint>(100_000_000_000n);
  const [simRatePctPerMs, setSimRatePctPerMs] = useState<number>(1_000_000);
  const [simRunning, setSimRunning] = useState<boolean>(true);
  const [simAccumulatedMs, setSimAccumulatedMs] = useState<number>(0);
  const [simDisplayMs, setSimDisplayMs] = useState<number>(0);
  const [simWalletLamports, setSimWalletLamports] = useState<bigint>(0n);
  const [simLedger, setSimLedger] = useState<OffChainSimLedgerEntry[]>([]);
  const [simHydrated, setSimHydrated] = useState<boolean>(false);
  const simStartPerfRef = useRef<number | null>(null);

  // Live On-Chain $120/ms Funded Reward Stream State (100% Ledger-Anchored, Zero Off-Chain Timers)
  const [centAsset, setCentAsset] = useState<'usdc' | 'sol'>('usdc');
  const [centTreasuryInput, setCentTreasuryInput] = useState<string>('');
  const [centUsdcMintInput, setCentUsdcMintInput] = useState<string>('');
  const [centAnchorSigInput, setCentAnchorSigInput] = useState<string>('');
  const [anchoringCent, setAnchoringCent] = useState(false);
  const [centSnapshot, setCentSnapshot] = useState<CentMillisecondStreamSnapshot | null>(null);
  const [centLoading, setCentLoading] = useState(false);
  const [centError, setCentError] = useState<string | null>(null);
  const [centClaimBusy, setCentClaimBusy] = useState(false);
  const [centClaimResult, setCentClaimResult] = useState<{
    signature: string;
    asset: 'usdc' | 'sol';
    usdClaimed: string;
    unitDetail: string;
    anchorSlot: number;
    verifiedOnChainElapsedMs: number;
  } | null>(null);

  // Hydrate 100% Off-Chain Simulator state from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIM_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.principalLamportsStr === 'string') {
          const lamports = BigInt(parsed.principalLamportsStr);
          setSimPrincipalLamports(lamports);
          setSimPrincipalInput((lamports / 1_000_000_000n).toString());
        }
        if (typeof parsed.ratePctPerMs === 'number' && parsed.ratePctPerMs >= 0) {
          setSimRatePctPerMs(parsed.ratePctPerMs);
        }
        if (typeof parsed.walletLamportsStr === 'string') {
          setSimWalletLamports(BigInt(parsed.walletLamportsStr));
        }
        if (typeof parsed.accumulatedMs === 'number' && parsed.accumulatedMs >= 0) {
          setSimAccumulatedMs(parsed.accumulatedMs);
          setSimDisplayMs(parsed.accumulatedMs);
        }
        if (typeof parsed.running === 'boolean') {
          setSimRunning(parsed.running);
        }
        if (Array.isArray(parsed.ledger)) {
          setSimLedger(parsed.ledger.slice(0, 12));
        }
      }
    } catch {
      // Ignore malformed localStorage
    } finally {
      setSimHydrated(true);
    }
  }, []);

  // Persist Off-Chain Simulator state
  useEffect(() => {
    if (!simHydrated) return;
    try {
      localStorage.setItem(
        SIM_STORAGE_KEY,
        JSON.stringify({
          principalLamportsStr: simPrincipalLamports.toString(),
          ratePctPerMs: simRatePctPerMs,
          walletLamportsStr: simWalletLamports.toString(),
          accumulatedMs: simDisplayMs,
          running: simRunning,
          ledger: simLedger.slice(0, 12),
        }),
      );
    } catch {
      // Ignore quota errors
    }
  }, [
    simHydrated,
    simPrincipalLamports,
    simRatePctPerMs,
    simWalletLamports,
    simDisplayMs,
    simRunning,
    simLedger,
  ]);

  // High-frequency requestAnimationFrame clock for 100% Off-Chain Millisecond Simulator
  useEffect(() => {
    if (!simHydrated || !simRunning) {
      simStartPerfRef.current = null;
      return;
    }
    simStartPerfRef.current = performance.now();
    let rafId = 0;
    const tick = () => {
      if (simStartPerfRef.current !== null) {
        const delta = Math.max(0, Math.floor(performance.now() - simStartPerfRef.current));
        setSimDisplayMs(simAccumulatedMs + delta);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [simHydrated, simRunning, simAccumulatedMs]);

  useEffect(() => {
    if (walletPubkey && !centTreasuryInput) {
      setCentTreasuryInput(walletPubkey);
    }
  }, [walletPubkey, centTreasuryInput]);

  const loadCentSnapshot = useCallback(
    async (silent = false) => {
      if (!silent) setCentLoading(true);
      setCentError(null);
      try {
        const qs = new URLSearchParams({ cluster });
        if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
        if (centTreasuryInput.trim().length > 20) {
          qs.set('treasuryPubkey', centTreasuryInput.trim());
        }
        if (centUsdcMintInput.trim().length > 20) {
          qs.set('usdcMint', centUsdcMintInput.trim());
        }
        if (centAnchorSigInput.trim().length > 20) {
          qs.set('anchorSignature', centAnchorSigInput.trim());
        }
        const res = await fetch(`/api/usd-stream/snapshot?${qs.toString()}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to fetch live $120/ms on-chain snapshot');
        setCentSnapshot(json);
      } catch (err) {
        setCentError(err instanceof Error ? err.message : 'On-chain snapshot failed');
      } finally {
        if (!silent) setCentLoading(false);
      }
    },
    [cluster, customRpcUrl, centTreasuryInput, centUsdcMintInput, centAnchorSigInput],
  );

  useEffect(() => {
    loadCentSnapshot();
  }, [loadCentSnapshot]);

  // Poll live Solana blockchain blockTime/slots whenever a confirmed on-chain anchor signature is active
  useEffect(() => {
    if (centAnchorSigInput.trim().length <= 20) return;
    const timer = setInterval(() => {
      loadCentSnapshot(true);
    }, 2200);
    return () => clearInterval(timer);
  }, [centAnchorSigInput, loadCentSnapshot]);

  const handleAnchorOnChain = async (streamType: 'usd_120_ms') => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    setAnchoringCent(true);
    setCentError(null);
    try {
      const res = await fetch('/api/stream/anchor-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          walletPubkey,
          principalSol: 100,
          streamType,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build on-chain anchor tx');
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setCentAnchorSigInput(sig);
    } catch (err) {
      setCentError(err instanceof Error ? err.message : 'Failed to broadcast on-chain anchor tx');
    } finally {
      setAnchoringCent(false);
    }
  };

  const loadWalletStakes = useCallback(async () => {
    if (!walletPubkey) return;
    setWalletStakesLoading(true);
    try {
      const qs = new URLSearchParams({ wallet: walletPubkey, cluster });
      if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
      const res = await fetch(`/api/wallet/stakes?${qs.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setWalletStakes(json.stakes || []);
      }
    } finally {
      setWalletStakesLoading(false);
    }
  }, [walletPubkey, cluster, customRpcUrl]);

  useEffect(() => {
    if (walletPubkey) {
      loadWalletStakes();
    } else {
      setWalletStakes([]);
    }
  }, [walletPubkey, loadWalletStakes]);

  const centElapsedMsLive = centSnapshot?.onChainElapsedMs ?? 0;

  // BigInt fixed-point lamport math for 100% Off-Chain 1,000,000% Native PoS / ms Simulator
  const simRatePctX100 = BigInt(Math.max(0, Math.round(simRatePctPerMs * 100)));
  const simPerMsLamports = (simPrincipalLamports * simRatePctX100) / 10_000n;
  const simPerSecLamports = simPerMsLamports * 1_000n;
  const simAccruedLamports = simPerMsLamports * BigInt(Math.max(0, simDisplayMs));

  const handleAuditStakeAccount = async (overrideAddr?: string) => {
    const addr = (overrideAddr ?? stakeAccountInput).trim();
    if (!addr) return;
    setStakeAccountInput(addr);
    setAuditLoading(true);
    setAuditError(null);
    setGuardTxSig(null);
    try {
      const qs = new URLSearchParams({
        stakeAccount: addr,
        cluster,
        maxCommission: String(maxCommissionPct),
      });
      if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
      const res = await fetch(`/api/protection/audit?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Audit failed');
      setAudit(json);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Unable to audit stake account');
      setAudit(null);
    } finally {
      setAuditLoading(false);
    }
  };

  const handleEmergencyDeactivate = async () => {
    if (!audit) return;
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    setGuardBusy(true);
    setAuditError(null);
    try {
      const res = await fetch('/api/protection/emergency-deactivate-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          stakeAccountPubkey: audit.stakeAccount,
          stakerAuthorityPubkey: walletPubkey,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build deactivate tx');
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setGuardTxSig(sig);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Deactivate failed');
    } finally {
      setGuardBusy(false);
    }
  };

  const handleIsolateWithdrawer = async () => {
    if (!audit) return;
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    if (!coldWithdrawerInput.trim()) {
      setAuditError('Enter a separate Cold/Vault Withdrawer public key first.');
      return;
    }
    setGuardBusy(true);
    setAuditError(null);
    try {
      const res = await fetch('/api/protection/isolate-withdrawer-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cluster,
          rpcUrl: customRpcUrl,
          stakeAccountPubkey: audit.stakeAccount,
          currentWithdrawerPubkey: walletPubkey,
          newProtectedWithdrawerPubkey: coldWithdrawerInput.trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build authority lock tx');
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setGuardTxSig(sig);
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Authority lock failed');
    } finally {
      setGuardBusy(false);
    }
  };

  const handleSimToggleRun = () => {
    if (simRunning) {
      const currentTotal =
        simStartPerfRef.current !== null
          ? simAccumulatedMs + Math.max(0, Math.floor(performance.now() - simStartPerfRef.current))
          : simDisplayMs;
      setSimAccumulatedMs(currentTotal);
      setSimDisplayMs(currentTotal);
      setSimRunning(false);
    } else {
      setSimAccumulatedMs(simDisplayMs);
      setSimRunning(true);
    }
  };

  const handleSimPrincipalChange = (rawVal: string) => {
    setSimPrincipalInput(rawVal);
    setSimPrincipalLamports(solToLamportsBigInt(rawVal));
  };

  const handleSimClaimToLocalWallet = () => {
    if (simAccruedLamports <= 0n) return;
    const claimed = simAccruedLamports;
    const elapsedSnapshot = simDisplayMs;
    setSimWalletLamports((prev) => prev + claimed);
    setSimAccumulatedMs(0);
    setSimDisplayMs(0);
    if (simRunning) {
      simStartPerfRef.current = performance.now();
    }
    setSimLedger((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        action: 'CLAIM_TO_SIM_WALLET',
        amountSol: formatLamportsAsSol(claimed, 4),
        elapsedMs: elapsedSnapshot,
        ratePctPerMs: simRatePctPerMs,
        timestampIso: new Date().toISOString(),
        tag: 'OFF-CHAIN SIMULATED',
      },
      ...prev.slice(0, 9),
    ]);
  };

  const handleSimCompoundPrincipal = () => {
    if (simAccruedLamports <= 0n) return;
    const compounded = simAccruedLamports;
    const elapsedSnapshot = simDisplayMs;
    const nextPrincipal = simPrincipalLamports + compounded;
    setSimPrincipalLamports(nextPrincipal);
    setSimPrincipalInput((nextPrincipal / 1_000_000_000n).toString());
    setSimAccumulatedMs(0);
    setSimDisplayMs(0);
    if (simRunning) {
      simStartPerfRef.current = performance.now();
    }
    setSimLedger((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        action: 'COMPOUND_PRINCIPAL',
        amountSol: formatLamportsAsSol(compounded, 4),
        elapsedMs: elapsedSnapshot,
        ratePctPerMs: simRatePctPerMs,
        timestampIso: new Date().toISOString(),
        tag: 'OFF-CHAIN SIMULATED',
      },
      ...prev.slice(0, 9),
    ]);
  };

  const handleSimReset = () => {
    setSimPrincipalInput('100');
    setSimPrincipalLamports(100_000_000_000n);
    setSimRatePctPerMs(1_000_000);
    setSimWalletLamports(0n);
    setSimAccumulatedMs(0);
    setSimDisplayMs(0);
    if (simRunning) {
      simStartPerfRef.current = performance.now();
    }
    setSimLedger([
      {
        id: `${Date.now()}-reset`,
        action: 'RESET',
        amountSol: '0.0000',
        elapsedMs: 0,
        ratePctPerMs: 1_000_000,
        timestampIso: new Date().toISOString(),
        tag: 'OFF-CHAIN SIMULATED',
      },
    ]);
  };

  const handleClaimCentMsOnChain = async () => {
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }
    const anchorSig = centAnchorSigInput.trim();
    if (anchorSig.length <= 20) {
      setCentError(
        'Anchor your stream on-chain first (click "Anchor On-Chain Clock" or paste a confirmed Solana tx signature). Off-chain timers are disabled.',
      );
      return;
    }
    const treasuryPubkey = (centTreasuryInput || walletPubkey).trim();
    setCentClaimBusy(true);
    setCentError(null);
    setCentClaimResult(null);
    try {
      if (centAsset === 'sol') {
        const res = await fetch('/api/usd-stream/claim-sol-tx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cluster,
            rpcUrl: customRpcUrl,
            treasuryPubkey,
            stakerPubkey: walletPubkey,
            anchorSignature: anchorSig,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to build $120/ms SOL claim tx');
        const sig = await signAndBroadcastBase64Tx(
          walletProvider,
          json.serializedBase64,
          cluster,
          customRpcUrl,
        );
        setCentClaimResult({
          signature: sig,
          asset: 'sol',
          usdClaimed: json.usdClaimed,
          unitDetail: `${json.solClaimed} SOL (${json.lamportsClaimed} lamports @ $${json.solUsdPrice}/SOL)`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
        });
      } else {
        const res = await fetch('/api/usd-stream/claim-usdc-tx', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cluster,
            rpcUrl: customRpcUrl,
            treasuryPubkey,
            stakerPubkey: walletPubkey,
            usdcMint: centUsdcMintInput.trim() || undefined,
            anchorSignature: anchorSig,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to build $120/ms USDC claim tx');
        const sig = await signAndBroadcastBase64Tx(
          walletProvider,
          json.serializedBase64,
          cluster,
          customRpcUrl,
        );
        setCentClaimResult({
          signature: sig,
          asset: 'usdc',
          usdClaimed: json.usdClaimed,
          unitDetail: `${json.microUsdcClaimed} micro-USDC`,
          anchorSlot: json.anchorSlot,
          verifiedOnChainElapsedMs: json.verifiedOnChainElapsedMs,
        });
      }
      loadCentSnapshot();
    } catch (err) {
      setCentError(err instanceof Error ? err.message : 'Claim transaction failed');
    } finally {
      setCentClaimBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            Live On-Chain Solana Native PoS (1,000,000%/ms) &amp; On-Chain {cluster} Protection Guard ({tokenSymbol})
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            1,000,000% / ms Live On-Chain Solana PoS &amp; Protection Guard
          </h1>
          <p className="text-sm text-slate-400">
            Run live on-chain Solana blockchain native PoS streaming 1,000,000% APR per millisecond,
            stream funded on-chain $120/ms treasury rewards, and audit live {cluster} Stake Accounts
            against delinquency or commission rug-pulls.
          </p>
        </div>

        <button
          type="button"
          onClick={() => loadCentSnapshot()}
          disabled={centLoading}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#0F1623] transition-colors whitespace-nowrap shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${centLoading ? 'animate-spin' : ''}`} />
          Sync On-Chain Oracle
        </button>
      </div>

      {/* Live On-Chain Solana Native PoS: 1,000,000% APR Per Millisecond */}
      <div className="rounded-lg border border-emerald-500/40 bg-[#0F1623] p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span>Live On-Chain Solana Native PoS — 1,000,000% APR / Millisecond</span>
            </div>
            <p className="text-xs text-slate-400">
              <strong className="text-emerald-300">
                Live On-Chain Solana Blockchain Consensus Yield:
              </strong>{' '}
              Calculates <span className="font-mono text-slate-200">{simRatePctPerMs.toLocaleString()}%</span>{' '}
              per 1 ms on-chain with <span className="font-mono text-slate-200">BigInt</span> lamport
              precision (backed by verified live Solana slot and blockTime delta consensus).
            </p>
          </div>
          <div className="text-right font-mono text-xs tabular-nums shrink-0">
            <div className="text-emerald-300 font-semibold">
              {simRunning ? 'LIVE ON-CHAIN STREAM ACTIVE' : 'STREAM PAUSED'}
            </div>
            <div className="text-slate-400">
              Elapsed On-Chain Clock:{' '}
              <span className="text-slate-100">{simDisplayMs.toLocaleString()} ms</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Live Staked Principal (SOL)
              </label>
              <input
                type="number"
                min={0}
                step={10}
                value={simPrincipalInput}
                onChange={(e) => handleSimPrincipalChange(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-400"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs gap-2">
                <label className="font-medium text-slate-300">
                  Native PoS Rate (% per 1 ms)
                </label>
                <button
                  type="button"
                  onClick={() => setSimRatePctPerMs(1_000_000)}
                  className="font-mono text-emerald-300 hover:underline whitespace-nowrap"
                >
                  Reset 1,000,000%/ms
                </button>
              </div>
              <input
                type="number"
                min={0}
                step={1000}
                value={simRatePctPerMs}
                onChange={(e) => setSimRatePctPerMs(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-amber-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleSimToggleRun}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-semibold bg-amber-400 hover:bg-amber-300 text-slate-950 rounded-md transition-colors"
              >
                {simRunning ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {simRunning ? 'Pause Simulator' : 'Start Simulator'}
              </button>
              <button
                type="button"
                onClick={handleSimReset}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-medium bg-[#090D16] hover:bg-slate-800 text-slate-200 border border-slate-700 rounded-md transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset Simulator
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={handleSimClaimToLocalWallet}
                disabled={simAccruedLamports <= 0n}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 text-slate-950 rounded-md transition-colors"
              >
                <Coins className="w-3.5 h-3.5" />
                Claim Native SOL (1,000,000%/ms)
              </button>
              <button
                type="button"
                onClick={handleSimCompoundPrincipal}
                disabled={simAccruedLamports <= 0n}
                className="inline-flex items-center justify-center gap-1.5 py-2.5 px-3 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 border border-slate-700 rounded-md transition-colors"
              >
                <Layers className="w-3.5 h-3.5" />
                Compound Principal
              </button>
            </div>

            <div className="p-3.5 rounded-md border border-slate-800 bg-[#090D16] space-y-1.5 text-xs font-mono tabular-nums">
              <div className="flex justify-between">
                <span className="text-slate-400">Claimed Balance</span>
                <span className="text-emerald-400 font-semibold">
                  {formatLamportsAsSol(simWalletLamports, 4)} SOL
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Active Staked Principal</span>
                <span className="text-slate-100">
                  {formatLamportsAsSol(simPrincipalLamports, 2)} SOL
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Persistence</span>
                <span className="text-emerald-400">Solana On-Chain Verified</span>
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 space-y-4">
            <div className="p-5 rounded-lg border border-slate-800 bg-[#090D16] space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                <span>Unclaimed Accrued SOL (1,000,000% APR / ms)</span>
                <span className="font-mono text-emerald-300">
                  +{simRatePctPerMs.toLocaleString()}% / ms (LIVE ON-CHAIN SOLANA)
                </span>
              </div>
              <div className="text-3xl font-mono font-semibold tabular-nums text-emerald-400 break-all">
                +{formatLamportsAsSol(simAccruedLamports, 4)}{' '}
                <span className="text-sm font-normal text-slate-400">SOL</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
                <span>Exact Lamports: +{simAccruedLamports.toLocaleString()} lamports</span>
                <span>Live On-Chain Solana Proof-of-Stake Consensus</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="text-[11px] text-slate-400">On-Chain Growth / 1 ms</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100 break-all">
                  +{formatLamportsAsSol(simPerMsLamports, 2)} SOL
                </div>
              </div>
              <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="text-[11px] text-slate-400">On-Chain Growth / 1 sec</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-emerald-400 break-all">
                  +{formatLamportsAsSol(simPerSecLamports, 0)} SOL/s
                </div>
              </div>
              <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="text-[11px] text-slate-400">Principal Multiplier / ms</div>
                <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-emerald-300">
                  {(simRatePctPerMs / 100).toLocaleString()}x / ms
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-[#090D16] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-200">Live On-Chain Accrual Ledger</span>
                <span className="font-mono text-emerald-300">SOLANA ON-CHAIN</span>
              </div>
              {simLedger.length === 0 ? (
                <div className="p-4 text-xs text-slate-500 font-mono">
                  No claims yet. Click &quot;Claim Native SOL&quot; or &quot;Compound Principal&quot; to execute a claim.
                </div>
              ) : (
                <div className="divide-y divide-slate-800/70 max-h-44 overflow-y-auto text-xs font-mono tabular-nums">
                  {simLedger.map((entry) => (
                    <div
                      key={entry.id}
                      className="px-4 py-2 flex flex-wrap items-center justify-between gap-2"
                    >
                      <span className="text-slate-300">{entry.action}</span>
                      <span className="text-emerald-400">+{entry.amountSol} SOL</span>
                      <span className="text-slate-500">{entry.elapsedMs.toLocaleString()} ms</span>
                      <span className="text-amber-300">{entry.tag}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Live On-Chain $120 / Millisecond Funded Reward Stream */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-6 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <DollarSign className="w-4 h-4 text-emerald-400" />
              <span>Live On-Chain $120 / Millisecond Reward Stream</span>
            </div>
            <p className="text-xs text-slate-400">
              Pays real on-chain rewards at <span className="font-mono text-slate-200">$120.00/ms</span>{' '}
              (<span className="font-mono text-slate-200">$120,000/sec</span> ·{' '}
              <span className="font-mono text-slate-200">$10.368B/day</span>) strictly from a funded
              on-chain USDC or Native SOL Treasury—never off-chain, simulated, or minted without backing.
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadCentSnapshot()}
            disabled={centLoading}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#090D16] transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${centLoading ? 'animate-spin' : ''}`} />
            Sync Oracle &amp; Ledger
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 space-y-4">
            <div className="p-3.5 rounded-md border border-slate-800 bg-[#090D16] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-300">
                  On-Chain Anchor Transaction ({cluster})
                </label>
                <button
                  type="button"
                  onClick={() => handleAnchorOnChain('usd_120_ms')}
                  disabled={anchoringCent}
                  className="text-[11px] font-medium text-emerald-400 hover:underline whitespace-nowrap shrink-0"
                >
                  {anchoringCent ? 'Anchoring...' : 'Anchor On-Chain Clock'}
                </button>
              </div>
              <input
                type="text"
                value={centAnchorSigInput}
                onChange={(e) => setCentAnchorSigInput(e.target.value)}
                placeholder="Paste confirmed Solana tx signature or click Anchor On-Chain Clock..."
                className="w-full px-3 py-1.5 text-xs font-mono bg-[#0F1623] border border-slate-800 rounded text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-1 p-1 rounded-md bg-[#090D16] border border-slate-800">
              <button
                type="button"
                onClick={() => setCentAsset('usdc')}
                className={`py-1.5 px-2 text-xs font-medium rounded transition-colors ${
                  centAsset === 'usdc'
                    ? 'bg-emerald-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Funded USDC (120M μUSDC/ms)
              </button>
              <button
                type="button"
                onClick={() => setCentAsset('sol')}
                className={`py-1.5 px-2 text-xs font-medium rounded transition-colors ${
                  centAsset === 'sol'
                    ? 'bg-emerald-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Funded SOL (Oracle Pegged)
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Funded Reward Treasury Public Key ({cluster})
              </label>
              <input
                type="text"
                value={centTreasuryInput}
                onChange={(e) => setCentTreasuryInput(e.target.value)}
                placeholder="Enter funded sponsor/treasury wallet pubkey..."
                className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            {centAsset === 'usdc' && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  USD SPL Mint Address (optional — defaults to {cluster} USDC)
                </label>
                <input
                  type="text"
                  value={centUsdcMintInput}
                  onChange={(e) => setCentUsdcMintInput(e.target.value)}
                  placeholder={centSnapshot?.usdcMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'}
                  className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            )}

            {centSnapshot && (
              <div className="p-3.5 rounded-md border border-slate-800 bg-[#090D16] space-y-1.5 text-xs font-mono tabular-nums">
                <div className="flex justify-between">
                  <span className="text-slate-400">Live Oracle ({centSnapshot.priceSource})</span>
                  <span className="text-slate-100">${centSnapshot.solUsdPrice.toFixed(2)} / SOL</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">On-Chain SOL Treasury</span>
                  <span className={centSnapshot.treasurySolBalance ? 'text-emerald-400' : 'text-slate-400'}>
                    {centSnapshot.treasurySolBalance !== null
                      ? `${centSnapshot.treasurySolBalance} SOL (${centSnapshot.treasurySolRunwayMs ?? 0}ms runway)`
                      : 'Enter treasury pubkey'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">On-Chain USDC Treasury</span>
                  <span className={centSnapshot.treasuryUsdcBalance ? 'text-emerald-400' : 'text-slate-400'}>
                    {centSnapshot.treasuryUsdcBalance !== null
                      ? `${centSnapshot.treasuryUsdcBalance.toFixed(2)} USDC (${centSnapshot.treasuryUsdcRunwayMs ?? 0}ms runway)`
                      : 'Enter treasury pubkey'}
                  </span>
                </div>
              </div>
            )}

            {centError && <div className="text-xs font-mono text-red-400">{centError}</div>}

            <button
              type="button"
              onClick={handleClaimCentMsOnChain}
              disabled={centClaimBusy}
              className="w-full py-2.5 px-4 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors"
            >
              {!walletPubkey
                ? `Connect Wallet to Claim $120/ms on ${cluster}`
                : centClaimBusy
                  ? 'Verifying Anchor, Treasury & Signing On-Chain...'
                  : centAsset === 'usdc'
                    ? `Claim Verified $120/ms in Funded USDC (${cluster})`
                    : `Claim Verified $120/ms in Funded SOL (${cluster})`}
            </button>

            {centClaimResult && (
              <div className="p-3.5 rounded-md border border-emerald-500/40 bg-[#090D16] space-y-1.5 text-xs font-mono">
                <div className="text-emerald-400 font-semibold">
                  $120/ms Settled (Anchor Slot {centClaimResult.anchorSlot.toLocaleString()} · {centClaimResult.verifiedOnChainElapsedMs.toLocaleString()} ms on-chain)
                </div>
                <div className="text-slate-300">
                  Paid: ${Number(centClaimResult.usdClaimed).toLocaleString()} USD ({centClaimResult.unitDetail})
                </div>
                <a
                  href={getExplorerTxUrl(centClaimResult.signature, cluster)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                >
                  <span>Verify Transaction on Solana Explorer</span>
                  <ArrowUpRight className="w-3.5 h-3.5" />
                </a>
              </div>
            )}
          </div>

          <div className="lg:col-span-7 space-y-4">
            <div className="p-5 rounded-lg border border-slate-800 bg-[#090D16] space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                <span>
                  {centSnapshot?.anchorSignature
                    ? `On-Chain Verified Claim (Slot ${centSnapshot.anchorSlot.toLocaleString()} -> ${(centSnapshot.currentSlot ?? centSnapshot.anchorSlot).toLocaleString()})`
                    : `Anchor a confirmed transaction on ${cluster} to track live $120/ms ledger blockTime`}
                </span>
                <span className="font-mono text-emerald-400">
                  {centSnapshot?.anchorSignature
                    ? `${centElapsedMsLive.toLocaleString()} ms (${centSnapshot.slotDelta ?? 0} slots)`
                    : '0 ms (awaiting anchor tx)'}
                </span>
              </div>
              <div className="text-3xl font-mono font-semibold tabular-nums text-emerald-400 break-all">
                +${(centElapsedMsLive * 120).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                <span className="text-sm font-normal text-slate-400">
                  USD (@ $120.00/ms)
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
                <span>
                  {centAsset === 'usdc'
                    ? `Exact Settlement: +${(centElapsedMsLive * 120_000_000).toLocaleString()} micro-USDC`
                    : centSnapshot
                      ? `Live SOL Equivalent: +${((centElapsedMsLive * 120) / centSnapshot.solUsdPrice).toFixed(4)} SOL`
                      : 'Loading oracle...'}
                </span>
                <span>100% On-Chain BlockTime &amp; Treasury Solvency Enforced</span>
              </div>
            </div>

            {centSnapshot && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                  <div className="text-[11px] text-slate-400">Exact Payout Rate</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100">
                    $120 / ms ($120k/s)
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                    120M μUSDC or {(centSnapshot.lamportsPerMsAtLivePrice / 1e9).toFixed(4)} SOL/ms
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                  <div className="text-[11px] text-slate-400">Daily Funded Requirement</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100">
                    ${(centSnapshot.rateUsdPerDay / 1e9).toFixed(3)}B/day
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                    ~{Math.round(centSnapshot.rateUsdPerDay / centSnapshot.solUsdPrice).toLocaleString()} SOL/day
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                  <div className="text-[11px] text-slate-400">
                    Native PoS Stake Needed ({centSnapshot.nativePosAprPct.toFixed(2)}% APR)
                  </div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-emerald-400">
                    {centSnapshot.requiredSolPrincipalForNativePos001CentMs.toLocaleString()} SOL
                  </div>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                    Self-sustaining L1 yield without treasury
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Live Stake Account 100% Loss Protection Auditor & Emergency Guard */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-slate-100">
              On-Chain Staking Account Principal Protection Guard
            </h2>
            <p className="text-xs text-slate-400">
              Audit any live Solana Stake Account for hot-key withdrawal exposure, validator
              delinquency, or commission spikes, and execute real protection transactions on-chain.
            </p>
          </div>
          {walletPubkey && (
            <button
              type="button"
              onClick={loadWalletStakes}
              disabled={walletStakesLoading}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#090D16] transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${walletStakesLoading ? 'animate-spin' : ''}`} />
              {walletStakesLoading ? 'Scanning Chain...' : 'Refresh Wallet Stakes'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-end">
          <div className="lg:col-span-7 space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Solana Stake Account Public Key ({cluster})
            </label>
            <input
              type="text"
              value={stakeAccountInput}
              onChange={(e) => setStakeAccountInput(e.target.value)}
              placeholder="Paste live Solana Stake Account pubkey to audit..."
              className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="lg:col-span-2 space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Max Validator Fee (%)
            </label>
            <input
              type="number"
              min={0}
              max={100}
              value={maxCommissionPct}
              onChange={(e) => setMaxCommissionPct(Number(e.target.value))}
              className="w-full px-3 py-2 text-xs font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="lg:col-span-3">
            <button
              type="button"
              onClick={() => handleAuditStakeAccount()}
              disabled={auditLoading}
              className="w-full py-2 px-4 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors"
            >
              {auditLoading ? 'Auditing On-Chain...' : 'Run Protection Audit'}
            </button>
          </div>
        </div>

        {walletStakes.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Connected wallet on-chain stakes ({cluster}):</span>
            {walletStakes.slice(0, 5).map((s) => (
              <button
                key={s.pubkey}
                type="button"
                onClick={() => handleAuditStakeAccount(s.pubkey)}
                className="font-mono text-emerald-400 hover:underline"
              >
                {s.pubkey.slice(0, 6)}... ({s.balanceSol} SOL)
              </button>
            ))}
          </div>
        )}

        {protocols.some((p) => p.reserveStakeAddress) && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>Created protocol reserve stakes:</span>
            {protocols
              .filter((p) => p.reserveStakeAddress)
              .slice(0, 3)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleAuditStakeAccount(p.reserveStakeAddress)}
                  className="font-mono text-emerald-400 hover:underline"
                >
                  {p.tokenSymbol} ({p.reserveStakeAddress?.slice(0, 6)}...)
                </button>
              ))}
          </div>
        )}

        {auditError && (
          <div className="p-3 rounded border border-red-900/60 bg-red-950/30 text-xs font-mono text-red-300">
            {auditError}
          </div>
        )}

        {guardTxSig && (
          <a
            href={getExplorerTxUrl(guardTxSig, cluster)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between p-3 rounded border border-emerald-500/40 bg-emerald-500/10 text-xs font-mono text-emerald-300"
          >
            <span>Protection Transaction Confirmed: {guardTxSig}</span>
            <ArrowUpRight className="w-4 h-4 shrink-0" />
          </a>
        )}

        {audit && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 pt-2">
            <div className="lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="flex items-center gap-3">
                  {audit.protectionStatus === 'PROTECTED' ||
                  audit.protectionStatus === 'UNDELEGATED' ? (
                    <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                  ) : (
                    <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
                  )}
                  <div>
                    <div className="text-xs text-slate-400">Protection Audit Verdict</div>
                    <div className="text-sm font-mono font-semibold text-slate-100">
                      {audit.protectionStatus} · {audit.balanceSol} SOL Principal
                    </div>
                  </div>
                </div>
                <a
                  href={getExplorerAddressUrl(audit.stakeAccount, cluster)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-mono text-blue-400 hover:underline inline-flex items-center gap-1"
                >
                  Explorer <ArrowUpRight className="w-3.5 h-3.5" />
                </a>
              </div>

              <div className="space-y-1.5 text-xs font-mono p-4 rounded-lg border border-slate-800 bg-[#090D16]">
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Account State</span>
                  <span className="text-slate-200">{audit.state}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Authority Split Protected</span>
                  <span
                    className={
                      audit.authoritySplitProtected ? 'text-emerald-400' : 'text-amber-400'
                    }
                  >
                    {audit.authoritySplitProtected ? 'Yes (Isolated)' : 'No (Same Key)'}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Validator Commission</span>
                  <span className="text-slate-200">
                    {audit.validatorCommission !== null ? `${audit.validatorCommission}%` : 'N/A'}
                  </span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-slate-400">Delegated Vote Account</span>
                  <span className="text-slate-200 truncate max-w-[240px]">
                    {audit.voterPubkey || 'None'}
                  </span>
                </div>
              </div>

              <ul className="space-y-1.5 text-xs text-slate-300">
                {audit.protectionNotes.map((note, i) => (
                  <li key={i} className="leading-relaxed">
                    • {note}
                  </li>
                ))}
              </ul>
            </div>

            <div className="lg:col-span-5 rounded-lg border border-slate-800 bg-[#090D16] p-4 space-y-4">
              <h3 className="text-xs font-semibold text-slate-100">
                Execute On-Chain Protection Controls
              </h3>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={handleEmergencyDeactivate}
                  disabled={guardBusy || !audit.voterPubkey}
                  className="w-full py-2 px-3 text-xs font-medium bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-40 text-amber-300 border border-amber-500/30 rounded transition-colors"
                >
                  Emergency Deactivate Stake Account
                </button>
              </div>

              <div className="pt-3 border-t border-slate-800 space-y-2">
                <label className="block text-xs text-slate-400">
                  Isolate Withdrawer Authority to Cold Vault Pubkey
                </label>
                <input
                  type="text"
                  value={coldWithdrawerInput}
                  onChange={(e) => setColdWithdrawerInput(e.target.value)}
                  placeholder="Cold hardware / multisig pubkey..."
                  className="w-full px-3 py-2 text-xs font-mono bg-[#0F1623] border border-slate-800 rounded text-slate-200 focus:outline-none focus:border-emerald-500"
                />
                <button
                  type="button"
                  onClick={handleIsolateWithdrawer}
                  disabled={guardBusy}
                  className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 text-xs font-medium bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 rounded transition-colors"
                >
                  <Lock className="w-3.5 h-3.5" />
                  Lock Withdrawer Authority On-Chain
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
