import { Buffer } from 'buffer';
import { Connection, Transaction } from '@solana/web3.js';
import type { SolanaCluster } from '../types';

if (typeof window !== 'undefined' && !(window as unknown as { Buffer?: typeof Buffer }).Buffer) {
  (window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

export interface SolanaWalletProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toBase58(): string; toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect(): Promise<void>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signAndSendTransaction?(
    tx: Transaction,
    options?: { skipPreflight?: boolean; preflightCommitment?: string },
  ): Promise<{ signature: string }>;
}

export function detectSolanaProvider(): {
  provider: SolanaWalletProvider | null;
  name: string;
} {
  if (typeof window === 'undefined') {
    return { provider: null, name: 'None' };
  }
  const win = window as unknown as {
    phantom?: { solana?: SolanaWalletProvider };
    solflare?: SolanaWalletProvider;
    backpack?: { solana?: SolanaWalletProvider };
    solana?: SolanaWalletProvider;
  };

  if (win.phantom?.solana) {
    return { provider: win.phantom.solana, name: 'Phantom' };
  }
  if (win.solflare) {
    return { provider: win.solflare, name: 'Solflare' };
  }
  if (win.backpack?.solana) {
    return { provider: win.backpack.solana, name: 'Backpack' };
  }
  if (win.solana) {
    return {
      provider: win.solana,
      name: win.solana.isPhantom ? 'Phantom' : win.solana.isSolflare ? 'Solflare' : 'Solana Wallet',
    };
  }
  return { provider: null, name: 'None' };
}

export function getClusterRpcUrl(cluster: SolanaCluster, customRpcUrl?: string): string {
  if (customRpcUrl && customRpcUrl.startsWith('http')) return customRpcUrl;
  if (cluster === 'devnet') return 'https://api.devnet.solana.com';
  if (cluster === 'testnet') return 'https://api.testnet.solana.com';
  return 'https://api.mainnet-beta.solana.com';
}

export async function signAndBroadcastBase64Tx(
  provider: SolanaWalletProvider,
  serializedBase64: string,
  cluster: SolanaCluster,
  customRpcUrl?: string,
): Promise<string> {
  const raw = Buffer.from(serializedBase64, 'base64');
  const tx = Transaction.from(raw);
  const connection = new Connection(getClusterRpcUrl(cluster, customRpcUrl), 'confirmed');

  // Refresh recentBlockhash if needed while keeping existing partial signatures intact only if valid
  if (provider.signAndSendTransaction) {
    const res = await provider.signAndSendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    return res.signature;
  }

  const signedTx = await provider.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(signature, 'confirmed');
  return signature;
}

export function getExplorerTxUrl(signature: string, cluster: SolanaCluster): string {
  const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${signature}${clusterParam}`;
}

export function getExplorerAddressUrl(address: string, cluster: SolanaCluster): string {
  const clusterParam = cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`;
  return `https://explorer.solana.com/address/${address}${clusterParam}`;
}
