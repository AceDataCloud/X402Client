import { createX402Client } from './client.js';
import { signEVMPayment } from './evm.js';
import type { EVMProvider, PaymentRequirement, X402ClientOptions } from './types.js';

export interface BaseClientOptions
  extends Omit<X402ClientOptions, 'network' | 'solanaWallet'> {
  baseURL: string;
  evmProvider: EVMProvider;
  evmAddress: string;
}

export function createBaseClient(options: BaseClientOptions) {
  return createX402Client({
    ...options,
    network: 'base',
  });
}

export function signBasePayment(
  requirements: PaymentRequirement,
  provider: EVMProvider,
  address: string
) {
  return signEVMPayment(
    {
      ...requirements,
      network: 'base',
    },
    provider,
    address
  );
}
