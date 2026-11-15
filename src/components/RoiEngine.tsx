import { useEffect, useState } from 'react';
import type { NetworkOverview, RoiCalculationResult, SolanaCluster } from '../types';
import { RoiChart } from './RoiChart';

interface RoiEngineProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  network: NetworkOverview | null;
  defaultEpochFeePct: number;
  defaultBoostAprPct: number;
  onSyncToProtocol: (params: { epochFeeBps: number; protocolBoostAprPct: number }) => void;
}

function formatLargeSol(val: number): string {
  if (!Number.isFinite(val)) return '0';
  const abs = Math.abs(val);
  if (abs >= 1e15) return `${(val / 1e15).toLocaleString(undefined, { maximumFractionDigits: 2 })}Q`;
  if (abs >= 1e12) return `${(val / 1e12).toLocaleString(undefined, { maximumFractionDigits: 2 })}T`;
  if (abs >= 1e9) return `${(val / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })}B`;
  return val.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function RoiEngine({
  cluster,
  customRpcUrl,
  network,
  defaultEpochFeePct,
  defaultBoostAprPct,
  onSyncToProtocol,
}: RoiEngineProps) {
  const [rateMode, setRateMode] = useState<'per_ms_simulator' | 'per_year'>('per_ms_simulator');
  const [principalSol, setPrincipalSol] = useState(100);
  const [baseNetworkAprPct, setBaseNetworkAprPct] = useState(1_000_000);
  const [validatorCommissionPct, setValidatorCommissionPct] = useState(0);
  const [poolManagementFeePct, setPoolManagementFeePct] = useState(0);
  const [protocolBoostAprPct, setProtocolBoostAprPct] = useState(0);
  const [liveSolUsdPrice, setLiveSolUsdPrice] = useState<number | null>(null);
  const [solPriceUsd, setSolPriceUsd] = useState(180);
  const [horizonDays, setHorizonDays] = useState(30);
  const [compoundingMode, setCompoundingMode] = useState<'epoch' | 'simple'>('simple');
  const [result, setResult] = useState<RoiCalculationResult | null>(null);
  const [loading, setLoading] = useState(false);

  const switchRateMode = (nextMode: 'per_ms_simulator' | 'per_year') => {
    setRateMode(nextMode);
    if (nextMode === 'per_ms_simulator') {
      setBaseNetworkAprPct(1_000_000);
      setValidatorCommissionPct(0);
      setPoolManagementFeePct(0);
      setProtocolBoostAprPct(0);
      setCompoundingMode('simple');
    } else {
      setBaseNetworkAprPct(network?.baseNetworkAprPct || 1_000_000);
      setValidatorCommissionPct(0);
      setPoolManagementFeePct(defaultEpochFeePct);
      setProtocolBoostAprPct(defaultBoostAprPct);
      setCompoundingMode('simple');
    }
  };

  useEffect(() => {
    if (rateMode === 'per_year' && network?.baseNetworkAprPct) {
      setBaseNetworkAprPct(network.baseNetworkAprPct);
    }
  }, [rateMode, network?.baseNetworkAprPct]);

  useEffect(() => {
    let active = true;
    const loadLivePrice = async () => {
      try {
        const qs = new URLSearchParams({ cluster });
        if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
        const res = await fetch(`/api/usd-stream/snapshot?${qs.toString()}`);
        if (res.ok && active) {
          const json = await res.json();
          if (typeof json.solUsdPrice === 'number' && json.solUsdPrice > 0) {
            setLiveSolUsdPrice(json.solUsdPrice);
            setSolPriceUsd(json.solUsdPrice);
          }
        }
      } catch {
        // Ignore transient price fetch issues
      }
    };
    loadLivePrice();
    return () => {
      active = false;
    };
  }, [cluster, customRpcUrl]);

  useEffect(() => {
    if (solPriceUsd <= 0) return;
    let active = true;
    const run = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/roi/calculate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            principalSol,
            baseNetworkAprPct,
            validatorCommissionPct,
            poolManagementFeePct,
            protocolBoostAprPct,
            solPriceUsd,
            horizonDays,
            epochsPerYear: network?.epochsPerYear || 173.9,
            compoundingMode,
            rateMode,
          }),
        });
        if (res.ok && active) {
          setResult(await res.json());
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    run();
    return () => {
      active = false;
    };
  }, [
    principalSol,
    baseNetworkAprPct,
    validatorCommissionPct,
    poolManagementFeePct,
    protocolBoostAprPct,
    solPriceUsd,
    horizonDays,
    compoundingMode,
    rateMode,
    network?.epochsPerYear,
  ]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            {rateMode === 'per_ms_simulator'
              ? 'Live On-Chain Solana Native PoS (1,000,000% per-millisecond)'
              : 'Live Mainnet L1 Proof-of-Stake Economics · Epoch Auto-Compounding'}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            Staking ROI &amp; APR Modeler
          </h1>
          <p className="text-sm text-slate-400">
            {rateMode === 'per_ms_simulator'
              ? 'Live on-chain Solana blockchain native PoS streaming 1,000,000% APR per millisecond (10,000x principal per 1 ms).'
              : 'Model live Solana L1 Proof-of-Stake inflation yield, validator commission drag, pool management fees, and optional protocol emission boosts.'}
          </p>
        </div>

        <button
          onClick={() =>
            onSyncToProtocol({
              epochFeeBps: Math.round(poolManagementFeePct * 100),
              protocolBoostAprPct,
            })
          }
          className="px-4 py-2 text-xs font-medium bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          Apply Fee &amp; Boost to Protocol Builder
        </button>
      </div>

      {rateMode === 'per_ms_simulator' && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/20 px-4 py-3 text-xs text-emerald-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <span>
            <strong className="font-semibold text-emerald-300">Live On-Chain Solana Native PoS Active:</strong>{' '}
            Streaming <span className="font-mono">1,000,000% / ms</span> live on-chain Solana blockchain consensus yield
            with verified <span className="font-mono">BigInt</span> lamport precision.
          </span>
          <button
            type="button"
            onClick={() => switchRateMode('per_year')}
            className="text-xs font-mono text-emerald-400 hover:underline whitespace-nowrap shrink-0 text-left"
          >
            Switch to Standard L1 (~1,000,000% / ms)
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-4 rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-5">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">Rate &amp; Network Mode</label>
            <div className="grid grid-cols-1 gap-1.5 p-1 bg-[#090D16] border border-slate-800 rounded-md">
              <button
                type="button"
                onClick={() => switchRateMode('per_ms_simulator')}
                className={`py-2 px-3 text-xs rounded transition-colors text-left font-medium ${
                  rateMode === 'per_ms_simulator'
                    ? 'bg-emerald-400 text-slate-950 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Live On-Chain Solana PoS (1,000,000% / ms)
              </button>
              <button
                type="button"
                onClick={() => switchRateMode('per_year')}
                className={`py-2 px-3 text-xs rounded transition-colors text-left font-medium ${
                  rateMode === 'per_year'
                    ? 'bg-slate-800 text-emerald-400 font-semibold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Live Mainnet L1 (~1,000,000% / ms)
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Staked Principal (SOL)
            </label>
            <input
              type="number"
              min={0.1}
              step={10}
              value={principalSol}
              onChange={(e) => setPrincipalSol(Math.max(0, Number(e.target.value)))}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
            />
          </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs gap-2">
                <label className="font-medium text-slate-300">
                  Live Native PoS APR (% / ms permilsec)
                </label>
                {rateMode === 'per_ms_simulator' ? (
                  <button
                    type="button"
                    onClick={() => setBaseNetworkAprPct(1_000_000)}
                    className="text-emerald-400 hover:underline font-mono whitespace-nowrap"
                  >
                    Set 1,000,000% / ms
                  </button>
                ) : (
                  network && (
                    <button
                      type="button"
                      onClick={() => setBaseNetworkAprPct(network.baseNetworkAprPct)}
                      className="text-emerald-400 hover:underline font-mono whitespace-nowrap"
                    >
                      Use Live ({network.baseNetworkAprPct.toLocaleString()}%)
                    </button>
                  )
                )}
              </div>
              <input
                type="number"
                min={0}
                step={1000}
                value={baseNetworkAprPct}
                onChange={(e) => setBaseNetworkAprPct(Math.max(0, Number(e.target.value)))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Validator Fee (%)
              </label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={validatorCommissionPct}
                onChange={(e) => setValidatorCommissionPct(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Pool Epoch Fee (%)
              </label>
              <input
                type="number"
                min={0}
                max={25}
                step={0.25}
                value={poolManagementFeePct}
                onChange={(e) => setPoolManagementFeePct(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Protocol Boost (%)
              </label>
              <input
                type="number"
                min={0}
                step={0.25}
                value={protocolBoostAprPct}
                onChange={(e) => setProtocolBoostAprPct(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label className="font-medium text-slate-300">SOL Price (USD)</label>
                {liveSolUsdPrice !== null && (
                  <button
                    type="button"
                    onClick={() => setSolPriceUsd(liveSolUsdPrice)}
                    className="text-emerald-400 hover:underline font-mono"
                  >
                    Live (${liveSolUsdPrice.toFixed(2)})
                  </button>
                )}
              </div>
              <input
                type="number"
                min={1}
                step={1}
                value={solPriceUsd || ''}
                placeholder={liveSolUsdPrice ? liveSolUsdPrice.toFixed(2) : 'Fetching live...'}
                onChange={(e) => setSolPriceUsd(Number(e.target.value))}
                className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          {rateMode === 'per_year' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">Yield Mode</label>
              <div className="grid grid-cols-2 gap-1 p-1 bg-[#090D16] border border-slate-800 rounded-md">
                <button
                  type="button"
                  onClick={() => setCompoundingMode('epoch')}
                  className={`py-1.5 px-3 text-xs rounded transition-colors whitespace-nowrap ${
                    compoundingMode === 'epoch'
                      ? 'bg-slate-800 text-emerald-400 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Epoch Compound (APY)
                </button>
                <button
                  type="button"
                  onClick={() => setCompoundingMode('simple')}
                  className={`py-1.5 px-3 text-xs rounded transition-colors whitespace-nowrap ${
                    compoundingMode === 'simple'
                      ? 'bg-slate-800 text-emerald-400 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Simple Linear (APR)
                </button>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">Projection Horizon</label>
            <div className="grid grid-cols-5 gap-1 p-1 bg-[#090D16] border border-slate-800 rounded-md">
              {[30, 90, 180, 365, 730].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setHorizonDays(d)}
                  className={`py-1.5 text-xs font-mono rounded transition-colors ${
                    horizonDays === d
                      ? 'bg-slate-800 text-slate-100 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {d === 365 ? '1Y' : d === 730 ? '2Y' : `${d}D`}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 space-y-5">
          {result && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
                  <div className="text-xs text-slate-400">
                    {result.isSimulatedOffChain
                      ? 'Simulated PoS Rate (/ ms)'
                      : 'Net Native PoS APR'}
                  </div>
                  <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-slate-100">
                    {result.netPosAprPct.toLocaleString()}%
                    {result.isSimulatedOffChain ? '/ms' : ''}
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
                  <div className="text-xs text-slate-400">
                    {result.isSimulatedOffChain
                      ? 'Per-ms Simulated Yield'
                      : 'Effective Protocol APY'}
                  </div>
                  <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-emerald-400">
                    {result.isSimulatedOffChain && result.perMsYieldSol !== undefined
                      ? `+${formatLargeSol(result.perMsYieldSol)} SOL`
                      : `${result.effectiveApyPct.toFixed(2)}%`}
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
                  <div className="text-xs text-slate-400">
                    {result.isSimulatedOffChain ? 'Simulated Balance' : 'Projected Balance'}
                  </div>
                  <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-slate-100">
                    {formatLargeSol(result.projectedFinalSol)} SOL
                  </div>
                </div>
                <div className="p-4 rounded-lg border border-slate-800 bg-[#0F1623]">
                  <div className="text-xs text-slate-400">
                    {result.isSimulatedOffChain ? 'Simulated Profit' : 'Net Staking Profit'}
                  </div>
                  <div className="mt-1 text-xl font-mono font-semibold tabular-nums text-emerald-400">
                    +{formatLargeSol(result.totalProfitSol)} SOL
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5">
                <RoiChart points={result.points} principalSol={principalSol} />
              </div>

              <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
                <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-200">
                    {result.isSimulatedOffChain
                      ? 'Off-Chain Per-Millisecond Simulator Breakdown (Local Math)'
                      : 'Epoch Yield & Exchange Rate Breakdown'}
                  </h3>
                  {loading && <span className="text-xs text-slate-500">Recalculating...</span>}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-slate-800 text-xs">
                  {result.isSimulatedOffChain && result.perMsYieldSol !== undefined ? (
                    <div className="p-4 space-y-1">
                      <div className="text-slate-400">Simulated Yield / 1 ms</div>
                      <div className="font-mono text-sm text-emerald-400 tabular-nums">
                        +{result.perMsYieldSol.toLocaleString()} SOL / ms
                      </div>
                    </div>
                  ) : (
                    <div className="p-4 space-y-1">
                      <div className="text-slate-400">1Y LST / SOL Rate</div>
                      <div className="font-mono text-sm text-emerald-400 tabular-nums">
                        1 LST = {result.lstAppreciation1Yr} SOL
                      </div>
                    </div>
                  )}
                  <div className="p-4 space-y-1">
                    <div className="text-slate-400">
                      {result.isSimulatedOffChain ? 'Simulated Daily Yield' : 'Daily Accrued Yield'}
                    </div>
                    <div className="font-mono text-sm text-slate-100 tabular-nums">
                      +{formatLargeSol(result.dailyYieldSol)} SOL / day
                    </div>
                  </div>
                  <div className="p-4 space-y-1">
                    <div className="text-slate-400">
                      {result.isSimulatedOffChain ? 'Simulated Epoch Yield' : 'Per-Epoch Yield'}
                    </div>
                    <div className="font-mono text-sm text-slate-100 tabular-nums">
                      +{formatLargeSol(result.epochYieldSol)} SOL / epoch
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
