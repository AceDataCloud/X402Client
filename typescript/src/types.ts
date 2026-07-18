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
    feePayer?: string;
    memo?: string;
    // Fields used by the `upto` (Permit2) scheme:
    facilitatorAddress?: string;
    proxyAddress?: string;
    permit2Address?: string;
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
  payload: SolanaPayload | EVMPayload | EVMUptoPayload;
}

/** Solana payload: facilitator-fee-payer, partially signed serialized transaction. */
export interface SolanaPayload {
  transaction: string;
}

/** EVM payload (`exact` scheme): EIP-3009 TransferWithAuthorization + ECDSA signature. */
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

/** EVM payload (`upto` scheme): Permit2 PermitWitnessTransferFrom + ECDSA signature. */
export interface EVMUptoPayload {
  permit2Authorization: Permit2WitnessAuthorization;
  signature: string;
}

export interface Permit2WitnessAuthorization {
  from: string;
  spender: string;
  nonce: string;
  deadline: string;
  permitted: { token: string; amount: string };
  witness: { to: string; facilitator: string; validAfter: string };
}

/** Wallet adapter interface for Solana. */
export interface SolanaWalletAdapter {
  publicKey: { toBase58(): string; toString(): string };
  /** Wallet adds the payer signature without broadcasting the transaction. */
  signTransaction?: (tx: unknown) => Promise<unknown>;
  /** @deprecated Broadcasting before the protected request is unsafe; migrate to signTransaction. */
  signAndSendTransaction?: (tx: unknown) => Promise<string>;
}

/** Wallet adapter interface for EVM (EIP-1193 provider). */
export interface EVMProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
