import {
  TransactionInstruction,
  SystemProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction as solanaConfirm,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { getWallet, getConnection } from './wallet';
import { config } from './config';
import { getBoardPDA, getRoundPDA, getMinerPDA, getAutomationPDA, getTreasuryPDA, getConfigPDA, fetchBoard } from './accounts';

/**
 * Build instruction to create/update automation account
 * Based on transaction data: instruction 0x00 (automate)
 */
export function buildAutomateInstruction(
  amountPerSquare: number, // SOL per square
  deposit: number, // Total SOL to deposit
): TransactionInstruction {
  const wallet = getWallet();
  const minerPDA = getMinerPDA();
  const automationPDA = getAutomationPDA();

  // Convert SOL to lamports
  const amountLamports = BigInt(Math.floor(amountPerSquare * 1e9));
  const depositLamports = BigInt(Math.floor(deposit * 1e9));
  const feeLamports = BigInt(10000); // 0.00001 SOL execution fee
  const mask = 25n; // 25 squares
  const strategy = 0; // Random strategy

  // Build instruction data (34 bytes):
  // - 1 byte: discriminator (0x00)
  // - 8 bytes: amount per square (u64 LE)
  // - 8 bytes: deposit (u64 LE)
  // - 8 bytes: fee (u64 LE)
  // - 8 bytes: mask (u64 LE)
  // - 1 byte: strategy
  const data = Buffer.alloc(34);
  data.writeUInt8(0x00, 0);
  data.writeBigUInt64LE(amountLamports, 1);
  data.writeBigUInt64LE(depositLamports, 9);
  data.writeBigUInt64LE(feeLamports, 17);
  data.writeBigUInt64LE(mask, 25);
  data.writeUInt8(strategy, 33);

  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: automationPDA, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: false, isWritable: true }, // executor (self)
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.programId,
    data,
  });
}

/**
 * Build deploy instruction for ore.supply
 *
 * Instruction structure (13 bytes):
 * - 1 byte: discriminator (6 = Deploy)
 * - 8 bytes: amount per square in lamports (u64 LE)
 * - 4 bytes: squares mask (u32 LE) - 0x01ffffff for all 25 squares
 *
 * UPDATED: Now requires 9 base accounts + optional 2 entropy accounts (for first deploy)
 */
export async function buildDeployInstruction(amountPerSquareSOL: number): Promise<TransactionInstruction> {
  const wallet = getWallet();
  const boardPDA = getBoardPDA();
  const configPDA = getConfigPDA();
  const minerPDA = getMinerPDA();
  const automationPDA = getAutomationPDA();

  // Get current round
  const board = await fetchBoard();
  const roundPDA = getRoundPDA(board.roundId);

  // Convert SOL to lamports
  const amountLamports = BigInt(Math.floor(amountPerSquareSOL * 1e9));

  // Build 13-byte instruction
  const data = Buffer.alloc(13);
  data.writeUInt8(6, 0);                 // 1 byte: discriminator (Deploy = 6)
  data.writeBigUInt64LE(amountLamports, 1); // 8 bytes: amount (u64 LE)
  data.writeUInt32LE(0x01ffffff, 9);     // 4 bytes: mask (all 25 squares)

  // 9 base accounts for deploy (NEW ore.supply format)
  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },      // 0. signer
    { pubkey: wallet.publicKey, isSigner: false, isWritable: true },     // 1. authority
    { pubkey: automationPDA, isSigner: false, isWritable: true },        // 2. automation
    { pubkey: boardPDA, isSigner: false, isWritable: true },             // 3. board
    { pubkey: configPDA, isSigner: false, isWritable: false },           // 4. config (NEW!)
    { pubkey: minerPDA, isSigner: false, isWritable: true },             // 5. miner
    { pubkey: roundPDA, isSigner: false, isWritable: true },             // 6. round
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 7. system program
    { pubkey: config.programId, isSigner: false, isWritable: false },    // 8. ore program (NEW!)
  ];

  // Check if this is first deploy of round (board.endSlot == u64::MAX)
  if (board.endSlot >= 18446744073709551615n) {
    // First deploy of round - add entropy accounts
    const { PublicKey } = require('@solana/web3.js');

    // Entropy addresses (from manual transaction and config)
    const entropyVarAddress = new PublicKey('BWCaDY96Xe4WkFq1M7UiCCRcChsJ3p51L5KrGzhxgm2E');
    const entropyProgramId = new PublicKey('3jSkUuYBoJzQPMEzTvkDFXCZUBksPamrVhrnHR9igu2X');

    keys.push(
      { pubkey: entropyVarAddress, isSigner: false, isWritable: true },     // 9. entropy var
      { pubkey: entropyProgramId, isSigner: false, isWritable: false }       // 10. entropy program
    );
  }

  return new TransactionInstruction({
    keys,
    programId: config.programId,
    data,
  });
}

/**
 * Build instruction to claim SOL rewards
 * Based on transaction data: instruction 0x03
 */
export function buildClaimSolInstruction(): TransactionInstruction {
  const wallet = getWallet();
  const minerPDA = getMinerPDA();

  // Instruction data: 1 byte discriminator (0x03)
  const data = Buffer.from([0x03]);

  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.programId,
    data,
  });
}

/**
 * Build instruction to claim ORE rewards
 * Discriminator: 4 (ClaimORE)
 */
export async function buildClaimOreInstruction(): Promise<TransactionInstruction> {
  const wallet = getWallet();
  const minerPDA = getMinerPDA();
  const treasuryPDA = getTreasuryPDA();

  // Instruction data: 1 byte discriminator (4 = ClaimORE)
  const data = Buffer.from([4]);

  // Get token accounts
  const walletOreAta = await getAssociatedTokenAddress(config.oreTokenMint, wallet.publicKey);
  const treasuryOreAta = await getAssociatedTokenAddress(config.oreTokenMint, treasuryPDA, true);

  // 9 accounts (ore.supply ClaimORE format)
  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },           // 0. signer
    { pubkey: minerPDA, isSigner: false, isWritable: true },                  // 1. miner
    { pubkey: config.oreTokenMint, isSigner: false, isWritable: false },      // 2. mint
    { pubkey: walletOreAta, isSigner: false, isWritable: true },              // 3. recipient
    { pubkey: treasuryPDA, isSigner: false, isWritable: true },               // 4. treasury
    { pubkey: treasuryOreAta, isSigner: false, isWritable: true },            // 5. treasury_tokens
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },  // 6. system_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },         // 7. token_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 8. associated_token_program
  ];

  return new TransactionInstruction({
    keys,
    programId: config.programId,
    data,
  });
}

/**
 * Build instruction to close automation account
 */
export function buildCloseAutomationInstruction(): TransactionInstruction {
  const wallet = getWallet();
  const minerPDA = getMinerPDA();
  const automationPDA = getAutomationPDA();

  // Build automate instruction with zeros to signal closure
  const data = Buffer.alloc(34);
  data.writeUInt8(0x00, 0);
  // Rest is zeros

  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: automationPDA, isSigner: false, isWritable: true },
    { pubkey: PublicKey.default, isSigner: false, isWritable: true }, // default = close signal
    { pubkey: minerPDA, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: config.programId,
    data,
  });
}

/**
 * Build instruction to checkpoint miner (process rewards)
 * Discriminator: 2 (Checkpoint)
 *
 * Checkpoint processes rewards from the miner's current round
 * Requires 6 accounts: signer, board, miner, round, treasury, system_program
 */
export function buildCheckpointInstruction(roundIdToCheckpoint: number): TransactionInstruction {
  const wallet = getWallet();
  const boardPDA = getBoardPDA();
  const minerPDA = getMinerPDA();
  const roundPDA = getRoundPDA(roundIdToCheckpoint);
  const treasuryPDA = getTreasuryPDA();

  const data = Buffer.from([2]); // Checkpoint = 2

  // 6 accounts (ore.supply Checkpoint format)
  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },      // 0. signer
    { pubkey: boardPDA, isSigner: false, isWritable: true },             // 1. board (writable!)
    { pubkey: minerPDA, isSigner: false, isWritable: true },             // 2. miner
    { pubkey: roundPDA, isSigner: false, isWritable: true },             // 3. round
    { pubkey: treasuryPDA, isSigner: false, isWritable: true },          // 4. treasury
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 5. system_program
  ];

  return new TransactionInstruction({
    keys,
    programId: config.programId,
    data,
  });
}

/**
 * Check if checkpoint is needed
 * Returns true if checkpoint is needed
 *
 * IMPORTANT: Checkpoint is only needed when miner.checkpoint_id < miner.round_id
 * The round_id advances when you DEPLOY to a new round, not when you checkpoint!
 */
export async function needsCheckpoint(): Promise<boolean> {
  const { fetchMiner } = require('./accounts');

  const miner = await fetchMiner();
  if (!miner) {
    return false; // No miner account yet
  }

  const minerCheckpointId = Number(miner.checkpointId);
  const minerRoundId = Number(miner.roundId);

  // Checkpoint is needed if checkpoint_id < round_id
  // This means we deployed to round_id but haven't checkpointed it yet
  return minerCheckpointId < minerRoundId;
}

/**
 * Helper to send and confirm transaction
 */
export async function sendAndConfirm(
  instructions: TransactionInstruction[],
  description: string
): Promise<string> {
  const connection = getConnection();
  const wallet = getWallet();
  const { ComputeBudgetProgram } = require('@solana/web3.js');

  const transaction = new Transaction();

  // Add compute budget instructions FIRST (like manual transaction)
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })
  );
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 })
  );

  // Add all the actual instructions
  instructions.forEach(ix => transaction.add(ix));

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = wallet.publicKey;

  transaction.sign(wallet);

  console.log(`📤 Sending: ${description}...`);
  const signature = await solanaConfirm(
    connection,
    transaction,
    [wallet],
    { commitment: 'confirmed' }
  );

  console.log(`✅ Confirmed: ${signature}`);
  return signature;
}
