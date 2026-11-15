import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Calculator,
  Layers,
  Menu,
  Package,
  ShieldAlert,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react';
import { MainnetOverview } from './components/MainnetOverview';
import { PackageStudio } from './components/PackageStudio';
import { PoolRegistry } from './components/PoolRegistry';
import { ProtectionGuardian } from './components/ProtectionGuardian';
import { type DraftProtocolState, ProtocolBuilder } from './components/ProtocolBuilder';
import { RoiEngine } from './components/RoiEngine';
import type { NetworkOverview, ProtocolConfig, SolanaCluster } from './types';
import { type SolanaWalletProvider, detectSolanaProvider } from './utils/solanaWallet';

type WorkspaceTab = 'overview' | 'roi' | 'builder' | 'protection' | 'registry' | 'package';

const TAB_TITLES: Record<WorkspaceTab, string> = {
  overview: 'Mainnet Overview',
  roi: 'ROI & APR Engine',
  builder: 'Protocol Builder',
  protection: 'Principal Guard & Stream',
  registry: 'Standalone Pool Registry',
  package: 'Node.js & Anchor Package',
};

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('overview');
  const [cluster, setCluster] = useState<SolanaCluster>('mainnet-beta');
  const [customRpcUrl, setCustomRpcUrl] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [network, setNetwork] = useState<NetworkOverview | null>(null);
  const [networkLoading, setNetworkLoading] = useState(true);
  const [networkError, setNetworkError] = useState<string | null>(null);

  const [protocols, setProtocols] = useState<ProtocolConfig[]>([]);

  const [walletPubkey, setWalletPubkey] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string>('');
  const [walletProvider, setWalletProvider] = useState<SolanaWalletProvider | null>(null);
  const [walletNotice, setWalletNotice] = useState<string | null>(null);

  const [draft, setDraft] = useState<DraftProtocolState>({
    packageName: 'solpool-staking-roi-protocol',
    protocolName: 'SolPool Sovereign Staking',
    tokenSymbol: 'spSOL',
    tokenName: 'SolPool Sovereign SOL',
    roiMode: 'native_pos_lst',
    maxValidators: 100,
    epochFeeBps: 250,
    solDepositFeeBps: 0,
    solWithdrawalFeeBps: 10,
    referralFeePct: 0,
    protocolBoostAprPct: 1.25,
    initialReserveSol: 0.05,
    selectedValidators: [],
    managerPubkey: '',
    stakerPubkey: '',
  });

  const loadNetwork = useCallback(async () => {
    setNetworkLoading(true);
    setNetworkError(null);
    try {
      const qs = new URLSearchParams({ cluster });
      if (cluster === 'custom' && customRpcUrl.trim()) {
        qs.set('rpcUrl', customRpcUrl.trim());
      }
      const res = await fetch(`/api/network/overview?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load Solana network');
      setNetwork(json);
    } catch (err) {
      setNetworkError(err instanceof Error ? err.message : 'RPC connection failed');
    } finally {
      setNetworkLoading(false);
    }
  }, [cluster, customRpcUrl]);

  const loadProtocols = useCallback(async () => {
    try {
      const res = await fetch('/api/protocols');
      if (res.ok) {
        const json = await res.json();
        setProtocols(json.protocols || []);
      }
    } catch {
      // Ignore initial empty load errors
    }
  }, []);

  useEffect(() => {
    loadNetwork();
  }, [loadNetwork]);

  useEffect(() => {
    loadProtocols();
  }, [loadProtocols]);

  const handleConnectWallet = async () => {
    setWalletNotice(null);
    if (walletPubkey && walletProvider) {
      try {
        await walletProvider.disconnect();
      } catch {
        // Some wallets disallow programmatic disconnect
      }
      setWalletPubkey(null);
      setWalletProvider(null);
      setWalletName('');
      return;
    }

    const { provider, name } = detectSolanaProvider();
    if (!provider) {
      setWalletNotice(
        'No Solana browser wallet detected (Phantom, Solflare, or Backpack). You can paste a public key in Protocol Builder or run the downloaded Node.js CLI locally.',
      );
      return;
    }

    try {
      const resp = await provider.connect();
      setWalletProvider(provider);
      setWalletPubkey(resp.publicKey.toBase58());
      setWalletName(name);
    } catch (err) {
      setWalletNotice(err instanceof Error ? err.message : 'Wallet connection canceled');
    }
  };

  const handleAddValidator = (votePubkey: string) => {
    setDraft((prev) => {
      const exists = prev.selectedValidators.includes(votePubkey);
      return {
        ...prev,
        selectedValidators: exists
          ? prev.selectedValidators.filter((v) => v !== votePubkey)
          : [...prev.selectedValidators, votePubkey],
      };
    });
  };

  const handleProtocolSaved = (saved: ProtocolConfig) => {
    setProtocols((prev) => {
      const idx = prev.findIndex((p) => p.id === saved.id);
      if (idx >= 0) {
        const copy = [...prev];
        copy[idx] = saved;
        return copy;
      }
      return [saved, ...prev];
    });
  };

  const navItems: Array<{
    id: WorkspaceTab;
    label: string;
    icon: typeof Activity;
  }> = [
    { id: 'overview', label: 'Mainnet Overview', icon: Activity },
    { id: 'roi', label: 'ROI & APR Engine', icon: Calculator },
    { id: 'builder', label: 'Protocol Builder', icon: Layers },
    { id: 'protection', label: 'Protection & Stream', icon: ShieldAlert },
    { id: 'registry', label: 'Pool Registry', icon: ShieldCheck },
    { id: 'package', label: 'Node.js Package', icon: Package },
  ];

  const selectTab = (tab: WorkspaceTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#090D16] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col border-r border-slate-800 bg-[#0B101B] shrink-0">
        <div className="h-16 px-6 flex items-center border-b border-slate-800">
          <span className="text-base font-semibold tracking-tight text-slate-50 whitespace-nowrap">
            SolPool Protocol
          </span>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => selectTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-800/80 text-emerald-400 font-medium'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/40'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Cluster Selector in Sidebar */}
        <div className="p-4 border-t border-slate-800 space-y-3">
          <div className="text-xs font-medium text-slate-400">Solana RPC Network</div>
          <div className="grid grid-cols-3 gap-1 p-1 bg-[#090D16] border border-slate-800 rounded-md">
            {(
              [
                { id: 'mainnet-beta', label: 'Mainnet' },
                { id: 'devnet', label: 'Devnet' },
                { id: 'custom', label: 'Custom' },
              ] as const
            ).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCluster(c.id)}
                className={`py-1.5 text-[11px] rounded transition-colors whitespace-nowrap ${
                  cluster === c.id
                    ? 'bg-slate-800 text-emerald-400 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          {cluster === 'custom' && (
            <div className="space-y-1.5">
              <input
                type="url"
                value={customRpcUrl}
                onChange={(e) => setCustomRpcUrl(e.target.value)}
                placeholder="https://mainnet.helius-rpc.com/..."
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-[#090D16] border border-slate-800 rounded text-slate-200 focus:outline-none focus:border-emerald-500"
              />
              <button
                type="button"
                onClick={loadNetwork}
                className="w-full py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded"
              >
                Connect Endpoint
              </button>
            </div>
          )}

          {network && (
            <div className="pt-2 border-t border-slate-800/70 space-y-1 text-[11px] font-mono tabular-nums text-slate-400">
              <div className="flex justify-between">
                <span>Epoch</span>
                <span className="text-slate-200">{network.epoch}</span>
              </div>
              <div className="flex justify-between">
                <span>Native PoS APR</span>
                <span className="text-emerald-400 font-semibold">{network.baseNetworkAprPct.toLocaleString()}%/ms</span>
              </div>
              <div className="flex justify-between">
                <span>Selected Validators</span>
                <span className="text-slate-200">{draft.selectedValidators.length}</span>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/60"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-full bg-[#0B101B] border-r border-slate-800 flex flex-col h-full z-10">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800">
              <span className="text-base font-semibold text-slate-50">SolPool Protocol</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="text-slate-400 hover:text-slate-100 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectTab(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm rounded-md ${
                      active
                        ? 'bg-slate-800 text-emerald-400 font-medium'
                        : 'text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: 3 clean zones separated by gap-8 */}
        <header className="h-16 px-6 border-b border-slate-800 bg-[#090D16] flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden text-slate-400 hover:text-slate-100 p-1.5"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-400 truncate">
              <span>SolPool Protocol</span>
              <span className="mx-2 text-slate-600">/</span>
              <span className="text-slate-100 font-medium">{TAB_TITLES[activeTab]}</span>
            </div>
          </div>

          <div className="hidden md:flex items-center gap-4 text-xs text-slate-400 whitespace-nowrap shrink-0">
            <span className="font-mono text-slate-300">{cluster}</span>
            <span aria-hidden="true">·</span>
            <span>Standalone SPL Stake Pool</span>
          </div>

          <div className="shrink-0">
            <button
              type="button"
              onClick={handleConnectWallet}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-md bg-emerald-400 hover:bg-emerald-300 text-slate-950 transition-colors whitespace-nowrap shrink-0"
            >
              <Wallet className="w-3.5 h-3.5" />
              {walletPubkey
                ? `${walletName ? `${walletName}: ` : ''}${walletPubkey.slice(0, 4)}...${walletPubkey.slice(-4)}`
                : 'Connect Wallet'}
            </button>
          </div>
        </header>

        {walletNotice && (
          <div className="mx-6 mt-4 p-3 rounded-md border border-amber-800/60 bg-amber-950/30 flex items-center justify-between gap-4 text-xs text-amber-200">
            <span>{walletNotice}</span>
            <button
              type="button"
              onClick={() => setWalletNotice(null)}
              className="text-amber-400 hover:text-amber-200 shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        <main className="flex-1 p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {activeTab === 'overview' && (
            <MainnetOverview
              network={network}
              loading={networkLoading}
              error={networkError}
              cluster={cluster}
              onRefresh={loadNetwork}
              onAddValidatorToBuilder={handleAddValidator}
              selectedValidators={draft.selectedValidators}
              onNavigateTab={selectTab}
            />
          )}

          {activeTab === 'roi' && (
            <RoiEngine
              cluster={cluster}
              customRpcUrl={customRpcUrl}
              network={network}
              defaultEpochFeePct={draft.epochFeeBps / 100}
              defaultBoostAprPct={draft.protocolBoostAprPct}
              onSyncToProtocol={({ epochFeeBps, protocolBoostAprPct }) => {
                setDraft((prev) => ({
                  ...prev,
                  epochFeeBps,
                  protocolBoostAprPct,
                }));
                selectTab('builder');
              }}
            />
          )}

          {activeTab === 'builder' && (
            <ProtocolBuilder
              cluster={cluster}
              customRpcUrl={customRpcUrl}
              network={network}
              walletPubkey={walletPubkey}
              walletProvider={walletProvider}
              draft={draft}
              onChangeDraft={setDraft}
              onConnectWallet={handleConnectWallet}
              onProtocolSaved={handleProtocolSaved}
              onOpenPackageStudio={() => selectTab('package')}
            />
          )}

          {activeTab === 'protection' && (
            <ProtectionGuardian
              cluster={cluster}
              customRpcUrl={customRpcUrl}
              protocols={protocols}
              tokenSymbol={draft.tokenSymbol}
              walletPubkey={walletPubkey}
              walletProvider={walletProvider}
              onConnectWallet={handleConnectWallet}
            />
          )}

          {activeTab === 'registry' && (
            <PoolRegistry
              cluster={cluster}
              customRpcUrl={customRpcUrl}
              protocols={protocols}
              network={network}
              walletPubkey={walletPubkey}
              walletProvider={walletProvider}
              onConnectWallet={handleConnectWallet}
              onNavigateBuilder={() => selectTab('builder')}
            />
          )}

          {activeTab === 'package' && (
            <PackageStudio cluster={cluster} customRpcUrl={customRpcUrl} draft={draft} />
          )}
        </main>
      </div>
    </div>
  );
}
