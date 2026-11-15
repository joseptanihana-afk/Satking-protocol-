import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, RefreshCw, Search } from 'lucide-react';
import type {
  LiveStakePoolData,
  NetworkOverview,
  ProtocolConfig,
  SolanaCluster,
  WalletStakeAccountSummary,
} from '../types';
import {
  type SolanaWalletProvider,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
} from '../utils/solanaWallet';

interface PoolRegistryProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  protocols: ProtocolConfig[];
  network: NetworkOverview | null;
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  onConnectWallet: () => void;
  onNavigateBuilder: () => void;
}

export function PoolRegistry({
  cluster,
  customRpcUrl,
  protocols,
  network,
  walletPubkey,
  walletProvider,
  onConnectWallet,
  onNavigateBuilder,
}: PoolRegistryProps) {
  const [inspectAddress, setInspectAddress] = useState('');
  const [inspectedPool, setInspectedPool] = useState<LiveStakePoolData | null>(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [stakeTab, setStakeTab] = useState<'pool-deposit' | 'pool-withdraw' | 'native-delegate'>(
    'pool-deposit',
  );
  const [stakeAmount, setStakeAmount] = useState('1.0');
  const [selectedVotePubkey, setSelectedVotePubkey] = useState(
    network?.validators[0]?.votePubkey || '',
  );
  const [txBusy, setTxBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [lastTxSig, setLastTxSig] = useState<string | null>(null);
  const [walletStakes, setWalletStakes] = useState<WalletStakeAccountSummary[]>([]);
  const [stakesLoading, setStakesLoading] = useState(false);

  const loadWalletStakes = useCallback(async () => {
    if (!walletPubkey) return;
    setStakesLoading(true);
    try {
      const qs = new URLSearchParams({ wallet: walletPubkey, cluster });
      if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
      const res = await fetch(`/api/wallet/stakes?${qs.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setWalletStakes(json.stakes || []);
      }
    } finally {
      setStakesLoading(false);
    }
  }, [walletPubkey, cluster, customRpcUrl]);

  useEffect(() => {
    if (walletPubkey) {
      loadWalletStakes();
    } else {
      setWalletStakes([]);
    }
  }, [walletPubkey, loadWalletStakes]);

  const handleInspect = async (targetAddr?: string) => {
    const addr = (targetAddr ?? inspectAddress).trim();
    if (!addr) return;
    setInspectAddress(addr);
    setInspectLoading(true);
    setInspectError(null);
    try {
      const qs = new URLSearchParams({ address: addr, cluster });
      if (customRpcUrl) qs.set('rpcUrl', customRpcUrl);
      const res = await fetch(`/api/pools/inspect?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to inspect stake pool');
      setInspectedPool(json);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Unable to decode stake pool');
      setInspectedPool(null);
    } finally {
      setInspectLoading(false);
    }
  };

  const handleExecuteStakeAction = async () => {
    setTxError(null);
    setLastTxSig(null);
    if (!walletPubkey || !walletProvider) {
      onConnectWallet();
      return;
    }

    const amount = Number(stakeAmount);
    if (!amount || amount <= 0) {
      setTxError('Enter a valid positive SOL / LST amount.');
      return;
    }

    setTxBusy(true);
    try {
      let endpoint = '/api/stake/pool-deposit-tx';
      let payload: Record<string, unknown> = {
        cluster,
        rpcUrl: customRpcUrl,
        userPubkey: walletPubkey,
      };

      if (stakeTab === 'pool-deposit') {
        if (!inspectedPool) throw new Error('Select or inspect your standalone stake pool first.');
        endpoint = '/api/stake/pool-deposit-tx';
        payload = { ...payload, stakePoolAddress: inspectedPool.address, amountSol: amount };
      } else if (stakeTab === 'pool-withdraw') {
        if (!inspectedPool) throw new Error('Select or inspect your standalone stake pool first.');
        endpoint = '/api/stake/pool-withdraw-tx';
        payload = { ...payload, stakePoolAddress: inspectedPool.address, amountLst: amount };
      } else {
        const vote = selectedVotePubkey || network?.validators[0]?.votePubkey;
        if (!vote) throw new Error('Select a validator vote account.');
        endpoint = '/api/stake/native-tx';
        payload = {
          cluster,
          rpcUrl: customRpcUrl,
          stakerPubkey: walletPubkey,
          validatorVotePubkey: vote,
          amountSol: amount,
        };
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to build staking transaction');

      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        json.serializedBase64,
        cluster,
        customRpcUrl,
      );
      setLastTxSig(sig);
    } catch (err) {
      setTxError(err instanceof Error ? err.message : 'Transaction failed');
    } finally {
      setTxBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            Standalone Pool Registry · {cluster}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            Your Standalone Pools &amp; Live On-Chain Staker
          </h1>
          <p className="text-sm text-slate-400">
            Manage your own newly created standalone Stake Pools, verify live on-chain LST/SOL
            exchange rates, or stake directly via Native Proof-of-Stake.
          </p>
        </div>

        <button
          onClick={onNavigateBuilder}
          className="px-4 py-2 text-xs font-medium bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-md transition-colors whitespace-nowrap shrink-0"
        >
          New Standalone Protocol
        </button>
      </div>

      {/* Created Standalone Protocols List */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
        <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Your Standalone Staking Protocols
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Isolated protocols configured in this workspace — zero third-party pool connections.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={inspectAddress}
                onChange={(e) => setInspectAddress(e.target.value)}
                placeholder="Verify stake pool pubkey on-chain..."
                className="pl-8 pr-3 py-1.5 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500 w-64"
              />
            </div>
            <button
              type="button"
              onClick={() => handleInspect()}
              disabled={inspectLoading}
              className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              {inspectLoading ? 'Reading RPC...' : 'Inspect Pool'}
            </button>
          </div>
        </div>

        {protocols.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-slate-300">
              No standalone protocols created in this workspace yet.
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Use the Protocol Builder to initialize your own independent SPL Stake Pool on Solana
              Mainnet-Beta or Devnet, or paste a deployed pool address above to verify it.
            </p>
            <button
              onClick={onNavigateBuilder}
              className="mt-2 px-4 py-2 text-xs font-medium bg-emerald-400 hover:bg-emerald-300 text-slate-950 rounded-md transition-colors"
            >
              Launch Protocol Builder
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-[#0B101B]">
                  <th className="py-2.5 px-4 font-medium">Protocol / Token</th>
                  <th className="py-2.5 px-4 font-medium">Cluster</th>
                  <th className="py-2.5 px-4 font-medium">Stake Pool Address</th>
                  <th className="py-2.5 px-4 font-medium text-right">Epoch Fee</th>
                  <th className="py-2.5 px-4 font-medium text-right">Status</th>
                  <th className="py-2.5 px-4 font-medium text-right">Inspect</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {protocols.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-100">{p.protocolName}</div>
                      <div className="text-[11px] font-mono text-slate-500">
                        {p.tokenSymbol} · {p.packageName}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-300">{p.cluster}</td>
                    <td className="py-3 px-4 font-mono text-slate-300">
                      {p.stakePoolAddress ? (
                        <a
                          href={getExplorerAddressUrl(p.stakePoolAddress, p.cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-emerald-400 hover:underline"
                        >
                          <span>
                            {p.stakePoolAddress.slice(0, 8)}...{p.stakePoolAddress.slice(-6)}
                          </span>
                          <ArrowUpRight className="w-3 h-3" />
                        </a>
                      ) : (
                        'Pending'
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-right text-slate-300">
                      {(p.epochFeeBps / 100).toFixed(2)}%
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span
                        className={
                          p.status === 'deployed' ? 'text-emerald-400 font-medium' : 'text-amber-400'
                        }
                      >
                        {p.status === 'deployed' ? 'Live On-Chain' : 'Tx Built'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      {p.stakePoolAddress && (
                        <button
                          type="button"
                          onClick={() => handleInspect(p.stakePoolAddress)}
                          className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                        >
                          Load On-Chain
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {inspectError && (
        <div className="p-4 rounded-lg border border-red-900/60 bg-red-950/30 text-xs font-mono text-red-300">
          {inspectError}
        </div>
      )}

      {/* Split Panel: Live On-Chain Pool State + Interactive Staker */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">
            Live On-Chain Pool Account State
          </h3>

          {!inspectedPool ? (
            <div className="py-10 text-center text-xs text-slate-500">
              Select a deployed pool above or enter a Stake Pool address to inspect live on-chain
              reserve lamports, LST supply, exchange rate, and validator balances.
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3 rounded bg-[#090D16] border border-slate-800">
                  <div className="text-[11px] text-slate-400">Pool TVL</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100">
                    {inspectedPool.totalSol.toLocaleString()} SOL
                  </div>
                </div>
                <div className="p-3 rounded bg-[#090D16] border border-slate-800">
                  <div className="text-[11px] text-slate-400">LST Supply</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100">
                    {inspectedPool.poolTokenSupplyUi.toLocaleString()}
                  </div>
                </div>
                <div className="p-3 rounded bg-[#090D16] border border-slate-800">
                  <div className="text-[11px] text-slate-400">1 LST Value</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-emerald-400">
                    {inspectedPool.lstExchangeRate.toFixed(5)} SOL
                  </div>
                </div>
                <div className="p-3 rounded bg-[#090D16] border border-slate-800">
                  <div className="text-[11px] text-slate-400">Epoch Fee</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-100">
                    {inspectedPool.epochFeePct}%
                  </div>
                </div>
              </div>

              <div className="space-y-1.5 text-xs font-mono">
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Pool Mint</span>
                  <span className="text-slate-200">{inspectedPool.poolMint}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Manager</span>
                  <span className="text-slate-200">{inspectedPool.manager}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-slate-800/60">
                  <span className="text-slate-400">Reserve Stake</span>
                  <span className="text-slate-200">{inspectedPool.reserveStake}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Interactive On-Chain Staker */}
        <div className="lg:col-span-5 rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-100">
            Execute On-Chain Stake Transaction
          </h3>

          <div className="grid grid-cols-3 gap-1 p-1 bg-[#090D16] border border-slate-800 rounded-md">
            {(
              [
                { id: 'pool-deposit', label: 'Deposit SOL' },
                { id: 'pool-withdraw', label: 'Withdraw SOL' },
                { id: 'native-delegate', label: 'Native PoS' },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setStakeTab(t.id)}
                className={`py-1.5 px-2 text-xs rounded transition-colors whitespace-nowrap ${
                  stakeTab === t.id
                    ? 'bg-slate-800 text-emerald-400 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {stakeTab === 'native-delegate' && (
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-300">
                Target Validator Vote Account
              </label>
              <select
                value={selectedVotePubkey || network?.validators[0]?.votePubkey || ''}
                onChange={(e) => setSelectedVotePubkey(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
              >
                {(network?.validators || []).slice(0, 20).map((v) => (
                  <option key={v.votePubkey} value={v.votePubkey}>
                    {v.votePubkey.slice(0, 12)}... ({v.commission}% fee ·{' '}
                    {v.estimatedNetApyPct.toFixed(2)}% APY)
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-300">
              {stakeTab === 'pool-withdraw' ? 'LST Amount to Burn' : 'Amount (SOL)'}
            </label>
            <input
              type="number"
              min={0.01}
              step={0.1}
              value={stakeAmount}
              onChange={(e) => setStakeAmount(e.target.value)}
              className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
            />
          </div>

          {txError && <div className="text-xs font-mono text-red-400">{txError}</div>}
          {lastTxSig && (
            <a
              href={getExplorerTxUrl(lastTxSig, cluster)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between p-2.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-xs font-mono text-emerald-300"
            >
              <span>Confirmed: {lastTxSig.slice(0, 18)}...</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </a>
          )}

          <button
            type="button"
            onClick={handleExecuteStakeAction}
            disabled={txBusy}
            className="w-full py-2.5 px-4 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors"
          >
            {!walletPubkey
              ? 'Connect Wallet to Stake'
              : txBusy
                ? 'Signing & Broadcasting...'
                : stakeTab === 'native-delegate'
                  ? `Delegate Native PoS Stake on ${cluster}`
                  : stakeTab === 'pool-deposit'
                    ? `Deposit SOL into Standalone Pool`
                    : `Withdraw SOL from Standalone Pool`}
          </button>
        </div>
      </div>

      {/* Live On-Chain Connected Wallet Stake Accounts */}
      <div className="rounded-lg border border-slate-800 bg-[#0F1623] overflow-hidden">
        <div className="p-5 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Your Live On-Chain Solana Stake Accounts ({cluster})
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Queried directly from the Solana Stake Program RPC — zero off-chain cache.
            </p>
          </div>
          {walletPubkey && (
            <button
              type="button"
              onClick={loadWalletStakes}
              disabled={stakesLoading}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${stakesLoading ? 'animate-spin' : ''}`} />
              {stakesLoading ? 'Querying Chain...' : 'Refresh On-Chain Stakes'}
            </button>
          )}
        </div>

        {!walletPubkey ? (
          <div className="p-8 text-center text-xs text-slate-400">
            Connect your Solana wallet to load live on-chain Stake Accounts for {cluster}.
          </div>
        ) : walletStakes.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-400">
            {stakesLoading
              ? 'Scanning Solana Stake Program accounts...'
              : `No Stake Program accounts found for ${walletPubkey.slice(0, 6)}... on ${cluster}.`}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 bg-[#0B101B]">
                  <th className="py-2.5 px-4 font-medium">Stake Account</th>
                  <th className="py-2.5 px-4 font-medium">State</th>
                  <th className="py-2.5 px-4 font-medium">Delegated Validator</th>
                  <th className="py-2.5 px-4 font-medium text-right">Balance</th>
                  <th className="py-2.5 px-4 font-medium text-right">Authority Split</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 font-mono">
                {walletStakes.map((s) => (
                  <tr key={s.pubkey} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4">
                      <a
                        href={getExplorerAddressUrl(s.pubkey, cluster)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-emerald-400 hover:underline"
                      >
                        <span>
                          {s.pubkey.slice(0, 8)}...{s.pubkey.slice(-6)}
                        </span>
                        <ArrowUpRight className="w-3 h-3" />
                      </a>
                    </td>
                    <td className="py-3 px-4 text-slate-300">{s.state}</td>
                    <td className="py-3 px-4 text-slate-400">
                      {s.voterPubkey ? `${s.voterPubkey.slice(0, 8)}...${s.voterPubkey.slice(-6)}` : 'Undelegated'}
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums text-slate-100">
                      {s.balanceSol.toLocaleString()} SOL
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className={s.authoritySplitProtected ? 'text-emerald-400' : 'text-amber-400'}>
                        {s.authoritySplitProtected ? 'Isolated' : 'Same Key'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
