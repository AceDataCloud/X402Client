import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';

import { signEVMPayment } from '../src/evm.js';
import type { EVMProvider, PaymentRequirement } from '../src/types.js';

const PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

describe('EVM exact payment', () => {
  it('uses an immediately valid EIP-3009 authorization', async () => {
    const wallet = new Wallet(PRIVATE_KEY);
    const provider: EVMProvider = {
      async request({ method, params }) {
        if (method !== 'eth_signTypedData_v4') throw new Error(`Unexpected method: ${method}`);
        const typedData = JSON.parse(String(params?.[1]));
        return wallet.signTypedData(typedData.domain, typedData.types, typedData.message);
      },
    };
    const requirement: PaymentRequirement = {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '952',
      maxTimeoutSeconds: 120,
      resource: '/serp/google',
      description: 'test',
      payTo: '0x4d2f00dac0acb02c7211cbde2dbe9d86d7b7b2f2',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      extra: {
        name: 'USD Coin',
        version: '2',
        chainId: 8453,
        verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
    };

    const envelope = await signEVMPayment(requirement, provider, wallet.address);
    const payload = envelope.payload as { authorization: { validAfter: string; validBefore: string } };

    expect(payload.authorization.validAfter).toBe('0');
    expect(Number(payload.authorization.validBefore)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});