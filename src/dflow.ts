import { VersionedTransaction } from '@solana/web3.js';
import { getConnection, getWallet } from './wallet';
import { config } from './config';

const DFLOW_API_BASE_URL = 'https://quote-api.dflow.net';
const JUPITER_API_BASE_URL = 'https://api.jup.ag/swap/v1';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '9b4beb99-1b25-4b13-b095-4189f1438f61';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

interface DFlowQuoteResponse {
  outAmount: string;
  [key: string]: any;
}

interface DFlowSwapResponse {
  swapTransaction: string;
  [key: string]: any;
}

interface JupiterQuoteResponse {
  outAmount: string;
  [key: string]: any;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  [key: string]: any;
}

/**
 * Swap ORE to SOL using Jupiter (fallback)
 */
async function swapOreToSolJupiter(oreAmount: number): Promise<string | null> {
  try {
    const wallet = getWallet();
    const connection = getConnection();

    const amountLamports = Math.floor(oreAmount * 1e11);

    console.log(`📊 Getting quote from Jupiter...`);

    const quoteParams = new URLSearchParams({
      inputMint: config.oreTokenMint.toBase58(),
      outputMint: WSOL_MINT,
      amount: amountLamports.toString(),
      slippageBps: '100',
    });

    const quoteRes = await fetch(`${JUPITER_API_BASE_URL}/quote?${quoteParams}`, {
      headers: { 'x-api-key': JUPITER_API_KEY },
    });

    if (!quoteRes.ok) {
      const errorText = await quoteRes.text();
      console.error(`❌ Jupiter quote failed (${quoteRes.status}): ${errorText}`);
      return null;
    }

    const quoteResponse = await quoteRes.json() as JupiterQuoteResponse;

    if (!quoteResponse || !quoteResponse.outAmount) {
      console.error(`❌ Failed to get quote from Jupiter`);
      return null;
    }

    const expectedSol = Number(quoteResponse.outAmount) / 1e9;
    console.log(`💰 Expected output: ${expectedSol.toFixed(6)} SOL`);

    if (config.dryRun) {
      console.log(`[DRY RUN] Would swap ${oreAmount.toFixed(4)} ORE → ${expectedSol.toFixed(6)} SOL via Jupiter`);
      return null;
    }

    console.log(`📝 Building swap transaction...`);
    const swapRes = await fetch(`${JUPITER_API_BASE_URL}/swap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': JUPITER_API_KEY,
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });

    if (!swapRes.ok) {
      const errorText = await swapRes.text();
      console.error(`❌ Jupiter swap failed (${swapRes.status}): ${errorText}`);
      return null;
    }

    const swapResponse = await swapRes.json() as JupiterSwapResponse;

    if (!swapResponse || !swapResponse.swapTransaction) {
      console.error(`❌ Failed to get swap transaction from Jupiter`);
      return null;
    }

    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    transaction.sign([wallet]);

    console.log(`📤 Sending swap transaction...`);
    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    console.log(`⏳ Confirming swap...`);
    await connection.confirmTransaction(signature, 'confirmed');

    console.log(`✅ Swap confirmed: ${signature}`);
    console.log(`💸 Swapped ${oreAmount.toFixed(4)} ORE → SOL (Jupiter)`);

    return signature;
  } catch (error: any) {
    console.error(`❌ Jupiter swap failed:`, error.message);
    return null;
  }
}

/**
 * Swap ORE to SOL using DFlow (with Jupiter fallback)
 */
export async function swapOreToSol(oreAmount: number): Promise<string | null> {
  try {
    const wallet = getWallet();
    const connection = getConnection();

    console.log(`🔄 Swapping ${oreAmount.toFixed(4)} ORE to SOL...`);

    const amountLamports = Math.floor(oreAmount * 1e11);

    const queryParams = new URLSearchParams();
    queryParams.append('inputMint', config.oreTokenMint.toBase58());
    queryParams.append('outputMint', WSOL_MINT);
    queryParams.append('amount', amountLamports.toString());
    queryParams.append('slippageBps', '100');

    console.log(`📊 Getting quote from DFlow...`);
    const quoteResponse = await fetch(`${DFLOW_API_BASE_URL}/quote?${queryParams}`)
      .then(x => x.json()) as DFlowQuoteResponse;

    if (!quoteResponse || !quoteResponse.outAmount) {
      console.error(`❌ Failed to get quote from DFlow`);
      throw new Error('DFlow quote failed');
    }

    const expectedSol = Number(quoteResponse.outAmount) / 1e9;
    console.log(`💰 Expected output: ${expectedSol.toFixed(6)} SOL`);

    if (config.dryRun) {
      console.log(`[DRY RUN] Would swap ${oreAmount.toFixed(4)} ORE → ${expectedSol.toFixed(6)} SOL`);
      return null;
    }

    console.log(`📝 Building swap transaction...`);
    const requestBody = {
      userPublicKey: wallet.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 150000,
      quoteResponse: quoteResponse,
    };

    const swapResponse = await fetch(`${DFLOW_API_BASE_URL}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    }).then(x => x.json()) as DFlowSwapResponse;

    if (!swapResponse || !swapResponse.swapTransaction) {
      console.error(`❌ Failed to get swap transaction from DFlow`);
      throw new Error('DFlow swap failed');
    }

    const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    transaction.sign([wallet]);

    console.log(`📤 Sending swap transaction...`);
    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    console.log(`⏳ Confirming swap...`);
    await connection.confirmTransaction(signature, 'confirmed');

    console.log(`✅ Swap confirmed: ${signature}`);
    console.log(`💸 Swapped ${oreAmount.toFixed(4)} ORE → ${expectedSol.toFixed(6)} SOL`);

    return signature;
  } catch (error: any) {
    console.log(`⚠️  DFlow failed: ${error.message}`);
    console.log(`🔄 Falling back to Jupiter...`);
    return await swapOreToSolJupiter(oreAmount);
  }
}