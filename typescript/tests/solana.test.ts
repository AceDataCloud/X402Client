import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

import { buildSolanaPayment, signSolanaPayment } from '../src/solana.js';
import type { PaymentRequirement, SolanaWalletAdapter } from '../src/types.js';

const FEE_PAYER = '3SPm6qbgsDkj24MuR8Ss4sH97fziqyCiqFKDyeVU2igq';

function requirement(): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    amount: '952',
    maxTimeoutSeconds: 3600,
    resource: '/serp/google',
    description: 'test',
    payTo: '5iVXFrYaYWX2GUTbkQj8mDBoBhAX8bneYigS2LJTia43',
    asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    extra: {
      feePayer: FEE_PAYER,
      decimals: 6,
      computeUnitLimit: 100_000,
      computeUnitPriceMicroLamports: 5_000,
    },
  };
}

describe('Solana exact payment', () => {
  it('builds a facilitator-fee-payer partially signed transaction', async () => {
    const payer = Keypair.generate();
    const wallet: SolanaWalletAdapter = {
      publicKey: payer.publicKey,
      async signTransaction(value) {
        const transaction = value as VersionedTransaction;
        transaction.sign([payer]);
        return transaction;
      },
    };

    const envelope = await buildSolanaPayment(
      requirement(),
      wallet,
      '11111111111111111111111111111111'
    );

    expect(Object.keys(envelope.payload)).toEqual(['transaction']);
    const payload = envelope.payload as { transaction: string };
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(payload.transaction, 'base64')
    );
    expect(transaction.message.staticAccountKeys[0].equals(new PublicKey(FEE_PAYER))).toBe(true);
    expect(transaction.signatures[0].every((byte) => byte === 0)).toBe(true);
    expect(transaction.signatures[1].some((byte) => byte !== 0)).toBe(true);
    expect(transaction.message.compiledInstructions).toHaveLength(4);
  });

  it('requires the facilitator fee payer', async () => {
    const payer = Keypair.generate();
    const req = requirement();
    delete req.extra!.feePayer;

    await expect(
      buildSolanaPayment(
        req,
        { publicKey: payer.publicKey, signTransaction: async (value) => value },
        '11111111111111111111111111111111'
      )
    ).rejects.toThrow(/feePayer/);
  });

  it('rejects legacy wallets that broadcast before service delivery', async () => {
    const payer = Keypair.generate();

    await expect(
      buildSolanaPayment(
        requirement(),
        {
          publicKey: payer.publicKey,
          signAndSendTransaction: async () => 'unsafe-signature',
        },
        '11111111111111111111111111111111'
      )
    ).rejects.toThrow(/signAndSendTransaction is no longer supported/);
  });

  it('rejects a missing recipient ATA before asking the wallet to sign', async () => {
    const payer = Keypair.generate();
    const signTransaction = vi.fn(async (value) => value);
    vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1,
    });
    vi.spyOn(Connection.prototype, 'getMultipleAccountsInfo').mockResolvedValue([
      {} as never,
      null,
    ]);

    await expect(
      signSolanaPayment(requirement(), { publicKey: payer.publicKey, signTransaction }, 'https://rpc.test')
    ).rejects.toThrow(/recipient token account does not exist/);
    expect(signTransaction).not.toHaveBeenCalled();
  });
});