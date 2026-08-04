import { describe, expect, it } from 'vitest';
import { TypedDataEncoder, Wallet, verifyTypedData } from 'ethers';

import { signEVMPayment } from '../src/evm.js';
import type { EVMProvider, PaymentRequirement } from '../src/types.js';

const PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function exactRequirement(): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '952',
    maxTimeoutSeconds: 120,
    resource: '/serp/google',
    description: 'test',
    payTo: '0x4d2f00dac0acb02c7211cbde2dbe9d86d7b7b2f2',
    asset: USDC,
    extra: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
  };
}

/** EIP-1193 provider backed by an ethers Wallet, capturing the wire typed data. */
function makeWalletProvider(privateKey: string) {
  const wallet = new Wallet(privateKey);
  const seen: Array<Record<string, any>> = [];
  const provider: EVMProvider = {
    async request({ method, params }) {
      if (method !== 'eth_signTypedData_v4') throw new Error(`Unexpected method: ${method}`);
      const typedData = JSON.parse(String(params?.[1]));
      seen.push(typedData);
      // ethers derives the domain itself and rejects an explicit EIP712Domain.
      const { EIP712Domain: _domainTypes, ...structTypes } = typedData.types;
      return wallet.signTypedData(typedData.domain, structTypes, typedData.message);
    },
  };
  return { provider, wallet, seen };
}

describe('EVM exact payment', () => {
  it('uses an immediately valid EIP-3009 authorization', async () => {
    const { provider, wallet } = makeWalletProvider(PRIVATE_KEY);
    const envelope = await signEVMPayment(exactRequirement(), provider, wallet.address);
    const payload = envelope.payload as { authorization: { validAfter: string; validBefore: string } };

    expect(payload.authorization.validAfter).toBe('0');
    expect(Number(payload.authorization.validBefore)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('declares EIP712Domain in the wire types', async () => {
    // MetaMask's sanitizeData() injects `EIP712Domain: []` when the field is
    // absent, so the wallet signs an empty-domain digest and the facilitator
    // recovers a stranger — every EVM top-up failed this way for 13 days.
    const { provider, wallet, seen } = makeWalletProvider(PRIVATE_KEY);
    await signEVMPayment(exactRequirement(), provider, wallet.address);

    expect(seen).toHaveLength(1);
    expect(seen[0].types.EIP712Domain).toEqual([
      { name: 'name', type: 'string' },
      { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' },
      { name: 'verifyingContract', type: 'address' },
    ]);
  });

  it('signature recovers to the payer when the facilitator reconstructs the digest', async () => {
    const { provider, wallet, seen } = makeWalletProvider(PRIVATE_KEY);
    const envelope = await signEVMPayment(exactRequirement(), provider, wallet.address);
    const { authorization, signature } = envelope.payload as {
      authorization: Record<string, string>;
      signature: string;
    };

    // The facilitator hashes the token's real domain — not the wallet's guess.
    const domain = { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC };
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    const recovered = verifyTypedData(domain, types, authorization, signature);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());

    // The wallet-facing domain and the facilitator's must be the same struct.
    expect(seen[0].domain).toEqual(domain);
    expect(TypedDataEncoder.hashDomain(seen[0].domain)).toBe(TypedDataEncoder.hashDomain(domain));
  });
});
