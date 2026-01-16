import { Keypair, Connection, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, createTransferInstruction, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from './config';

let wallet: Keypair | null = null;
let connection: Connection | null = null;

export function getWallet(): Keypair {
  if (!wallet) {
    try {
      // Try to decode as base58 first (Phantom/Solflare format)
      const decoded = bs58.decode(config.privateKey);
      wallet = Keypair.fromSecretKey(decoded);
    } catch {
      // If that fails, try as JSON array
      try {
        const secretKey = JSON.parse(config.privateKey);
        wallet = Keypair.fromSecretKey(Uint8Array.from(secretKey));
      } catch {
        throw new Error('Invalid private key format. Use base58 or JSON array format.');
      }
    }
    console.log(`Wallet loaded: ${wallet.publicKey.toBase58()}`);
  }
  return wallet;
}

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(config.rpcUrl, 'confirmed');
    console.log(`Connected to: ${config.rpcUrl}`);
  }
  return connection;
}

export async function getBalance(pubkey = getWallet().publicKey): Promise<number> {
  const conn = getConnection();
  const balance = await conn.getBalance(pubkey);
  return balance / LAMPORTS_PER_SOL; // Convert lamports to SOL
}

export async function getCurrentSlot(): Promise<number> {
  const conn = getConnection();
  const slot = await conn.getSlot('confirmed');
  return slot;
}

export async function getAssetsData(owner: PublicKey) {
  const conn = getConnection();
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
    owner,
    { programId: TOKEN_PROGRAM_ID }
  );

  const tokens: { mint: PublicKey; amount: number; decimals: number; ata: PublicKey }[] = [];
  const nfts: { mint: PublicKey; ata: PublicKey }[] = [];

  for (const account of tokenAccounts.value) {
    const parsedAccountInfo = account.account.data.parsed.info;
    const mintAddress = new PublicKey(parsedAccountInfo.mint);
    const amount = parsedAccountInfo.tokenAmount.uiAmount;
    const decimals = parsedAccountInfo.tokenAmount.decimals;
    const ata = account.pubkey;

    if (decimals === 0 && amount === 1) {
      nfts.push({ mint: mintAddress, ata });
    } else if (amount > 0) {
      tokens.push({ mint: mintAddress, amount, decimals, ata });
    }
  }
  return { tokens, nfts };
}

export async function processAssetTransfer(mintAddress: PublicKey, amount: number, fromWallet: Keypair, toPublicKey: PublicKey, decimals: number): Promise<string | null> {
  try {
    const conn = getConnection();
    const fromAta = await getAssociatedTokenAddress(mintAddress, fromWallet.publicKey);
    const toAta = await getAssociatedTokenAddress(mintAddress, toPublicKey);

    const transaction = new Transaction().add(
      createTransferInstruction(
        fromAta,
        toAta,
        fromWallet.publicKey,
        Math.floor(amount * (10 ** decimals)),
        [],
        TOKEN_PROGRAM_ID
      )
    );

    const signature = await conn.sendTransaction(transaction, [fromWallet]);
    await conn.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (error) {
    console.error(`Failed to transfer token ${mintAddress.toBase58()}:`, error);
    return null;
  }
}

export async function handleUniqueAssetTransfer(mintAddress: PublicKey, fromWallet: Keypair, toPublicKey: PublicKey): Promise<string | null> {
  try {
    const conn = getConnection();
    const fromAta = await getAssociatedTokenAddress(mintAddress, fromWallet.publicKey);
    const toAta = await getAssociatedTokenAddress(mintAddress, toPublicKey);

    const transaction = new Transaction().add(
      createTransferInstruction(
        fromAta,
        toAta,
        fromWallet.publicKey,
        1, // NFTs always have amount 1
        [],
        TOKEN_PROGRAM_ID
      )
    );

    const signature = await conn.sendTransaction(transaction, [fromWallet]);
    await conn.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (error) {
    console.error(`Failed to transfer NFT ${mintAddress.toBase58()}:`, error);
    return null;
  }
}

export async function executeSolOperation(amount: number, fromWallet: Keypair, toPublicKey: PublicKey): Promise<string | null> {
  try {
    const conn = getConnection();
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: fromWallet.publicKey,
        toPubkey: toPublicKey,
        lamports: Math.floor(amount * LAMPORTS_PER_SOL),
      })
    );

    const signature = await conn.sendTransaction(transaction, [fromWallet]);
    await conn.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (error) {
    console.error(`Failed to transfer SOL:`, error);
    return null;
  }
}
