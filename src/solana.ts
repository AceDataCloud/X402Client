/**
 * Solana X402 payment signing.
 *
 * Builds a SPL TransferChecked instruction, signs via wallet adapter,
 * and produces the X-Payment header.
 */

import type { PaymentRequirement, SolanaPayload, SolanaWalletAdapter, X402PaymentEnvelope } from './types.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

function findATA(owner: string, mint: string): string {
  // Lazy-load @solana/web3.js to keep it optional
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PublicKey } = require('@solana/web3.js') as typeof import('@solana/web3.js');
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

export async function signSolanaPayment(
  requirements: PaymentRequirement,
  wallet: SolanaWalletAdapter
): Promise<X402PaymentEnvelope> {
  const {
    PublicKey,
    Transaction,
    TransactionInstruction,
    ComputeBudgetProgram,
    Connection,
  } = require('@solana/web3.js') as typeof import('@solana/web3.js');

  const payTo = requirements.payTo;
  const mint = requirements.asset;
  const amount = BigInt(requirements.maxAmountRequired);
  const decimals = requirements.extra?.decimals ?? 6;
  const computeUnitLimit = requirements.extra?.computeUnitLimit ?? 0;
  const computeUnitPrice = requirements.extra?.computeUnitPriceMicroLamports ?? 0;

  const payerAddress = wallet.publicKey.toBase58();
  const sourceATA = findATA(payerAddress, mint);
  const destATA = findATA(payTo, mint);

  const tx = new Transaction();

  if (computeUnitLimit > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  }
  if (computeUnitPrice > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice }));
  }

  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM_ID),
      keys: [
        { pubkey: new PublicKey(sourceATA), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(destATA), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(payerAddress), isSigner: true, isWritable: false },
      ],
      data: Buffer.from(buildTransferCheckedData(amount, decimals)),
    })
  );

  tx.feePayer = new PublicKey(payerAddress);

  // Fetch blockhash
  const rpcUrl = requirements.extra?.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl, 'confirmed');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  // Sign and send
  const result = await wallet.signAndSendTransaction(tx);
  const signature = typeof result === 'string' ? result : result.signature;

  const payload: SolanaPayload = { signature };

  return {
    x402Version: 1,
    scheme: requirements.scheme || 'exact',
    network: requirements.network || 'solana',
    payload,
  };
}
