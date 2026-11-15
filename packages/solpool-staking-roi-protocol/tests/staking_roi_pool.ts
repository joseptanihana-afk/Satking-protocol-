import assert from 'node:assert/strict';
import { SolanaStakingRoiProtocol, calculateNativePosRoi } from '../src/index.js';

async function runTests() {
  const sdk = new SolanaStakingRoiProtocol('https://api.mainnet-beta.solana.com');
  const net = await sdk.getNetworkPosMetrics();
  assert.ok(net.epoch > 0, 'Mainnet epoch should be positive');
  assert.ok(net.baseNetworkAprPct > 0, 'Mainnet base PoS APR should be positive');

  const roi = calculateNativePosRoi({
    principalSol: 100,
    baseNetworkAprPct: net.baseNetworkAprPct,
    validatorCommissionPct: 5,
    poolManagementFeePct: 2.5,
    protocolBoostAprPct: 1.25,
    horizonDays: 365,
    epochsPerYear: net.epochsPerYear,
  });

  assert.ok(roi.projectedFinalSol > 100, 'Projected final SOL should exceed principal');
  console.log('Mainnet Epoch:', net.epoch, '| Projected 1Y SOL:', roi.projectedFinalSol);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
