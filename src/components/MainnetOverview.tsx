import { useMemo, useState } from 'react';
import { ArrowUpRight, RefreshCw, Search } from 'lucide-react';
import type { NetworkOverview, SolanaCluster, ValidatorSummary } from '../types';
import { getExplorerAddressUrl } from '../utils/solanaWallet';

interface MainnetOverviewProps {
  network: NetworkOverview | null;
  loading: boolean;
  error: string | null;
  cluster: SolanaCluster;
  onRefresh: () => void;
  onAddValidatorToBuilder: (votePubkey: string) => void;
  selectedValidators: string[];
  onNavigateTab: (tab: 'overview' | 'roi' | 'builder' | 'registry' | 'package') => void;
}

export function MainnetOverview({
  network,
  loading,
  error,
  cluster,
  onRefresh,
  onAddValidatorToBuilder,
  selectedValidators,
  onNavigateTab,
}: MainnetOverviewProps) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'stake' | 'apy' | 'commission'>('stake');

  const filteredValidators = useMemo(() => {
    if (!network) return [];
    const q = search.trim().toLowerCase();
    const list = network.validators.filter((v) => {
      if (!q) return true;
      return (
        v.votePubkey.toLowerCase().includes(q) ||
        v.nodePubkey.toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => {
      if (sortBy === 'apy') return b.estimatedNetApyPct - a.estimatedNetApyPct;
      if (sortBy === 'commission') return a.commission - b.commission;
      return b.activatedStakeSol - a.activatedStakeSol;
    });
  }, [network, search, sortBy]);

  if (loading && !network) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 rounded-lg border border-slate-800 bg-[#0F1623] animate-pulse"
            />
          ))}
        </div>
        <div className="h-96 rounded-lg border border-slate-800 bg-[#0F1623] animate-pulse" />
      </div>
    );
  }

  if (error && !network) {
    return (
      <div className="rounded-lg border border-red-900/60 bg-[#0F1623] p-6 space-y-4">
        <h2 className="text-lg font-semibold text-slate-100">
          Unable to reach Solana {cluster} RPC
        </h2>
        <p className="text-sm text-red-400 font-mono">{error}</p>
        <button
          onClick={onRefresh}
          className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors"
        >
          Retry RPC Connection
        </button>
      </div>
    );
  }

  if (!network) return null;

  return (
    <div className="space-y-8">
      {/* Top hero / action summary */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 pb-6 border-b border-slate-800">
        <div className="space-y-2 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            Live Native Proof-of-Stake Telemetry · {network.cluster}
          </p>
          <h1 className="text-2xl lg:text-3xl font-semibold tracking-tight text-slate-50 [text-wrap:balance]">
            Solana Staking Yield &amp; Standalone Pool Infrastructure
          </h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            Real-time epoch inflation, native Proof-of-Stake APR/APY, and active validator vote
            accounts queried directly from{' '}
            <span className="font-mono text-slate-300">{network.rpcEndpoint}</span>. Build and
            deploy an isolated on-chain SPL Stake Pool without connecting to external third-party
            pools.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#0F1623] transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh RPC
          </button>
          <button
            onClick={() => onNavigateTab('builder')}
            className="px-4 py-2 text-xs font-medium text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            Create Standalone Pool
          </button>
        </div>
      </div>

      {/* 4-column KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-lg border border-slate-800 bg-[#0F1623] space-y-2">
          <div className="text-xs text-slate-400">Native PoS Base APR</div>
          <div className="text-2xl font-mono font-semibold tabular-nums text-emerald-400">
            {network.baseNetworkAprPct.toLocaleString()}%{' '}
            <span className="text-sm text-slate-400 font-normal">
              / ms permilsec
            </span>
          </div>
          <div className="text-xs text-slate-500 font-mono tabular-nums">
            Live On-Chain Solana L1 Consensus · 1,000,000% permilsec
          </div>
        </div>

        <div className="p-5 rounded-lg border border-slate-800 bg-[#0F1623] space-y-2">
          <div className="text-xs text-slate-400">Current Epoch Progress</div>
          <div className="text-2xl font-mono font-semibold tabular-nums text-slate-100">
            Epoch {network.epoch}
          </div>
          <div className="space-y-1.5">
            <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-400 transition-all duration-300"
                style={{ width: `${Math.min(100, network.epochProgressPct)}%` }}
              />
            </div>
            <div className="text-xs text-slate-500 font-mono tabular-nums">
              {network.epochProgressPct}% complete · ~{network.estimatedEpochDays}d/epoch (
              {network.avgSlotTimeSec}s/slot)
            </div>
          </div>
        </div>

        <div className="p-5 rounded-lg border border-slate-800 bg-[#0F1623] space-y-2">
          <div className="text-xs text-slate-400">Active PoS Stake Participation</div>
          <div className="text-2xl font-mono font-semibold tabular-nums text-slate-100">
            {(network.totalActivatedStakeSol / 1_000_000).toFixed(2)}M SOL
          </div>
          <div className="text-xs text-slate-500 font-mono tabular-nums">
            {network.stakeParticipationPct.toFixed(1)}% of{' '}
            {(network.totalSupplySol / 1_000_000).toFixed(1)}M total supply
          </div>
        </div>

        <div className="p-5 rounded-lg border border-slate-800 bg-[#0F1623] space-y-2">
          <div className="text-xs text-slate-400">Consensus Validator Set</div>
          <div className="text-2xl font-mono font-semibold tabular-nums text-slate-100">
            {network.activeValidatorCount.toLocaleString()} Active
          </div>
          <div className="text-xs text-slate-500 font-mono tabular-nums">
            {network.delinquentValidatorCount} delinquent · Slot{' '}
            {network.absoluteSlot.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Live Validator Set Table */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
        <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Live Consensus Validators ({network.cluster})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Select validators to delegate your standalone SPL Stake Pool directly on-chain.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter vote or node pubkey..."
                className="pl-8 pr-3 py-1.5 text-xs bg-[#090D16] border border-slate-800 rounded-md text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-emerald-500 w-56"
              />
            </div>

            <div className="flex items-center p-0.5 bg-[#090D16] border border-slate-800 rounded-md">
              {(
                [
                  { id: 'stake', label: 'Stake' },
                  { id: 'apy', label: 'Net APY' },
                  { id: 'commission', label: 'Fee' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setSortBy(opt.id)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors whitespace-nowrap shrink-0 ${
                    sortBy === opt.id
                      ? 'bg-slate-800 text-slate-100 font-medium'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400 bg-[#0B101B]">
                <th className="py-2.5 px-4 font-medium">Vote Account</th>
                <th className="py-2.5 px-4 font-medium text-right">Activated Stake</th>
                <th className="py-2.5 px-4 font-medium text-right">Commission</th>
                <th className="py-2.5 px-4 font-medium text-right">Est. Net APR</th>
                <th className="py-2.5 px-4 font-medium text-right">Est. Net APY</th>
                <th className="py-2.5 px-4 font-medium text-right">Status</th>
                <th className="py-2.5 px-4 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs">
              {filteredValidators.slice(0, 25).map((v: ValidatorSummary) => {
                const isSelected = selectedValidators.includes(v.votePubkey);
                return (
                  <tr key={v.votePubkey} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-2.5 px-4 font-mono text-slate-200">
                      <div className="flex items-center gap-2">
                        <span>
                          {v.votePubkey.slice(0, 8)}...{v.votePubkey.slice(-6)}
                        </span>
                        <a
                          href={getExplorerAddressUrl(v.votePubkey, cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-slate-500 hover:text-slate-300"
                          title="View on Solana Explorer"
                        >
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-200">
                      {Math.round(v.activatedStakeSol).toLocaleString()} SOL
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-300">
                      {v.commission}%
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-300">
                      {v.estimatedNetAprPct.toFixed(2)}%
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-right text-emerald-400 font-medium">
                      {v.estimatedNetApyPct.toFixed(2)}%
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <span
                        className={
                          v.delinquent ? 'text-amber-400 font-medium' : 'text-emerald-400'
                        }
                      >
                        {v.delinquent ? 'Delinquent' : 'Active'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right">
                      <button
                        onClick={() => onAddValidatorToBuilder(v.votePubkey)}
                        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                          isSelected
                            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                        }`}
                      >
                        {isSelected ? 'Selected' : 'Add to Pool'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
