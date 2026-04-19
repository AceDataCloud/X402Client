/**
 * EVM X402 payment signing (EIP-712 TransferWithAuthorization).
 *
 * Works with any EIP-1193 provider (MetaMask, WalletConnect, etc.).
 */

import type { EVMAuthorization, EVMPayload, EVMProvider, PaymentRequirement, X402PaymentEnvelope } from './types.js';

function randomNonce32(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function buildTypedData(requirements: PaymentRequirement, authorization: EVMAuthorization) {
  return {
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization' as const,
    domain: {
      name: requirements.extra?.name || 'USD Coin',
      version: requirements.extra?.version || '2',
      chainId: requirements.extra?.chainId || 8453,
      verifyingContract: requirements.extra?.verifyingContract || requirements.asset,
    },
    message: authorization,
  };
}

export async function signEVMPayment(
  requirements: PaymentRequirement,
  provider: EVMProvider,
  address: string
): Promise<X402PaymentEnvelope> {
  const now = Math.floor(Date.now() / 1000);
  const maxTimeout = requirements.maxTimeoutSeconds || 120;
  const value = BigInt(requirements.maxAmountRequired).toString();

  const authorization: EVMAuthorization = {
    from: address,
    to: requirements.payTo,
    value,
    validAfter: String(now),
    validBefore: String(now + maxTimeout),
    nonce: randomNonce32(),
  };

  const typedData = buildTypedData(requirements, authorization);

  const signature = (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [address, JSON.stringify(typedData)],
  })) as string;

  const payload: EVMPayload = { authorization, signature };

  return {
    x402Version: 2,
    scheme: requirements.scheme || 'exact',
    network: requirements.network || 'base',
    payload,
  };
}
