import { PublicKey } from '@solana/web3.js';
import { getConnection, getWallet } from './wallet';
import { config } from './config';

// PDA seeds for ore.supply
const BOARD_SEED = Buffer.from('board');
const ROUND_SEED = Buffer.from('round');
const MINER_SEED = Buffer.from('miner');
const AUTOMATION_SEED = Buffer.from('automation');
const TREASURY_SEED = Buffer.from('treasury');
const CONFIG_SEED = Buffer.from('config');

/**
 * Get Board PDA (singleton - tracks current round)
 */
export function getBoardPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [BOARD_SEED],
    config.programId
  );
  return pda;
}

/**
 * Get Round PDA for a specific round ID
 */
export function getRoundPDA(roundId: number): PublicKey {
  const roundIdBuffer = Buffer.alloc(8);
  roundIdBuffer.writeBigUInt64LE(BigInt(roundId));

  const [pda] = PublicKey.findProgramAddressSync(
    [ROUND_SEED, roundIdBuffer],
    config.programId
  );
  return pda;
}

/**
 * Get Miner PDA for a wallet
 */
export function getMinerPDA(authority?: PublicKey): PublicKey {
  const wallet = authority || getWallet().publicKey;
  const [pda] = PublicKey.findProgramAddressSync(
    [MINER_SEED, wallet.toBuffer()],
    config.programId
  );
  return pda;
}

/**
 * Get Automation PDA for a wallet
 * Automation is OPTIONAL - if account doesn't exist, deploy is treated as manual
 */
export function getAutomationPDA(authority?: PublicKey): PublicKey {
  const wallet = authority || getWallet().publicKey;
  const [pda] = PublicKey.findProgramAddressSync(
    [AUTOMATION_SEED, wallet.toBuffer()],
    config.programId
  );
  return pda;
}

/**
 * Get Treasury PDA (singleton - holds ORE token reserves)
 */
export function getTreasuryPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [TREASURY_SEED],
    config.programId
  );
  return pda;
}

/**
 * Get Config PDA (singleton - program configuration)
 */
export function getConfigPDA(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    config.programId
  );
  return pda;
}

/**
 * Board account data structure
 */
export interface Board {
  roundId: number;
  startSlot: bigint;
  endSlot: bigint;
}

/**
 * Round account data structure
 */
export interface Round {
  id: number;
  deployed: bigint[]; // 25 elements - SOL deployed per square
  count: bigint[];    // 25 elements - number of players per square
  totalDeployed: bigint;
  totalWinnings: bigint;
}

/**
 * Miner account data structure
 */
export interface Miner {
  rewardsSol: bigint;
  rewardsOre: bigint;
  checkpointId: bigint;
  roundId: bigint; // The ONLY round that can be checkpointed next
}

/**
 * Fetch Board account (current round info)
 */
export async function fetchBoard(): Promise<Board> {
  const connection = getConnection();
  const boardPDA = getBoardPDA();

  const accountInfo = await connection.getAccountInfo(boardPDA);
  if (!accountInfo) {
    throw new Error('Board account not found');
  }

  const data = accountInfo.data;

  // Parse Board structure:
  // - 8 bytes: discriminator
  // - 8 bytes: roundId (u64 LE)
  // - 8 bytes: startSlot (u64 LE)
  // - 8 bytes: endSlot (u64 LE)
  return {
    roundId: Number(data.readBigUInt64LE(8)),
    startSlot: data.readBigUInt64LE(16),
    endSlot: data.readBigUInt64LE(24),
  };
}

/**
 * Fetch Round account (competition data)
 */
export async function fetchRound(roundId: number): Promise<Round> {
  const connection = getConnection();
  const roundPDA = getRoundPDA(roundId);

  const accountInfo = await connection.getAccountInfo(roundPDA);
  if (!accountInfo) {
    throw new Error(`Round ${roundId} account not found`);
  }

  const data = accountInfo.data;

  // Parse Round structure:
  // - 8 bytes: discriminator
  // - 8 bytes: id (u64 LE)
  // - 200 bytes: deployed[25] (u64 LE each) - offset 16
  // - 32 bytes: slot_hash - offset 216
  // - 200 bytes: count[25] (u64 LE each) - offset 248
  // - ... other fields ...
  // - at offset 536: totalDeployed (u64 LE)
  // - at offset 552: totalWinnings (u64 LE)

  const deployed: bigint[] = [];
  for (let i = 0; i < 25; i++) {
    deployed.push(data.readBigUInt64LE(16 + i * 8));
  }

  const count: bigint[] = [];
  for (let i = 0; i < 25; i++) {
    count.push(data.readBigUInt64LE(248 + i * 8));
  }

  return {
    id: Number(data.readBigUInt64LE(8)),
    deployed,
    count,
    totalDeployed: data.readBigUInt64LE(536),
    totalWinnings: data.readBigUInt64LE(552),
  };
}

/**
 * Fetch Miner account (rewards data)
 */
export async function fetchMiner(authority?: PublicKey): Promise<Miner | null> {
  const connection = getConnection();
  const minerPDA = getMinerPDA(authority);

  const accountInfo = await connection.getAccountInfo(minerPDA);
  if (!accountInfo) {
    return null; // Miner not initialized yet
  }

  const data = accountInfo.data;

  // Parse Miner structure (ore.supply):
  // Account layout: discriminator(8) + authority(32) + deployed[25](200) + cumulative[25](200) +
  //                 checkpoint_fee(8) + checkpoint_id(8) + last_claim_ore_at(8) + last_claim_sol_at(8) +
  //                 rewards_factor(16) + rewards_sol(8) + rewards_ore(8) + refined_ore(8) +
  //                 round_id(8) + lifetime_rewards_sol(8) + lifetime_rewards_ore(8)
  // Total: 536 bytes (with discriminator)

  return {
    checkpointId: data.readBigUInt64LE(448),  // offset 448 (440 + 8 for discriminator)
    rewardsSol: data.readBigUInt64LE(488),    // offset 488 (480 + 8 for discriminator)
    rewardsOre: data.readBigUInt64LE(496),    // offset 496 (488 + 8 for discriminator)
    roundId: data.readBigUInt64LE(512),       // offset 512 (504 + 8 for discriminator)
  };
}

/**
 * Fetch Automation account info
 */
export async function fetchAutomation(): Promise<{
  amountPerSquare: bigint;
  balance: bigint;
  mask: bigint;
} | null> {
  const connection = getConnection();
  const automationPDA = getAutomationPDA();

  const accountInfo = await connection.getAccountInfo(automationPDA);
  if (!accountInfo || accountInfo.data.length < 112) {
    return null;
  }

  const data = accountInfo.data;

  // Parse Automation structure:
  // - offset 8: amountPerSquare (u64 LE)
  // - offset 48: balance (u64 LE)
  // - offset 104: mask (u64 LE)

  return {
    amountPerSquare: data.readBigUInt64LE(8),
    balance: data.readBigUInt64LE(48),
    mask: data.readBigUInt64LE(104),
  };
}
