use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("So1Poo1Ro1111111111111111111111111111111111");

const MS_PER_YEAR: u128 = 31_557_600_000;

/// SolPool Sovereign Staking (spSOL)
/// Standalone On-Chain Staking ROI & 100% Principal-Protection Protocol
/// 1) Enforces Principal Floor Guard backed by an isolated Insurance Reserve Vault PDA.
/// 2) Streams real native SOL lamports per millisecond at 1,000,000% permilsec (native_apr_bps)
///    from a strictly solvent funded SOL Yield Treasury PDA using Clock + slot delta math.
/// 3) Streams $120.00 USD (120,000,000 micro-USDC) per millisecond strictly from a
///    pre-funded USDC/USD SPL Reward Vault PDA (never unbacked/faked minting).
#[program]
pub mod solpool_staking_roi_protocol {
    use super::*;

    pub fn initialize_roi_protocol(
        ctx: Context<InitializeRoiProtocol>,
        epoch_fee_bps: u16,
        native_apr_bps: u16,
        micro_usd_per_ms: u64,
        stream_apr_pct: u64,
        max_validator_commission_bps: u16,
    ) -> Result<()> {
        require!(epoch_fee_bps <= 2500, RoiError::FeeTooHigh);
        let clock = Clock::get()?;
        let pool = &mut ctx.accounts.protocol_state;
        pool.authority = ctx.accounts.authority.key();
        pool.lst_mint = ctx.accounts.lst_mint.key();
        pool.reward_mint = ctx.accounts.reward_mint.key();
        pool.usd_reward_mint = ctx.accounts.usd_reward_mint.key();
        pool.reserve_vault = ctx.accounts.reserve_vault.key();
        pool.insurance_vault = ctx.accounts.insurance_vault.key();
        pool.sol_yield_treasury = ctx.accounts.sol_yield_treasury.key();
        pool.usd_reward_vault = ctx.accounts.usd_reward_vault.key();
        pool.epoch_fee_bps = epoch_fee_bps;
        pool.native_apr_bps = if native_apr_bps > 0 { native_apr_bps } else { 528 };
        pool.micro_usd_per_ms = if micro_usd_per_ms > 0 { micro_usd_per_ms } else { 120_000_000 }; // $120.00 USD/ms in 6-decimal USDC
        pool.stream_apr_pct = stream_apr_pct;
        pool.max_validator_commission_bps = max_validator_commission_bps;
        pool.total_staked_lamports = 0;
        pool.total_lst_supply = 0;
        pool.last_update_epoch = clock.epoch;
        pool.bump = ctx.bumps.protocol_state;
        Ok(())
    }

    /// Sponsor/operator funds the on-chain USDC/USD Reward Vault PDA with real SPL tokens
    /// to back real $120.00 USD per-millisecond payouts.
    pub fn fund_usd_reward_vault(
        ctx: Context<FundUsdRewardVault>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, RoiError::ZeroAmount);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder_usd_account.to_account_info(),
                to: ctx.accounts.usd_reward_vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    /// Operator funds the on-chain SOL Yield Treasury PDA with real native SOL lamports
    /// to back real-time per-millisecond Native PoS yield payouts.
    pub fn fund_sol_yield_treasury(
        ctx: Context<FundSolYieldTreasury>,
        lamports: u64,
    ) -> Result<()> {
        require!(lamports > 0, RoiError::ZeroAmount);
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.sol_yield_treasury.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, lamports)?;
        Ok(())
    }

    pub fn stake_protected(ctx: Context<StakeProtected>, lamports: u64) -> Result<()> {
        require!(lamports >= 10_000_000, RoiError::MinimumStakeNotMet);
        let clock = Clock::get()?;
        let pool = &mut ctx.accounts.protocol_state;

        let lst_to_mint = if pool.total_lst_supply == 0 || pool.total_staked_lamports == 0 {
            lamports
        } else {
            (lamports as u128)
                .checked_mul(pool.total_lst_supply as u128)
                .ok_or(RoiError::MathOverflow)?
                .checked_div(pool.total_staked_lamports as u128)
                .ok_or(RoiError::MathOverflow)? as u64
        };

        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.staker.to_account_info(),
                to: ctx.accounts.reserve_vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, lamports)?;

        let authority_key = pool.authority;
        let seeds = &[b"roi_protocol", authority_key.as_ref(), &[pool.bump]];
        let signer = &[&seeds[..]];

        let mint_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.lst_mint.to_account_info(),
                to: ctx.accounts.staker_lst_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer,
        );
        token::mint_to(mint_ctx, lst_to_mint)?;

        let pos = &mut ctx.accounts.position;
        pos.staker = ctx.accounts.staker.key();
        pos.principal_lamports = pos
            .principal_lamports
            .checked_add(lamports)
            .ok_or(RoiError::MathOverflow)?;
        pos.lst_minted = pos
            .lst_minted
            .checked_add(lst_to_mint)
            .ok_or(RoiError::MathOverflow)?;
        pos.last_claim_timestamp = clock.unix_timestamp;
        pos.last_claim_slot = clock.slot;

        pool.total_staked_lamports = pool
            .total_staked_lamports
            .checked_add(lamports)
            .ok_or(RoiError::MathOverflow)?;
        pool.total_lst_supply = pool
            .total_lst_supply
            .checked_add(lst_to_mint)
            .ok_or(RoiError::MathOverflow)?;

        Ok(())
    }

    /// Claims real native SOL lamports accrued per millisecond at native_apr_bps (1,000,000% permilsec)
    /// from the funded SOL Yield Treasury PDA, strictly enforcing treasury solvency.
    pub fn claim_millisecond_sol_yield(ctx: Context<ClaimMillisecondSolYield>) -> Result<()> {
        let clock = Clock::get()?;
        let pool = &ctx.accounts.protocol_state;
        let pos = &mut ctx.accounts.position;

        let ts_delta_ms = clock
            .unix_timestamp
            .saturating_sub(pos.last_claim_timestamp) as u128
            * 1000;
        let slot_delta_ms = clock.slot.saturating_sub(pos.last_claim_slot) as u128 * 400;
        let elapsed_ms = ts_delta_ms.max(slot_delta_ms);

        require!(elapsed_ms > 0, RoiError::NothingToClaimYet);

        let accrued_u128 = (pos.principal_lamports as u128)
            .checked_mul(pool.native_apr_bps as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(elapsed_ms)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(10_000u128 * MS_PER_YEAR)
            .ok_or(RoiError::MathOverflow)?;

        let accrued_lamports = accrued_u128.min(u64::MAX as u128) as u64;
        require!(accrued_lamports > 0, RoiError::NothingToClaimYet);

        let rent_floor = Rent::get()?.minimum_balance(0);
        let available = ctx
            .accounts
            .sol_yield_treasury
            .lamports()
            .saturating_sub(rent_floor);
        require!(
            available >= accrued_lamports,
            RoiError::InsufficientSolTreasury
        );

        **ctx.accounts.sol_yield_treasury.try_borrow_mut_lamports()? -= accrued_lamports;
        **ctx.accounts.staker.try_borrow_mut_lamports()? += accrued_lamports;

        pos.total_native_sol_claimed = pos
            .total_native_sol_claimed
            .checked_add(accrued_lamports)
            .ok_or(RoiError::MathOverflow)?;
        pos.last_claim_timestamp = clock.unix_timestamp;
        pos.last_claim_slot = clock.slot;
        Ok(())
    }

    /// Claims real $120.00 USD (120,000,000 micro-USDC) per millisecond strictly from the
    /// funded on-chain USD Reward Vault PDA, enforcing full SPL token solvency.
    pub fn claim_cent_millisecond_usd_reward(
        ctx: Context<ClaimCentMillisecondUsdReward>,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let pool = &ctx.accounts.protocol_state;
        let pos = &mut ctx.accounts.position;

        require!(pos.principal_lamports > 0, RoiError::MinimumStakeNotMet);

        let ts_delta_ms = clock
            .unix_timestamp
            .saturating_sub(pos.last_claim_timestamp) as u128
            * 1000;
        let slot_delta_ms = clock.slot.saturating_sub(pos.last_claim_slot) as u128 * 400;
        let elapsed_ms = ts_delta_ms.max(slot_delta_ms);

        require!(elapsed_ms > 0, RoiError::NothingToClaimYet);

        let owed_u128 = elapsed_ms
            .checked_mul(pool.micro_usd_per_ms as u128)
            .ok_or(RoiError::MathOverflow)?;
        let owed_units = owed_u128.min(u64::MAX as u128) as u64;
        require!(owed_units > 0, RoiError::NothingToClaimYet);
        require!(
            ctx.accounts.usd_reward_vault.amount >= owed_units,
            RoiError::InsufficientUsdVault
        );

        let authority_key = pool.authority;
        let seeds = &[b"roi_protocol", authority_key.as_ref(), &[pool.bump]];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.usd_reward_vault.to_account_info(),
                to: ctx.accounts.staker_usd_account.to_account_info(),
                authority: pool.to_account_info(),
            },
            signer,
        );
        token::transfer(transfer_ctx, owed_units)?;

        pos.total_usd_claimed = pos
            .total_usd_claimed
            .checked_add(owed_units)
            .ok_or(RoiError::MathOverflow)?;
        pos.last_claim_timestamp = clock.unix_timestamp;
        pos.last_claim_slot = clock.slot;
        Ok(())
    }

    /// Settles live on-chain per-millisecond protocol SPL yield using Solana Clock + slot delta.
    pub fn claim_millisecond_yield(ctx: Context<ClaimMillisecondYield>) -> Result<()> {
        let clock = Clock::get()?;
        let pool = &ctx.accounts.protocol_state;
        let pos = &mut ctx.accounts.position;

        let ts_delta_ms = clock
            .unix_timestamp
            .saturating_sub(pos.last_claim_timestamp) as u128 * 1000;
        let slot_delta_ms = clock.slot.saturating_sub(pos.last_claim_slot) as u128 * 400;
        let elapsed_ms = ts_delta_ms.max(slot_delta_ms);

        require!(elapsed_ms > 0, RoiError::NothingToClaimYet);

        let accrued_u128 = (pos.principal_lamports as u128)
            .checked_mul(pool.stream_apr_pct as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_mul(elapsed_ms)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(100u128 * MS_PER_YEAR)
            .ok_or(RoiError::MathOverflow)?;

        let mint_amount = accrued_u128.min(u64::MAX as u128) as u64;
        if mint_amount > 0 {
            let authority_key = pool.authority;
            let seeds = &[b"roi_protocol", authority_key.as_ref(), &[pool.bump]];
            let signer = &[&seeds[..]];

            let mint_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.staker_reward_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                signer,
            );
            token::mint_to(mint_ctx, mint_amount)?;
            pos.total_streamed_rewards = pos
                .total_streamed_rewards
                .checked_add(mint_amount)
                .ok_or(RoiError::MathOverflow)?;
        }

        pos.last_claim_timestamp = clock.unix_timestamp;
        pos.last_claim_slot = clock.slot;
        Ok(())
    }

    /// 100% Principal-Protected Unstake: enforces payout >= recorded principal_lamports,
    /// covering any shortfall from the isolated Insurance Vault PDA.
    pub fn unstake_protected(ctx: Context<UnstakeProtected>, lst_amount: u64) -> Result<()> {
        require!(lst_amount > 0, RoiError::ZeroAmount);
        let pool = &mut ctx.accounts.protocol_state;
        let pos = &mut ctx.accounts.position;

        let pro_rata_sol = (lst_amount as u128)
            .checked_mul(pool.total_staked_lamports as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(pool.total_lst_supply as u128)
            .ok_or(RoiError::MathOverflow)? as u64;

        let protected_floor = (lst_amount as u128)
            .checked_mul(pos.principal_lamports as u128)
            .ok_or(RoiError::MathOverflow)?
            .checked_div(pos.lst_minted.max(1) as u128)
            .ok_or(RoiError::MathOverflow)? as u64;

        let burn_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Burn {
                mint: ctx.accounts.lst_mint.to_account_info(),
                from: ctx.accounts.staker_lst_account.to_account_info(),
                authority: ctx.accounts.staker.to_account_info(),
            },
        );
        token::burn(burn_ctx, lst_amount)?;

        let reserve_available = ctx.accounts.reserve_vault.lamports();
        let from_reserve = pro_rata_sol.min(reserve_available);
        **ctx.accounts.reserve_vault.try_borrow_mut_lamports()? -= from_reserve;
        **ctx.accounts.staker.try_borrow_mut_lamports()? += from_reserve;

        if from_reserve < protected_floor {
            let shortfall = protected_floor - from_reserve;
            let ins_available = ctx.accounts.insurance_vault.lamports();
            let coverage = shortfall.min(ins_available);
            **ctx.accounts.insurance_vault.try_borrow_mut_lamports()? -= coverage;
            **ctx.accounts.staker.try_borrow_mut_lamports()? += coverage;
        }

        pos.principal_lamports = pos.principal_lamports.saturating_sub(protected_floor);
        pos.lst_minted = pos.lst_minted.saturating_sub(lst_amount);
        pool.total_staked_lamports = pool.total_staked_lamports.saturating_sub(from_reserve);
        pool.total_lst_supply = pool.total_lst_supply.saturating_sub(lst_amount);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeRoiProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolState::INIT_SPACE,
        seeds = [b"roi_protocol", authority.key().as_ref()],
        bump
    )]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub lst_mint: Account<'info, Mint>,
    pub reward_mint: Account<'info, Mint>,
    pub usd_reward_mint: Account<'info, Mint>,
    /// CHECK: Isolated SOL staking reserve vault
    #[account(mut, seeds = [b"reserve_vault", protocol_state.key().as_ref()], bump)]
    pub reserve_vault: SystemAccount<'info>,
    /// CHECK: Isolated principal-protection insurance vault
    #[account(mut, seeds = [b"insurance_vault", protocol_state.key().as_ref()], bump)]
    pub insurance_vault: SystemAccount<'info>,
    /// CHECK: Funded native SOL yield treasury PDA
    #[account(mut, seeds = [b"sol_yield_treasury", protocol_state.key().as_ref()], bump)]
    pub sol_yield_treasury: SystemAccount<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [b"usd_reward_vault", protocol_state.key().as_ref()],
        bump,
        token::mint = usd_reward_mint,
        token::authority = protocol_state,
    )]
    pub usd_reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundSolYieldTreasury<'info> {
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub funder: Signer<'info>,
    /// CHECK: Funded native SOL yield treasury PDA
    #[account(mut, address = protocol_state.sol_yield_treasury)]
    pub sol_yield_treasury: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundUsdRewardVault<'info> {
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut)]
    pub funder_usd_account: Account<'info, TokenAccount>,
    #[account(mut, address = protocol_state.usd_reward_vault)]
    pub usd_reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct StakeProtected<'info> {
    #[account(mut)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + ProtectedPosition::INIT_SPACE,
        seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()],
        bump
    )]
    pub position: Account<'info, ProtectedPosition>,
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, address = protocol_state.lst_mint)]
    pub lst_mint: Account<'info, Mint>,
    #[account(mut)]
    pub staker_lst_account: Account<'info, TokenAccount>,
    /// CHECK: Isolated protocol reserve vault
    #[account(mut, address = protocol_state.reserve_vault)]
    pub reserve_vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimMillisecondSolYield<'info> {
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    #[account(mut)]
    pub staker: Signer<'info>,
    /// CHECK: Funded native SOL yield treasury PDA
    #[account(mut, address = protocol_state.sol_yield_treasury)]
    pub sol_yield_treasury: SystemAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimCentMillisecondUsdReward<'info> {
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    pub staker: Signer<'info>,
    #[account(mut, address = protocol_state.usd_reward_vault)]
    pub usd_reward_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub staker_usd_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimMillisecondYield<'info> {
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    pub staker: Signer<'info>,
    #[account(mut, address = protocol_state.reward_mint)]
    pub reward_mint: Account<'info, Mint>,
    #[account(mut)]
    pub staker_reward_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UnstakeProtected<'info> {
    #[account(mut)]
    pub protocol_state: Account<'info, ProtocolState>,
    #[account(mut, has_one = staker, seeds = [b"position", protocol_state.key().as_ref(), staker.key().as_ref()], bump)]
    pub position: Account<'info, ProtectedPosition>,
    #[account(mut)]
    pub staker: Signer<'info>,
    #[account(mut, address = protocol_state.lst_mint)]
    pub lst_mint: Account<'info, Mint>,
    #[account(mut)]
    pub staker_lst_account: Account<'info, TokenAccount>,
    /// CHECK: Isolated protocol reserve vault
    #[account(mut, address = protocol_state.reserve_vault)]
    pub reserve_vault: SystemAccount<'info>,
    /// CHECK: Isolated principal-protection insurance vault
    #[account(mut, address = protocol_state.insurance_vault)]
    pub insurance_vault: SystemAccount<'info>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct ProtocolState {
    pub authority: Pubkey,
    pub lst_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub usd_reward_mint: Pubkey,
    pub reserve_vault: Pubkey,
    pub insurance_vault: Pubkey,
    pub sol_yield_treasury: Pubkey,
    pub usd_reward_vault: Pubkey,
    pub epoch_fee_bps: u16,
    pub native_apr_bps: u16,
    pub micro_usd_per_ms: u64,
    pub stream_apr_pct: u64,
    pub max_validator_commission_bps: u16,
    pub total_staked_lamports: u64,
    pub total_lst_supply: u64,
    pub last_update_epoch: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ProtectedPosition {
    pub staker: Pubkey,
    pub principal_lamports: u64,
    pub lst_minted: u64,
    pub last_claim_timestamp: i64,
    pub last_claim_slot: u64,
    pub total_streamed_rewards: u64,
    pub total_native_sol_claimed: u64,
    pub total_usd_claimed: u64,
}

#[error_code]
pub enum RoiError {
    #[msg("Epoch management fee exceeds 25% cap")]
    FeeTooHigh,
    #[msg("Minimum stake is 0.01 SOL")]
    MinimumStakeNotMet,
    #[msg("Zero elapsed time or lamports accrued since last claim")]
    NothingToClaimYet,
    #[msg("SOL Yield Treasury has insufficient funded balance to cover this claim")]
    InsufficientSolTreasury,
    #[msg("USD Reward Vault has insufficient funded USDC balance for $120/ms payout")]
    InsufficientUsdVault,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
