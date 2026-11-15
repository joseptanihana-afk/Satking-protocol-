import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import {
  auditStakeAccountProtection,
  buildCentMsSolClaimTx,
  buildCentMsUsdcClaimTx,
  buildEmergencyDeactivateStakeTx,
  buildInitializeStakePoolTransactions,
  buildIsolateWithdrawerAuthorityTx,
  buildNativeSolMillisecondClaimTx,
  buildNativeStakeTransaction,
  buildOnChainStreamAnchorTx,
  buildPoolDepositSolTransaction,
  buildPoolWithdrawSolTransaction,
  buildProtectedYieldStreamMintTx,
  calculateStakingRoi,
  executeDevnetTestDeployment,
  fetchCentMillisecondStreamSnapshot,
  fetchLiveStakePool,
  fetchMillisecondChainYieldSnapshot,
  fetchNetworkOverview,
  fetchWalletStakeAccounts,
  listProtocolConfigs,
  markProtocolDeployed,
} from './server/solanaService.ts';
import {
  buildLegitPackageZip,
  generateLegitNodePackageFiles,
} from './server/packageGenerator.ts';
import type { RoiCalculationInput, SolanaCluster } from './server/types.ts';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.get('/api/network/overview', async (req, res) => {
    try {
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const data = await fetchNetworkOverview(cluster, rpcUrl);
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch Solana network data';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/pools/inspect', async (req, res) => {
    try {
      const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
      if (!address) {
        res.status(400).json({ error: 'Stake pool address is required' });
        return;
      }
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const data = await fetchLiveStakePool(address, cluster, rpcUrl);
      res.json(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to inspect stake pool';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/roi/calculate', (req, res) => {
    try {
      const body = req.body as Partial<RoiCalculationInput>;
      const rateMode = body.rateMode === 'per_ms_simulator' ? 'per_ms_simulator' : 'per_year';
      const defaultApr = rateMode === 'per_ms_simulator' ? 1_000_000 : 5.28;
      const result = calculateStakingRoi({
        principalSol: Number(body.principalSol ?? 100),
        baseNetworkAprPct: Number(body.baseNetworkAprPct ?? defaultApr),
        validatorCommissionPct: Number(body.validatorCommissionPct ?? 5),
        poolManagementFeePct: Number(body.poolManagementFeePct ?? 2.5),
        protocolBoostAprPct: Number(body.protocolBoostAprPct ?? 0),
        solPriceUsd: Number(body.solPriceUsd ?? 180),
        horizonDays: Number(body.horizonDays ?? 365),
        epochsPerYear: Number(body.epochsPerYear ?? 173.9),
        compoundingMode: body.compoundingMode === 'simple' ? 'simple' : 'epoch',
        rateMode,
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid ROI calculation input';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/protocols', async (_req, res) => {
    try {
      const protocols = await listProtocolConfigs();
      res.json({ protocols });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load protocols';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/protocols/build-transactions', async (req, res) => {
    try {
      const body = req.body;
      if (!body?.payerPubkey) {
        res.status(400).json({ error: 'Connected wallet or payer public key is required' });
        return;
      }
      const built = await buildInitializeStakePoolTransactions(body);
      res.json(built);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build Solana transactions';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/protocols/:id/deployed', async (req, res) => {
    try {
      const signatures = Array.isArray(req.body?.signatures) ? req.body.signatures : [];
      const updated = await markProtocolDeployed(req.params.id, signatures);
      if (!updated) {
        res.status(404).json({ error: 'Protocol not found' });
        return;
      }
      res.json({ protocol: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update protocol status';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/protocols/devnet-deploy', async (req, res) => {
    try {
      const result = await executeDevnetTestDeployment(req.body || {});
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Devnet airdrop/deployment failed (Devnet faucet may be rate-limited)';
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/stake/native-tx', async (req, res) => {
    try {
      const result = await buildNativeStakeTransaction(req.body);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build native stake tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stake/pool-deposit-tx', async (req, res) => {
    try {
      const result = await buildPoolDepositSolTransaction(req.body);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build pool deposit tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stake/pool-withdraw-tx', async (req, res) => {
    try {
      const result = await buildPoolWithdrawSolTransaction(req.body);
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build pool withdraw tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/protection/audit', async (req, res) => {
    try {
      const stakeAccountPubkey =
        typeof req.query.stakeAccount === 'string' ? req.query.stakeAccount.trim() : '';
      if (!stakeAccountPubkey) {
        res.status(400).json({ error: 'Stake account public key is required' });
        return;
      }
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const maxAllowedCommissionPct = Number(req.query.maxCommission ?? 10);
      const audit = await auditStakeAccountProtection({
        stakeAccountPubkey,
        cluster,
        rpcUrl,
        maxAllowedCommissionPct,
      });
      res.json(audit);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Stake account audit failed';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/protection/emergency-deactivate-tx', async (req, res) => {
    try {
      const result = await buildEmergencyDeactivateStakeTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build emergency deactivate tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/protection/isolate-withdrawer-tx', async (req, res) => {
    try {
      const result = await buildIsolateWithdrawerAuthorityTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build withdrawer authority lock tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/wallet/stakes', async (req, res) => {
    try {
      const walletPubkey = typeof req.query.wallet === 'string' ? req.query.wallet.trim() : '';
      if (!walletPubkey) {
        res.status(400).json({ error: 'Wallet public key is required' });
        return;
      }
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const stakes = await fetchWalletStakeAccounts({ walletPubkey, cluster, rpcUrl });
      res.json({ stakes });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch on-chain wallet stake accounts';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stream/anchor-tx', async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.walletPubkey) {
        res.status(400).json({ error: 'walletPubkey is required to build an on-chain anchor tx' });
        return;
      }
      const result = await buildOnChainStreamAnchorTx(body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build on-chain anchor transaction';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/stream/chain-snapshot', async (req, res) => {
    try {
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const principalSol = Number(req.query.principalSol ?? 100);
      const aprPct = req.query.aprPct ? Number(req.query.aprPct) : undefined;
      const anchorSignature =
        typeof req.query.anchorSignature === 'string' ? req.query.anchorSignature.trim() : undefined;
      const snapshot = await fetchMillisecondChainYieldSnapshot({
        cluster,
        rpcUrl,
        principalSol,
        aprPct,
        anchorSignature,
      });
      res.json(snapshot);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch blockchain clock snapshot';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stream/settle-tx', async (req, res) => {
    try {
      const result = await buildProtectedYieldStreamMintTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build on-chain yield settlement tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/stream/claim-native-sol-tx', async (req, res) => {
    try {
      const result = await buildNativeSolMillisecondClaimTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build native SOL millisecond claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.get('/api/usd-stream/snapshot', async (req, res) => {
    try {
      const cluster = ((req.query.cluster as string) || 'mainnet-beta') as SolanaCluster;
      const rpcUrl = typeof req.query.rpcUrl === 'string' ? req.query.rpcUrl : undefined;
      const treasuryPubkey =
        typeof req.query.treasuryPubkey === 'string' ? req.query.treasuryPubkey : undefined;
      const usdcMint = typeof req.query.usdcMint === 'string' ? req.query.usdcMint : undefined;
      const anchorSignature =
        typeof req.query.anchorSignature === 'string' ? req.query.anchorSignature.trim() : undefined;
      const snapshot = await fetchCentMillisecondStreamSnapshot({
        cluster,
        rpcUrl,
        treasuryPubkey,
        usdcMint,
        anchorSignature,
      });
      res.json(snapshot);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load $120/ms oracle snapshot';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/usd-stream/claim-sol-tx', async (req, res) => {
    try {
      const result = await buildCentMsSolClaimTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build 0.01 cent/ms SOL claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/usd-stream/claim-usdc-tx', async (req, res) => {
    try {
      const result = await buildCentMsUsdcClaimTx(req.body);
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to build 0.01 cent/ms USDC claim tx';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/package/files', (req, res) => {
    try {
      const files = generateLegitNodePackageFiles(req.body || {});
      res.json({ files });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate package files';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/package/download', async (req, res) => {
    try {
      const { filename, buffer } = await buildLegitPackageZip(req.body || {});
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to package archive';
      res.status(500).json({ error: message });
    }
  });

  if (IS_PROD) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SolPool Protocol Node.js server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
