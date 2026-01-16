import { getConnection } from './wallet';
import { config } from './config';
import { fetchRound } from './accounts';
import bs58 from 'bs58';

/**
 * Real-time bet tracker using websocket to monitor individual deploy transactions
 *
 * Monitors program logs to capture exact individual bet amounts per square,
 * replacing the estimation-based approach with real data.
 */

// Map to store bettor addresses by signature (for async lookup)
const addressCache = new Map<string, string>();

/**
 * Fetch bettor address from transaction (non-blocking background fetch)
 */
async function fetchBettorAddress(signature: string): Promise<void> {
  try {
    const connection = getConnection();
    const tx = await connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.transaction) return;

    // Find deploy instruction
    for (const ix of tx.transaction.message.instructions) {
      if ('data' in ix && 'programId' in ix) {
        if (!ix.programId.equals(config.programId)) continue;

        const data = Buffer.from(bs58.decode(ix.data as string));
        if (data.length >= 13 && data.readUInt8(0) === 0x1c) {
          // Found deploy instruction - get bettor address
          const accounts = (ix as any).accounts;
          const isAutomated = accounts && accounts.length >= 7;
          const bettorPubkey = isAutomated ? accounts[1] : accounts[0];
          const bettorAddr = bettorPubkey.toBase58();

          // Cache the address
          addressCache.set(signature, bettorAddr);
          break;
        }
      }
    }
  } catch (error) {
    // Silently fail - address is optional
  }
}

interface BetData {
  maxBetPerSquare: number[]; // Max bet seen for each of 25 squares (in SOL)
  totalBets: number; // Total number of bets tracked this round
  allBets: number[]; // All individual bets tracked this round (for median/percentile calculations)
}

let currentRoundId = 0;
let betData: BetData = {
  maxBetPerSquare: new Array(25).fill(0),
  totalBets: 0,
  allBets: [],
};

let subscriptionId: number | null = null;
let pollingInterval: NodeJS.Timeout | null = null;
let lastSeenDeployed: bigint[] = new Array(25).fill(BigInt(0));

/**
 * Poll Round account to catch bets missed by websocket
 */
async function pollRoundAccount(): Promise<void> {
  try {
    const round = await fetchRound(currentRoundId);

    // Check each square for increases in deployed amount
    for (let i = 0; i < 25; i++) {
      const currentDeployed = round.deployed[i];
      const lastSeen = lastSeenDeployed[i];

      if (currentDeployed > lastSeen) {
        // New bet detected that websocket may have missed
        const increaseLamports = currentDeployed - lastSeen;
        const increaseSol = Number(increaseLamports) / 1e11; // ORE uses 1e11

        // Update our tracking
        if (increaseSol > betData.maxBetPerSquare[i]) {
          betData.maxBetPerSquare[i] = increaseSol;
        }

        betData.allBets.push(increaseSol);

        // Log only if significant (above 0.01 SOL to avoid spam)
        if (increaseSol >= 0.01) {
          console.log(`🔍 Polling detected bet: ${increaseSol.toFixed(6)} SOL on square ${i} (websocket may have missed)`);
        }

        lastSeenDeployed[i] = currentDeployed;
      }
    }
  } catch (error) {
    // Silently fail - don't spam errors during polling
  }
}

/**
 * Start monitoring deploy transactions via websocket + polling
 */
export function startBetTracking(roundId: number): void {
  // Reset tracking for new round
  if (roundId !== currentRoundId) {
    console.log(`🔄 Starting bet tracking for round ${roundId}`);
    currentRoundId = roundId;
    betData = {
      maxBetPerSquare: new Array(25).fill(0),
      totalBets: 0,
      allBets: [],
    };
    lastSeenDeployed = new Array(25).fill(BigInt(0));
    // Clear address cache for new round
    addressCache.clear();
  }

  // Don't create duplicate subscriptions
  if (subscriptionId !== null) {
    return;
  }

  const connection = getConnection();

  // Subscribe to all program logs
  subscriptionId = connection.onLogs(
    config.programId,
    (logs) => {
      // Process async to fetch address before logging
      (async () => {
        try {
          if (logs.err) return;

          // Parse bet amount from logs (fast path - no RPC calls)
          for (const log of logs.logs) {
            // Try multiple patterns to catch the bet amount
            // Format: "Program log: Round #10947: deploying 0.12834 SOL to 25 squares"
            const patterns = [
              /deploying\s+(\d+\.?\d*)\s*SOL/i,
              /deployed?\s+(\d+\.?\d*)\s*SOL/i,
              /amount[:\s]+(\d+\.?\d*)\s*SOL/i,
              /bet[:\s]+(\d+\.?\d*)\s*SOL/i,
            ];

            for (const pattern of patterns) {
              const match = log.match(pattern);
              if (match) {
                const amountSol = parseFloat(match[1]);

                if (isNaN(amountSol) || amountSol <= 0) continue;

                // Update max bets (assumes all 25 squares)
                for (let i = 0; i < 25; i++) {
                  if (amountSol > betData.maxBetPerSquare[i]) {
                    betData.maxBetPerSquare[i] = amountSol;
                  }
                }

                betData.totalBets++;
                betData.allBets.push(amountSol);

                // Fetch address before logging (await it)
                await fetchBettorAddress(logs.signature);
                const bettorAddr = addressCache.get(logs.signature) || 'unknown';

                // Log tracked bets
                if (amountSol >= 0.005) {
                  console.log(`📡 Tracked bet: ${amountSol.toFixed(6)} SOL (${bettorAddr})`);
                }

                break; // Found amount, no need to try other patterns
              }
            }
          }
        } catch (error: any) {
          // Silently continue on parse errors (don't block websocket)
        }
      })();
    },
    'confirmed'
  );

  console.log(`✅ Websocket bet tracking active (subscription ${subscriptionId})`);

  // Initialize baseline for polling (fetch current state)
  fetchRound(currentRoundId)
    .then((round) => {
      lastSeenDeployed = round.deployed;
      console.log(`📊 Initialized polling baseline with current round state`);
    })
    .catch(() => {});

  // Start polling as backup to catch missed bets (every 2 seconds)
  pollingInterval = setInterval(() => {
    pollRoundAccount().catch(() => {});
  }, 2000);

  console.log(`🔄 Polling backup active (checking every 2s for missed bets)`);
}

/**
 * Stop monitoring (cleanup)
 */
export async function stopBetTracking(): Promise<void> {
  if (subscriptionId !== null) {
    const connection = getConnection();
    await connection.removeOnLogsListener(subscriptionId);
    subscriptionId = null;
    console.log(`🛑 Stopped websocket bet tracking`);
  }

  if (pollingInterval !== null) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log(`🛑 Stopped polling backup`);
  }
}

/**
 * Get the current maximum bet per square from tracked data
 * Returns the highest individual bet seen across all squares
 */
export function getMaxBet(): number {
  const maxBet = Math.max(...betData.maxBetPerSquare);
  return maxBet;
}

/**
 * Get the max bet for a specific square
 */
export function getMaxBetForSquare(squareIndex: number): number {
  if (squareIndex < 0 || squareIndex >= 25) {
    return 0;
  }
  return betData.maxBetPerSquare[squareIndex];
}

/**
 * Get full bet tracking stats
 */
export function getBetStats(): BetData & { maxBetOverall: number } {
  return {
    ...betData,
    maxBetOverall: getMaxBet(),
  };
}

/**
 * Check if we have any bet data
 */
export function hasBetData(): boolean {
  return betData.totalBets > 0;
}

/**
 * Get the Nth highest bet from tracked data
 * Returns the specified ranked bet (0 = highest, 1 = 2nd highest, etc.)
 */
export function getNthHighestBet(n: number): number {
  if (betData.allBets.length === 0) {
    return 0;
  }

  // Sort bets in descending order
  const sortedBets = [...betData.allBets].sort((a, b) => b - a);

  // Return the Nth bet (capped at array length)
  const index = Math.min(n, sortedBets.length - 1);
  return sortedBets[index];
}
