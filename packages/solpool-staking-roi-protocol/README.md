# solpool-staking-roi-protocol

**SolPool Sovereign Staking (spSOL)** — Standalone Solana Proof-of-Stake ROI Protocol, Node.js SDK & Anchor Program connected to **Solana mainnet-beta**.

> **100% Standalone Pool Architecture:** This package creates your own independent on-chain Solana Stake Pool (`SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy`) with its own `spSOL` SPL mint, reserve stake account, validator list, and withdraw authority PDA. It does **not** connect to or route deposits into any other third-party stake pool.

## Installation

```bash
npm install
npm run build
```

## Quick Start (Mainnet-Beta)

1. Check live Solana Mainnet Proof-of-Stake APR & Epoch Telemetry:

```bash
npm run cli -- status --cluster mainnet-beta
```

2. Simulate Native PoS APR / Compounded APY & Protocol ROI:

```bash
npm run cli -- calc-roi --principal 250 --days 365 --commission 5 --boost 1.25
```

3. Deploy your own standalone on-chain Stake Pool on Mainnet-Beta (or test first on Devnet):

```bash
cp .env.example .env
# Ensure KEYPAIR_PATH points to your funded Solana CLI keypair
npm run cli -- create-pool --cluster mainnet-beta --reserve 0.05
```

4. Inspect your deployed pool on-chain:

```bash
npm run cli -- pool-info <YOUR_STAKE_POOL_ADDRESS> --cluster mainnet-beta
```

## Programmatic Node.js SDK

```ts
import { Keypair, PublicKey } from '@solana/web3.js';
import { SolanaStakingRoiProtocol } from 'solpool-staking-roi-protocol';

const sdk = new SolanaStakingRoiProtocol('https://api.mainnet-beta.solana.com');
const network = await sdk.getNetworkPosMetrics();
console.log('Live Mainnet Base APR:', network.baseNetworkAprPct);
```
