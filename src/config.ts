import { PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';

dotenv.config();

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseFloat(value) : defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

export const config = {
  // Solana connection
  rpcUrl: getEnv('RPC_URL', 'https://api.mainnet-beta.solana.com'),
  privateKey: getEnv('PRIVATE_KEY'),

  // ore.supply program
  programId: new PublicKey(getEnv('PROGRAM_ID', 'oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv')),

  // Betting strategy settings
  bettingStrategy: getEnv('BETTING_STRATEGY', 'max'), // 'max' or 'median'
  whaleMultiplier: getEnvNumber('WHALE_MULTIPLIER', 2.5), // Assume top whale bets this much × average
  bufferPercent: getEnvNumber('BUFFER_PERCENT', 10), // Add 10% to estimated whale bet
  maxBetPerSquare: getEnvNumber('MAX_BET_PER_SQUARE', 0.01), // Max 0.01 SOL per square
  minBetPerSquare: getEnvNumber('MIN_BET_PER_SQUARE', 0.0001), // Min 0.0001 SOL per square

  // Bot settings
  pollIntervalMs: getEnvNumber('POLL_INTERVAL_MS', 2000), // Check every 2 seconds (need fast polling for sniping)
  snipeWindowSeconds: getEnvNumber('SNIPE_WINDOW_SECONDS', 10), // Deploy this many seconds before round ends
  claimEveryRound: getEnvBoolean('CLAIM_EVERY_ROUND', true),
  minClaimableSol: getEnvNumber('MIN_CLAIMABLE_SOL', 0.001),
  minClaimableOre: getEnvNumber('MIN_CLAIMABLE_ORE', 0.5), // Min ORE to claim (0.5 ORE)
  autoSwapOre: getEnvBoolean('AUTO_SWAP_ORE', true), // Auto-swap claimed ORE to SOL
  minOreForSwap: getEnvNumber('MIN_ORE_FOR_SWAP', 0.5), // Min ORE balance to trigger swap

  // Token addresses (ore.supply ORE token)
  oreTokenMint: new PublicKey(getEnv('ORE_TOKEN_MINT', 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp')),

  // Safety
  dryRun: getEnvBoolean('DRY_RUN', false),
  minWalletBalance: getEnvNumber('MIN_WALLET_BALANCE', 0.1), // Keep at least 0.1 SOL for fees
};
