import { useState } from 'react';
import { ArrowUpRight, Check, Copy, Plus, Rocket, Trash2 } from 'lucide-react';
import type {
  BuildProtocolTxResponse,
  NetworkOverview,
  ProtocolConfig,
  SolanaCluster,
} from '../types';
import {
  type SolanaWalletProvider,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  signAndBroadcastBase64Tx,
} from '../utils/solanaWallet';

export interface DraftProtocolState {
  packageName: string;
  protocolName: string;
  tokenSymbol: string;
  tokenName: string;
  roiMode: 'native_pos_lst' | 'native_direct_stake' | 'hybrid_boosted_pool';
  maxValidators: number;
  epochFeeBps: number;
  solDepositFeeBps: number;
  solWithdrawalFeeBps: number;
  referralFeePct: number;
  protocolBoostAprPct: number;
  initialReserveSol: number;
  selectedValidators: string[];
  managerPubkey: string;
  stakerPubkey: string;
}

interface ProtocolBuilderProps {
  cluster: SolanaCluster;
  customRpcUrl?: string;
  network: NetworkOverview | null;
  walletPubkey: string | null;
  walletProvider: SolanaWalletProvider | null;
  draft: DraftProtocolState;
  onChangeDraft: (next: DraftProtocolState) => void;
  onConnectWallet: () => void;
  onProtocolSaved: (protocol: ProtocolConfig) => void;
  onOpenPackageStudio: () => void;
}

export function ProtocolBuilder({
  cluster,
  customRpcUrl,
  network,
  walletPubkey,
  walletProvider,
  draft,
  onChangeDraft,
  onConnectWallet,
  onProtocolSaved,
  onOpenPackageStudio,
}: ProtocolBuilderProps) {
  const [customValidatorInput, setCustomValidatorInput] = useState('');
  const [payerOverride, setPayerOverride] = useState('');
  const [building, setBuilding] = useState(false);
  const [devnetDeploying, setDevnetDeploying] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [builtResult, setBuiltResult] = useState<BuildProtocolTxResponse | null>(null);
  const [txSignatures, setTxSignatures] = useState<Record<number, string>>({});
  const [signingStep, setSigningStep] = useState<number | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [devnetResult, setDevnetResult] = useState<{
    protocol: ProtocolConfig;
    signatures: string[];
    explorerUrls: string[];
    payerPubkey: string;
  } | null>(null);

  const effectivePayer = walletPubkey || payerOverride.trim();

  const updateField = <K extends keyof DraftProtocolState>(
    key: K,
    value: DraftProtocolState[K],
  ) => {
    onChangeDraft({ ...draft, [key]: value });
  };

  const toggleValidator = (votePubkey: string) => {
    if (draft.selectedValidators.includes(votePubkey)) {
      updateField(
        'selectedValidators',
        draft.selectedValidators.filter((v) => v !== votePubkey),
      );
    } else {
      updateField('selectedValidators', [...draft.selectedValidators, votePubkey]);
    }
  };

  const addCustomValidator = () => {
    const trimmed = customValidatorInput.trim();
    if (!trimmed) return;
    if (!draft.selectedValidators.includes(trimmed)) {
      updateField('selectedValidators', [...draft.selectedValidators, trimmed]);
    }
    setCustomValidatorInput('');
  };

  const handleBuildTransactions = async () => {
    setBuildError(null);
    if (!effectivePayer) {
      setBuildError(
        'Connect your Solana wallet or enter a valid payer public key to build on-chain transactions.',
      );
      return;
    }

    setBuilding(true);
    setTxSignatures({});
    try {
      const res = await fetch('/api/protocols/build-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          cluster,
          rpcUrl: customRpcUrl,
          payerPubkey: effectivePayer,
          managerPubkey: draft.managerPubkey.trim() || effectivePayer,
          stakerPubkey: draft.stakerPubkey.trim() || effectivePayer,
          stakeDepositFeeBps: draft.solDepositFeeBps,
          stakeWithdrawalFeeBps: draft.solWithdrawalFeeBps,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to build transactions');
      }
      setBuiltResult(json);
      onProtocolSaved(json.protocol);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Transaction build failed');
    } finally {
      setBuilding(false);
    }
  };

  const handleSignStep = async (stepIndex: number, serializedBase64: string) => {
    if (!walletProvider) {
      setBuildError('Connect Phantom, Solflare, or Backpack wallet to sign and broadcast on-chain.');
      return;
    }
    setBuildError(null);
    setSigningStep(stepIndex);
    try {
      const sig = await signAndBroadcastBase64Tx(
        walletProvider,
        serializedBase64,
        cluster,
        customRpcUrl,
      );
      const nextSigs = { ...txSignatures, [stepIndex]: sig };
      setTxSignatures(nextSigs);

      if (builtResult && Object.keys(nextSigs).length >= 2) {
        const res = await fetch(`/api/protocols/${builtResult.protocol.id}/deployed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signatures: Object.values(nextSigs) }),
        });
        if (res.ok) {
          const data = await res.json();
          onProtocolSaved(data.protocol);
        }
      }
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Wallet signature or broadcast failed');
    } finally {
      setSigningStep(null);
    }
  };

  const handleDevnetDeploy = async () => {
    setBuildError(null);
    setDevnetDeploying(true);
    setDevnetResult(null);
    try {
      const res = await fetch('/api/protocols/devnet-deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          stakeDepositFeeBps: draft.solDepositFeeBps,
          stakeWithdrawalFeeBps: draft.solWithdrawalFeeBps,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Devnet test deployment failed');
      }
      setDevnetResult(json);
      onProtocolSaved(json.protocol);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Devnet deployment error');
    } finally {
      setDevnetDeploying(false);
    }
  };

  const copyValue = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedKey(label);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 pb-6 border-b border-slate-800">
        <div className="space-y-1.5 max-w-2xl">
          <p className="text-xs font-medium text-emerald-400">
            Standalone SPL Stake Pool · Target: {cluster}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
            Create Your Standalone Staking ROI Protocol
          </h1>
          <p className="text-sm text-slate-400">
            Deploys an isolated, self-owned Solana Stake Pool (
            <span className="font-mono text-slate-300">SPoo1Ku8...NakuHy</span>) with its own LST
            mint, reserve stake account, and validator set. Never connects or routes funds to
            external third-party stake pools.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={onOpenPackageStudio}
            className="px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 rounded-md bg-[#0F1623] transition-colors whitespace-nowrap shrink-0"
          >
            Export Node.js Package
          </button>
        </div>
      </div>

      {buildError && (
        <div className="p-4 rounded-lg border border-red-900/60 bg-red-950/30 text-xs text-red-300 font-mono">
          {buildError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Protocol Configuration Form */}
        <div className="lg:col-span-7 space-y-6">
          <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-5">
            <h2 className="text-sm font-semibold text-slate-100">
              01. Protocol Identity &amp; Yield Architecture
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">Protocol Name</label>
                <input
                  type="text"
                  value={draft.protocolName}
                  onChange={(e) => updateField('protocolName', e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  NPM Package Slug
                </label>
                <input
                  type="text"
                  value={draft.packageName}
                  onChange={(e) => updateField('packageName', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Pool LST Token Symbol
                </label>
                <input
                  type="text"
                  maxLength={10}
                  value={draft.tokenSymbol}
                  onChange={(e) => updateField('tokenSymbol', e.target.value)}
                  className="w-full px-3 py-2 text-sm font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Staking ROI Model
                </label>
                <select
                  value={draft.roiMode}
                  onChange={(e) =>
                    updateField('roiMode', e.target.value as DraftProtocolState['roiMode'])
                  }
                  className="w-full px-3 py-2 text-sm bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="native_pos_lst">Standalone Native PoS Liquid Pool</option>
                  <option value="hybrid_boosted_pool">Standalone Pool + Boost Vault</option>
                  <option value="native_direct_stake">Direct Native PoS Stake Accounts</option>
                </select>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-5">
            <h2 className="text-sm font-semibold text-slate-100">
              02. Fee Schedule &amp; Authority Keys
            </h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Epoch Fee (bps)
                </label>
                <input
                  type="number"
                  min={0}
                  max={2500}
                  value={draft.epochFeeBps}
                  onChange={(e) => updateField('epochFeeBps', Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
                <div className="text-[11px] text-slate-500 font-mono">
                  {(draft.epochFeeBps / 100).toFixed(2)}% of yield
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Deposit Fee (bps)
                </label>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={draft.solDepositFeeBps}
                  onChange={(e) => updateField('solDepositFeeBps', Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
                <div className="text-[11px] text-slate-500 font-mono">
                  {(draft.solDepositFeeBps / 100).toFixed(2)}%
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Withdraw Fee (bps)
                </label>
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={draft.solWithdrawalFeeBps}
                  onChange={(e) => updateField('solWithdrawalFeeBps', Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
                <div className="text-[11px] text-slate-500 font-mono">
                  {(draft.solWithdrawalFeeBps / 100).toFixed(2)}%
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Boost APR (%)
                </label>
                <input
                  type="number"
                  min={0}
                  max={50}
                  step={0.25}
                  value={draft.protocolBoostAprPct}
                  onChange={(e) => updateField('protocolBoostAprPct', Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
                <div className="text-[11px] text-slate-500 font-mono">Protocol vault</div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-800/70">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Max Validator Capacity
                </label>
                <input
                  type="number"
                  min={10}
                  max={500}
                  step={10}
                  value={draft.maxValidators}
                  onChange={(e) => updateField('maxValidators', Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Initial Reserve Deposit (SOL)
                </label>
                <input
                  type="number"
                  min={0}
                  step={0.05}
                  value={draft.initialReserveSol}
                  onChange={(e) => updateField('initialReserveSol', Number(e.target.value))}
                  className="w-full px-3 py-2 text-sm font-mono tabular-nums bg-[#090D16] border border-slate-800 rounded-md text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div className="space-y-3 pt-2 border-t border-slate-800/70">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="font-medium text-slate-300">
                    Payer / Pool Deployer Public Key
                  </label>
                  {!walletPubkey && (
                    <button
                      type="button"
                      onClick={onConnectWallet}
                      className="text-emerald-400 hover:underline"
                    >
                      Connect Browser Wallet
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  value={walletPubkey || payerOverride}
                  disabled={Boolean(walletPubkey)}
                  onChange={(e) => setPayerOverride(e.target.value)}
                  placeholder="Connect Phantom/Solflare or paste Solana public key..."
                  className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 disabled:text-emerald-400 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    Manager Authority (optional)
                  </label>
                  <input
                    type="text"
                    value={draft.managerPubkey}
                    onChange={(e) => updateField('managerPubkey', e.target.value)}
                    placeholder="Defaults to payer pubkey"
                    className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">
                    Staker Authority (optional)
                  </label>
                  <input
                    type="text"
                    value={draft.stakerPubkey}
                    onChange={(e) => updateField('stakerPubkey', e.target.value)}
                    placeholder="Defaults to payer pubkey"
                    className="w-full px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Validator Selection */}
          <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">
                03. Standalone Pool Validator Delegation ({draft.selectedValidators.length} selected)
              </h2>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={customValidatorInput}
                onChange={(e) => setCustomValidatorInput(e.target.value)}
                placeholder="Paste validator vote account pubkey..."
                className="flex-1 px-3 py-2 text-xs font-mono bg-[#090D16] border border-slate-800 rounded-md text-slate-200 focus:outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={addCustomValidator}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Vote Key
              </button>
            </div>

            {draft.selectedValidators.length > 0 && (
              <div className="space-y-1.5">
                {draft.selectedValidators.map((vote) => (
                  <div
                    key={vote}
                    className="flex items-center justify-between px-3 py-2 rounded bg-[#090D16] border border-slate-800 text-xs font-mono"
                  >
                    <span className="text-slate-200 truncate">{vote}</span>
                    <button
                      type="button"
                      onClick={() => toggleValidator(vote)}
                      className="text-slate-500 hover:text-red-400 ml-3 shrink-0"
                      title="Remove validator"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {network && network.validators.length > 0 && (
              <div className="space-y-2 pt-2">
                <div className="text-xs text-slate-400">
                  Quick-add live active {cluster} validators:
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                  {network.validators.slice(0, 12).map((v) => {
                    const checked = draft.selectedValidators.includes(v.votePubkey);
                    return (
                      <button
                        key={v.votePubkey}
                        type="button"
                        onClick={() => toggleValidator(v.votePubkey)}
                        className={`flex items-center justify-between p-2.5 rounded border text-left text-xs transition-colors ${
                          checked
                            ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300'
                            : 'bg-[#090D16] border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="font-mono truncate mr-2">
                          {v.votePubkey.slice(0, 8)}...{v.votePubkey.slice(-6)}
                        </div>
                        <div className="font-mono tabular-nums shrink-0 text-[11px] text-slate-400">
                          {v.commission}% fee · {v.estimatedNetApyPct.toFixed(1)}% APY
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: Build & Sign On-Chain Transactions */}
        <div className="lg:col-span-5 space-y-5">
          <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-slate-100">
              Deploy Standalone On-Chain Protocol
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Builds real Solana transactions targeting{' '}
              <span className="font-mono text-slate-300">SPoo1Ku8...NakuHy</span> on{' '}
              <span className="text-emerald-400 font-medium">{cluster}</span>. Your connected wallet
              signs and retains 100% authority over the new Stake Pool &amp;{' '}
              <span className="font-mono text-slate-200">{draft.tokenSymbol}</span> mint.
            </p>

            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={handleBuildTransactions}
                disabled={building}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 text-slate-950 rounded-md transition-colors"
              >
                <Rocket className="w-4 h-4" />
                {building
                  ? 'Building Solana Transactions...'
                  : `Build Live ${cluster} Deployment Transactions`}
              </button>

              <button
                type="button"
                onClick={handleDevnetDeploy}
                disabled={devnetDeploying}
                className="w-full px-4 py-2 text-xs font-medium text-slate-200 border border-slate-700 hover:border-slate-600 disabled:opacity-50 rounded-md bg-[#090D16] transition-colors"
              >
                {devnetDeploying
                  ? 'Airdropping & Deploying on Devnet...'
                  : 'Test 1-Click Live Deploy on Solana Devnet'}
              </button>
            </div>
          </div>

          {devnetResult && (
            <div className="rounded-lg border border-emerald-500/40 bg-[#0F1623] p-5 space-y-3">
              <div className="text-xs font-semibold text-emerald-400">
                Live Devnet Standalone Stake Pool Deployed
              </div>
              <div className="space-y-1.5 text-xs font-mono">
                <div className="text-slate-400">
                  Stake Pool:{' '}
                  <a
                    href={getExplorerAddressUrl(
                      devnetResult.protocol.stakePoolAddress || '',
                      'devnet',
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-300 hover:underline break-all"
                  >
                    {devnetResult.protocol.stakePoolAddress}
                  </a>
                </div>
                <div className="text-slate-400">
                  LST Mint:{' '}
                  <span className="text-slate-200 break-all">
                    {devnetResult.protocol.poolMintAddress}
                  </span>
                </div>
              </div>
              <div className="space-y-1 pt-2 border-t border-slate-800">
                {devnetResult.explorerUrls.map((url, i) => (
                  <a
                    key={url}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between text-xs font-mono text-blue-400 hover:underline"
                  >
                    <span>Confirmed Tx #{i + 1}</span>
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </a>
                ))}
              </div>
            </div>
          )}

          {builtResult && (
            <div className="rounded-lg border border-slate-800 bg-[#0F1623] p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-semibold text-slate-100">
                    Derived Protocol Accounts
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Est. Rent + Reserve: {builtResult.estimatedRentSol} SOL
                  </p>
                </div>
                <span className="text-xs font-mono text-emerald-400">{cluster}</span>
              </div>

              <div className="space-y-2 text-xs">
                {(
                  [
                    ['Stake Pool Address', builtResult.addresses.stakePool],
                    ['Pool LST Mint', builtResult.addresses.poolMint],
                    ['Validator List', builtResult.addresses.validatorList],
                    ['Reserve Stake', builtResult.addresses.reserveStake],
                    ['Withdraw PDA', builtResult.addresses.withdrawAuthority],
                  ] as const
                ).map(([label, val]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-2 py-1 border-b border-slate-800/60"
                  >
                    <span className="text-slate-400 shrink-0">{label}</span>
                    <button
                      type="button"
                      onClick={() => copyValue(label, val)}
                      className="inline-flex items-center gap-1.5 font-mono text-slate-200 hover:text-emerald-300 truncate"
                      title={val}
                    >
                      <span className="truncate max-w-[190px]">{val}</span>
                      {copiedKey === label ? (
                        <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                      ) : (
                        <Copy className="w-3 h-3 text-slate-500 shrink-0" />
                      )}
                    </button>
                  </div>
                ))}
              </div>

              <div className="space-y-3 pt-2">
                <h4 className="text-xs font-semibold text-slate-200">
                  Execution Queue ({builtResult.transactions.length} Transactions)
                </h4>
                {builtResult.transactions.map((tx) => {
                  const sig = txSignatures[tx.stepIndex];
                  const isSigning = signingStep === tx.stepIndex;
                  return (
                    <div
                      key={tx.stepIndex}
                      className="p-3.5 rounded-md border border-slate-800 bg-[#090D16] space-y-2"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-xs font-medium text-slate-100">
                            {tx.stepIndex}. {tx.title}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
                            {tx.description}
                          </div>
                        </div>
                      </div>

                      {sig ? (
                        <a
                          href={getExplorerTxUrl(sig, cluster)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-xs font-mono text-emerald-400 hover:underline"
                        >
                          <span>Confirmed: {sig.slice(0, 16)}...</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </a>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleSignStep(tx.stepIndex, tx.serializedBase64)}
                          disabled={isSigning || !walletProvider}
                          className="w-full py-1.5 px-3 text-xs font-medium rounded bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-40 text-emerald-300 border border-emerald-500/30 transition-colors"
                        >
                          {!walletProvider
                            ? 'Connect Wallet to Sign & Broadcast'
                            : isSigning
                              ? 'Awaiting Wallet Signature...'
                              : `Sign & Send Step ${tx.stepIndex} to ${cluster}`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
