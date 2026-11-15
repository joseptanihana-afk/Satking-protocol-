import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  StakeAuthorizationLayout,
  StakeProgram,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MAINNET_USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const RATE_USD_PER_MS = 120; // $120.00 USD per millisecond ($120,000/sec)

export async function auditStakeAccountProtection(
  rpcUrl: string,
  stakePubkey: PublicKey,
  maxAllowedCommissionPct = 10,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [parsed, votes, slot] = await Promise.all([
    connection.getParsedAccountInfo(stakePubkey, 'confirmed'),
    connection.getVoteAccounts('confirmed'),
    connection.getSlot('confirmed'),
  ]);

  if (!parsed.value || typeof parsed.value.data !== 'object' || !('parsed' in parsed.value.data)) {
    throw new Error('Account is not a valid Solana Stake Program account');
  }

  const info = (parsed.value.data as { parsed: { info?: any } }).parsed.info || {};
  const authorized = info.meta?.authorized || {};
  const delegation = info.stake?.delegation;
  const voter = delegation?.voter as string | undefined;

  let commission: number | null = null;
  let delinquent = false;
  if (voter) {
    const active = votes.current.find((v) => v.votePubkey === voter);
    const delinq = votes.delinquent.find((v) => v.votePubkey === voter);
    if (active) commission = active.commission;
    else if (delinq) {
      commission = delinq.commission;
      delinquent = true;
    }
  }

  const status = !voter
    ? 'UNDELEGATED'
    : delinquent
      ? 'DELINQUENT_ALERT'
      : commission !== null && commission > maxAllowedCommissionPct
        ? 'COMMISSION_ALERT'
        : 'PROTECTED';

  return {
    stakeAccount: stakePubkey.toBase58(),
    slot,
    balanceSol: parsed.value.lamports / LAMPORTS_PER_SOL,
    stakerAuthority: authorized.staker,
    withdrawerAuthority: authorized.withdrawer,
    authoritySplitProtected: authorized.staker !== authorized.withdrawer,
    voter: voter || 'none',
    commission,
    delinquent,
    status,
  };
}

export async function emergencyDeactivateStake(
  rpcUrl: string,
  stakerAuthority: Keypair,
  stakePubkey: PublicKey,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const tx = new Transaction().add(
    StakeProgram.deactivate({
      stakePubkey,
      authorizedPubkey: stakerAuthority.publicKey,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(`SOLPOOL_PRINCIPAL_GUARD:DEACTIVATE:${stakePubkey.toBase58()}`),
    }),
  );
  return sendAndConfirmTransaction(connection, tx, [stakerAuthority]);
}

export async function isolateWithdrawerAuthority(
  rpcUrl: string,
  currentWithdrawer: Keypair,
  stakePubkey: PublicKey,
  coldWithdrawerPubkey: PublicKey,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const tx = new Transaction().add(
    StakeProgram.authorize({
      stakePubkey,
      authorizedPubkey: currentWithdrawer.publicKey,
      newAuthorizedPubkey: coldWithdrawerPubkey,
      stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer,
    }),
  );
  return sendAndConfirmTransaction(connection, tx, [currentWithdrawer]);
}

function formatScaledUnits(amountScaled: bigint, decimals = 9, displayFracDigits = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = amountScaled / divisor;
  const frac = amountScaled % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, displayFracDigits);
  return `${whole.toLocaleString('en-US')}.${fracStr}`;
}

export async function getLiveBlockchainMillisecondRate(
  rpcUrl: string,
  principalSol: number,
  aprPctOverride?: number,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [slot, inflation, epochInfo, supply, perf] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getInflationRate(),
    connection.getEpochInfo('confirmed'),
    connection.getSupply({ excludeNonCirculatingAccountsList: true }),
    connection.getRecentPerformanceSamples(5).catch(() => []),
  ]);
  const blockTime = (await connection.getBlockTime(slot)) || Math.floor(Date.now() / 1000);

  let avgSlotTimeSec = 0.4;
  const validPerf = perf.filter((p) => p.numSlots > 0 && p.samplePeriodSecs > 0);
  if (validPerf.length > 0) {
    const totalSecs = validPerf.reduce((a, b) => a + b.samplePeriodSecs, 0);
    const totalSlots = validPerf.reduce((a, b) => a + b.numSlots, 0);
    if (totalSlots > 0) avgSlotTimeSec = totalSecs / totalSlots;
  }

  const votes = await connection.getVoteAccounts('confirmed');
  const totalActivatedSol =
    (votes.current.reduce((s, v) => s + v.activatedStake, 0) +
      votes.delinquent.reduce((s, v) => s + v.activatedStake, 0)) /
    LAMPORTS_PER_SOL;
  const totalSupplySol = supply.value.total / LAMPORTS_PER_SOL;
  const stakeRatio = totalSupplySol > 0 ? totalActivatedSol / totalSupplySol : 0.65;
  const nativePosAprPct = Number(((inflation.validator * 100) / Math.max(stakeRatio, 0.01)).toFixed(3));
  const resolvedAprPct =
    aprPctOverride !== undefined && aprPctOverride > 0 ? aprPctOverride : nativePosAprPct;

  const principalLamports = BigInt(Math.round(Math.max(0, principalSol) * 1e9));
  const aprBpsX100 = BigInt(Math.round(resolvedAprPct * 10000));
  const MS_PER_YEAR = 31_557_600_000n;
  const MS_PER_DAY = 86_400_000n;

  const perYearFemto = principalLamports * aprBpsX100;
  const perMsFemto = perYearFemto / MS_PER_YEAR;
  const perSecNano = (perYearFemto * 1000n) / MS_PER_YEAR / 1_000_000n;
  const perDayNano = (perYearFemto * MS_PER_DAY) / MS_PER_YEAR / 1_000_000n;
  const perYearNano = perYearFemto / 1_000_000n;

  return {
    anchorSlot: slot,
    epoch: epochInfo.epoch,
    avgSlotTimeSec: Number(avgSlotTimeSec.toFixed(3)),
    anchorBlockTimeUnix: blockTime,
    principalSol,
    nativePosAprPct,
    aprPct: resolvedAprPct,
    perMillisecondSolExact: formatScaledUnits(perMsFemto, 15, 12),
    perSecondLamports: Number(perSecNano).toLocaleString('en-US'),
    perDaySol: formatScaledUnits(perDayNano, 9, 6),
    perYearSol: formatScaledUnits(perYearNano, 9, 6),
  };
}

export async function claimMillisecondSolFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  stakerPubkey: PublicKey;
  principalSol: number;
  aprPct: number;
  elapsedMs: number;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const [treasuryLamports, slot] = await Promise.all([
    connection.getBalance(params.treasurySigner.publicKey, 'confirmed'),
    connection.getSlot('confirmed'),
  ]);

  const principalLamports = BigInt(Math.max(1, Math.round(params.principalSol * 1e9)));
  const aprBpsX100 = BigInt(Math.max(1, Math.round(params.aprPct * 10000)));
  const elapsedBig = BigInt(Math.max(1, Math.round(params.elapsedMs)));
  const MS_PER_YEAR = 31_557_600_000n;
  const rawLamports = (principalLamports * aprBpsX100 * elapsedBig) / (1_000_000n * MS_PER_YEAR);
  const accruedLamports = Number(rawLamports > 0n ? rawLamports : 1n);

  if (treasuryLamports < accruedLamports + 10_000) {
    throw new Error(
      `SOL Yield Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) lacks ${accruedLamports} lamports + tx fee.`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.treasurySigner.publicKey,
      toPubkey: params.stakerPubkey,
      lamports: accruedLamports,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_NATIVE_SOL_MS_CLAIM:SLOT=${slot}:APR=${params.aprPct}%:ELAPSED_MS=${params.elapsedMs}:LAMPORTS=${accruedLamports}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    lamportsClaimed: accruedLamports,
    solClaimed: (accruedLamports / LAMPORTS_PER_SOL).toFixed(9),
    anchorSlot: slot,
  };
}

export async function settleMillisecondSplYieldOnChain(params: {
  rpcUrl: string;
  signer: Keypair;
  principalSol: number;
  aprPct: number;
  elapsedMs: number;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const slot = await connection.getSlot('confirmed');
  const rewardMint = Keypair.generate();
  const userAta = getAssociatedTokenAddressSync(rewardMint.publicKey, params.signer.publicKey);
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const principalNano = BigInt(Math.max(1, Math.round(params.principalSol * 1e9)));
  const aprBpsX100 = BigInt(Math.max(1, Math.round(params.aprPct * 10000)));
  const elapsedBig = BigInt(Math.max(1, Math.round(params.elapsedMs)));
  const MS_PER_YEAR = 31_557_600_000n;
  const rawUnits = (principalNano * aprBpsX100 * elapsedBig) / (1_000_000n * MS_PER_YEAR);
  const MAX_U64 = 18_446_744_073_709_551_615n;
  const units = rawUnits > MAX_U64 ? MAX_U64 : rawUnits > 0n ? rawUnits : 1n;

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: params.signer.publicKey,
      newAccountPubkey: rewardMint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(rewardMint.publicKey, 9, params.signer.publicKey, null),
    createAssociatedTokenAccountInstruction(
      params.signer.publicKey,
      userAta,
      params.signer.publicKey,
      rewardMint.publicKey,
    ),
    createMintToInstruction(rewardMint.publicKey, userAta, params.signer.publicKey, units),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_MS_STREAM:SLOT=${slot}:APR=${params.aprPct}%:ELAPSED_MS=${params.elapsedMs}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.signer, rewardMint]);
  return {
    signature,
    rewardMint: rewardMint.publicKey.toBase58(),
    mintedUnits: units.toString(),
    anchorSlot: slot,
  };
}

export async function fetchLiveSolUsdPrice(): Promise<{ price: number; source: string }> {
  const providers: Array<{ name: string; fn: () => Promise<number> }> = [
    {
      name: 'Coinbase Spot (SOL-USD)',
      fn: async () => {
        const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { data?: { amount?: string } };
        const p = Number(json.data?.amount);
        if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid price');
        return p;
      },
    },
    {
      name: 'CoinGecko Live Price',
      fn: async () => {
        const res = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { solana?: { usd?: number } };
        const p = Number(json.solana?.usd);
        if (!Number.isFinite(p) || p <= 0) throw new Error('Invalid price');
        return p;
      },
    },
  ];
  for (const provider of providers) {
    try {
      const price = await provider.fn();
      return { price: Number(price.toFixed(4)), source: provider.name };
    } catch {
      // Try next oracle
    }
  }
  throw new Error('Failed to fetch live SOL/USD oracle price.');
}

export async function getCentMsLiveRate(rpcUrl: string) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [slot, oracle] = await Promise.all([
    connection.getSlot('confirmed'),
    fetchLiveSolUsdPrice(),
  ]);
  const lamportsPerMs = Math.round((RATE_USD_PER_MS / oracle.price) * LAMPORTS_PER_SOL);
  return {
    anchorSlot: slot,
    solUsdPrice: oracle.price,
    priceSource: oracle.source,
    rateUsdPerMs: RATE_USD_PER_MS,
    rateUsdPerSec: RATE_USD_PER_MS * 1000,
    rateUsdPerDay: RATE_USD_PER_MS * 86_400_000,
    microUsdcPerMs: 120_000_000,
    lamportsPerMsAtLivePrice: lamportsPerMs,
  };
}

export async function claimCentMsSolFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  stakerPubkey: PublicKey;
  elapsedMs: number;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const [treasuryLamports, slot, oracle] = await Promise.all([
    connection.getBalance(params.treasurySigner.publicKey, 'confirmed'),
    connection.getSlot('confirmed'),
    fetchLiveSolUsdPrice(),
  ]);
  const elapsedMs = Math.max(1, Math.round(params.elapsedMs));
  const usdOwed = elapsedMs * RATE_USD_PER_MS;
  const priceScaled = BigInt(Math.max(1, Math.round(oracle.price * 10000)));
  const accruedLamportsBig =
    (BigInt(elapsedMs) * BigInt(RATE_USD_PER_MS) * BigInt(LAMPORTS_PER_SOL) * 10000n) / priceScaled;

  if (BigInt(treasuryLamports) < accruedLamportsBig + 10_000n) {
    throw new Error(
      `Funded SOL Treasury (${(treasuryLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL) cannot cover $${usdOwed.toFixed(2)} (${(Number(accruedLamportsBig) / LAMPORTS_PER_SOL).toFixed(4)} SOL at $${oracle.price}/SOL).`,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: params.treasurySigner.publicKey,
      toPubkey: params.stakerPubkey,
      lamports: accruedLamportsBig,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_120USD_MS_SOL_CLAIM:SLOT=${slot}:ELAPSED_MS=${elapsedMs}:USD=${usdOwed.toFixed(2)}:LAMPORTS=${accruedLamportsBig.toString()}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    usdClaimed: usdOwed.toFixed(2),
    solUsdPrice: oracle.price,
    lamportsClaimed: accruedLamportsBig.toString(),
    anchorSlot: slot,
  };
}

export async function claimCentMsUsdcFromTreasury(params: {
  rpcUrl: string;
  treasurySigner: Keypair;
  stakerPubkey: PublicKey;
  usdcMint?: PublicKey;
  elapsedMs: number;
}) {
  const connection = new Connection(params.rpcUrl, 'confirmed');
  const mint = params.usdcMint ?? MAINNET_USDC_MINT;
  const elapsedMs = Math.max(1, Math.round(params.elapsedMs));
  const treasuryAta = getAssociatedTokenAddressSync(mint, params.treasurySigner.publicKey);
  const stakerAta = getAssociatedTokenAddressSync(mint, params.stakerPubkey);

  const [bal, slot] = await Promise.all([
    connection.getTokenAccountBalance(treasuryAta, 'confirmed'),
    connection.getSlot('confirmed'),
  ]);
  const decimals = bal.value.decimals;
  const unitsPerMs = BigInt(RATE_USD_PER_MS) * 10n ** BigInt(decimals);
  const owedUnits = BigInt(elapsedMs) * unitsPerMs;
  if (BigInt(bal.value.amount) < owedUnits) {
    throw new Error(`Funded USDC Treasury holds ${bal.value.uiAmountString} USDC, insufficient for claim.`);
  }

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      params.treasurySigner.publicKey,
      stakerAta,
      params.stakerPubkey,
      mint,
      TOKEN_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      treasuryAta,
      mint,
      stakerAta,
      params.treasurySigner.publicKey,
      owedUnits,
      decimals,
      [],
      TOKEN_PROGRAM_ID,
    ),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(
        `SOLPOOL_120USD_MS_USDC_CLAIM:SLOT=${slot}:ELAPSED_MS=${elapsedMs}:UNITS=${owedUnits.toString()}`,
      ),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [params.treasurySigner]);
  return {
    signature,
    usdClaimed: (elapsedMs * RATE_USD_PER_MS).toFixed(2),
    microUsdcClaimed: owedUnits.toString(),
    anchorSlot: slot,
  };
}

export async function anchorOnChainStreamClock(
  rpcUrl: string,
  signer: Keypair,
  principalSol = 100,
) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const slot = await connection.getSlot('confirmed');
  const tx = new Transaction().add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.from(
        `SOLPOOL_ONCHAIN_ANCHOR:WALLET=${signer.publicKey.toBase58()}:PRINCIPAL_SOL=${principalSol}:SLOT=${slot}:RATE_USD_MS=120`,
      ),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, tx, [signer]);
  return { anchorSignature: signature, anchorSlot: slot };
}

export async function getOnChainElapsedSinceTx(rpcUrl: string, anchorSignature: string) {
  const connection = new Connection(rpcUrl, 'confirmed');
  const [tx, currentSlot] = await Promise.all([
    connection.getTransaction(anchorSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }),
    connection.getSlot('confirmed'),
  ]);
  if (!tx) throw new Error(`Anchor transaction ${anchorSignature} not confirmed on chain.`);
  const anchorSlot = tx.slot;
  const anchorBlockTimeSec = tx.blockTime ?? (await connection.getBlockTime(anchorSlot));
  if (!anchorBlockTimeSec) throw new Error(`Missing on-chain blockTime for slot ${anchorSlot}.`);
  const currentBlockTimeSec = await connection.getBlockTime(currentSlot).catch(() => null);
  const slotDelta = Math.max(0, currentSlot - anchorSlot);
  const anchorBlockTimeMs = anchorBlockTimeSec * 1000;
  const currentBlockTimeMs =
    currentBlockTimeSec !== null ? currentBlockTimeSec * 1000 : anchorBlockTimeMs + slotDelta * 400;
  const rawDiff = Math.max(0, currentBlockTimeMs - anchorBlockTimeMs);
  return {
    anchorSignature,
    anchorSlot,
    currentSlot,
    slotDelta,
    onChainElapsedMs: rawDiff > 0 ? rawDiff : slotDelta * 400,
  };
}
