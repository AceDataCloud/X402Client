import { createX402Client } from './client.js';
import { signEVMPayment } from './evm.js';
import type { EVMProvider, PaymentRequirement, X402ClientOptions } from './types.js';

export interface SKALEClientOptions
  extends Omit<X402ClientOptions, 'network' | 'solanaWallet'> {
  baseURL: string;
  evmProvider: EVMProvider;
  evmAddress: string;
}

export function createSKALEClient(options: SKALEClientOptions) {
  return createX402Client({
    ...options,
    network: 'skale',
  });
}

export function signSKALEPayment(
  requirements: PaymentRequirement,
  provider: EVMProvider,
  address: string
) {
  return signEVMPayment(
    {
      ...requirements,
      network: 'skale',
    },
    provider,
    address
  );
}
