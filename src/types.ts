/**
 * X402 payment protocol types.
 */

/** Payment requirement returned by the server in the 402 response. */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
  payTo: string;
  asset: string;
  extra?: {
    name?: string;
    version?: string;
    chainId?: number;
    verifyingContract?: string;
    decimals?: number;
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: number;
    rpcUrl?: string;
  };
}

/** Full 402 response body. */
export interface PaymentRequiredResponse {
  x402Version: number;
  accepts: PaymentRequirement[];
  error?: string;
}

/** The X-Payment header envelope before base64 encoding. */
export interface X402PaymentEnvelope {
  x402Version: number;
  scheme: string;
  network: string;
  payload: SolanaPayload | EVMPayload;
}

/** Solana payload: just the on-chain transaction signature. */
export interface SolanaPayload {
  signature: string;
}

/** EVM payload: EIP-712 authorization + ECDSA signature. */
export interface EVMPayload {
  authorization: EVMAuthorization;
  signature: string;
}

export interface EVMAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** Wallet adapter interface for Solana. */
export interface SolanaWalletAdapter {
  publicKey: { toBase58(): string; toString(): string };
  signAndSendTransaction(tx: unknown): Promise<string | { signature: string }>;
}

/** Wallet adapter interface for EVM (EIP-1193 provider). */
export interface EVMProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Options for creating an X402 client. */
export interface X402ClientOptions {
  /** Base URL of the API (e.g. https://api.acedata.cloud) */
  baseURL: string;
  /** Preferred payment network */
  network: 'solana' | 'base' | 'skale';
  /** Solana wallet adapter (required if network=solana) */
  solanaWallet?: SolanaWalletAdapter;
  /** EVM EIP-1193 provider (required if network=base/skale) */
  evmProvider?: EVMProvider;
  /** EVM account address (required if network=base/skale) */
  evmAddress?: string;
  /** Custom fetch implementation */
  fetch?: typeof globalThis.fetch;
}

/** Result of a successful X402-wrapped request. */
export interface X402Response<T = unknown> {
  status: number;
  data: T;
  headers: Record<string, string>;
  /** The X-Payment header that was sent (base64) */
  xPaymentHeader?: string;
  /** Whether a 402→retry cycle occurred */
  paid: boolean;
}
