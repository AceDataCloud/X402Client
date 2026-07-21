/**
 * Solana X402 payment signing.
 *
 * Builds a facilitator-sponsored SPL TransferChecked transaction and asks the
 * wallet to add only the payer signature. The facilitator broadcasts it later.
 */

import type { PaymentRequirement, SolanaPayload, SolanaWalletAdapter, X402PaymentEnvelope } from './types.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

async function loadWeb3() {
  return import('@solana/web3.js');
}

function getPublicKeyString(wallet: SolanaWalletAdapter): string {
  return typeof wallet.publicKey.toBase58 === 'function'
    ? wallet.publicKey.toBase58()
    : wallet.publicKey.toString();
}

async function findATA(owner: string, mint: string): Promise<string> {
  const { PublicKey } = await loadWeb3();
  const [ata] = PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBytes(), new PublicKey(TOKEN_PROGRAM_ID).toBytes(), new PublicKey(mint).toBytes()],
    new PublicKey(ATA_PROGRAM_ID)
  );
  return ata.toBase58();
}

/**
 * Build SPL TransferChecked instruction data.
 * Layout: [12 (u8), amount (u64 LE), decimals (u8)]
 */
function buildTransferCheckedData(amount: bigint, decimals: number): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked discriminator
  const view = new DataView(data.buffer);
  view.setBigUint64(1, amount, true);
  data[9] = decimals;
  return data;
}

function randomMemoNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function signSolanaPayment(
  requirements: PaymentRequirement,
  wallet: SolanaWalletAdapter,
  rpcUrl?: string
): Promise<X402PaymentEnvelope> {
  const { Connection } = await loadWeb3();
  const endpoint = rpcUrl ?? requirements.extra?.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(endpoint, 'confirmed');
  const { PublicKey } = await loadWeb3();
  const payerAddress = getPublicKeyString(wallet);
  const [sourceATA, destinationATA] = await Promise.all([
    findATA(payerAddress, requirements.asset),
    findATA(requirements.payTo, requirements.asset),
  ]);
  const accounts = await connection.getMultipleAccountsInfo([
    new PublicKey(sourceATA),
    new PublicKey(destinationATA),
  ]);
  if (!accounts[0]) throw new Error(`Solana payer token account does not exist: ${sourceATA}`);
  if (!accounts[1]) throw new Error(`Solana payment recipient token account does not exist: ${destinationATA}`);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  return buildSolanaPayment(requirements, wallet, blockhash);
}

export async function buildSolanaPayment(
  requirements: PaymentRequirement,
  wallet: SolanaWalletAdapter,
  blockhash: string
): Promise<X402PaymentEnvelope> {
  const {
    PublicKey,
    TransactionMessage,
    TransactionInstruction,
    VersionedTransaction,
    ComputeBudgetProgram,
  } = await loadWeb3();

  const payTo = requirements.payTo;
  const mint = requirements.asset;
  const amount = BigInt(requirements.amount ?? requirements.maxAmountRequired ?? '0');
  const decimals = requirements.extra?.decimals ?? 6;
  const computeUnitLimit = requirements.extra?.computeUnitLimit ?? 100_000;
  const computeUnitPrice = requirements.extra?.computeUnitPriceMicroLamports ?? 5_000;
  const memo = requirements.extra?.memo ?? randomMemoNonce();
  if (Buffer.byteLength(memo, 'utf8') > 256) {
    throw new Error('PaymentRequirement.extra.memo must be at most 256 bytes');
  }
  const feePayer = requirements.extra?.feePayer;
  if (!feePayer) {
    throw new Error('PaymentRequirement.extra.feePayer is required for Solana');
  }
  if (!wallet.signTransaction) {
    if (wallet.signAndSendTransaction) {
      throw new Error(
        'Solana signAndSendTransaction is no longer supported because it broadcasts before service delivery; provide signTransaction instead'
      );
    }
    throw new Error('Solana wallet must provide signTransaction');
  }

  const payerAddress = getPublicKeyString(wallet);
  const sourceATA = await findATA(payerAddress, mint);
  const destATA = await findATA(payTo, mint);

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice }),
    new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: new PublicKey(sourceATA), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(destATA), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(payerAddress), isSigner: true, isWritable: false },
      ],
      data: Buffer.from(buildTransferCheckedData(amount, decimals)),
    }),
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM_ID),
      keys: [],
      data: Buffer.from(memo, 'utf8'),
    }),
  ];
  const message = new TransactionMessage({
    payerKey: new PublicKey(feePayer),
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  const signed = (await wallet.signTransaction(transaction)) as {
    serialize(): Uint8Array;
  };
  const payload: SolanaPayload = {
    transaction: Buffer.from(signed.serialize()).toString('base64'),
  };

  return {
    x402Version: 2,
    accepted: requirements,
    payload,
  };
}
