/**
 * SDK adapter: turn X402 wallet configuration into a `PaymentHandler`
 * compatible with `@acedatacloud/sdk`.
 *
 * Usage:
 *
 *   import { AceDataCloud } from '@acedatacloud/sdk';
 *   import { createX402PaymentHandler } from '@acedatacloud/x402-client';
 *
 *   const client = new AceDataCloud({
 *     paymentHandler: createX402PaymentHandler({
 *       network: 'base',
 *       evmProvider: window.ethereum,
 *       evmAddress: '0x...',
 *     }),
 *   });
 *
 *   // Normal SDK calls work — no Bearer token needed.
 *   await client.openai.chat.completions.create({ ... });
 */

import { signEVMPayment, signEVMUptoPayment } from './evm.js';
import { signSolanaPayment } from './solana.js';
import type {
  EVMProvider,
  PaymentRequirement,
  SolanaWalletAdapter,
  X402PaymentEnvelope,
} from './types.js';

/** Options for `createX402PaymentHandler`. */
export interface X402PaymentHandlerOptions {
  /** Preferred payment network. */
  network: 'solana' | 'base' | 'skale';
  /** Solana wallet adapter (required if network=solana). */
  solanaWallet?: SolanaWalletAdapter;
  /** Optional Solana RPC used only to fetch a recent blockhash. */
  solanaRpcUrl?: string;
  /** EVM EIP-1193 provider (required if network=base/skale). */
  evmProvider?: EVMProvider;
  /** EVM account address (required if network=base/skale). */
  evmAddress?: string;
  /**
   * When the server offers multiple schemes for the chosen network, prefer
   * this one. Use `"upto"` for metered chat APIs (Permit2-based, settles for
   * the actual usage) and `"exact"` for fixed-price endpoints. Falls back to
   * the first available accept entry when the preferred scheme is absent.
   */
  preferScheme?: 'exact' | 'upto';
}

/** Minimal shape of the SDK's PaymentHandler context. Duplicated here
 *  so this package does not need a dependency on `@acedatacloud/sdk`. */
interface SdkPaymentHandlerContext {
  url: string;
  method: string;
  body?: unknown;
  accepts: PaymentRequirement[];
}

interface SdkPaymentHandlerResult {
  headers: Record<string, string>;
}

function encodePaymentHeader(envelope: X402PaymentEnvelope): string {
  // Browser-first; fall back to Buffer in Node.
  if (typeof btoa === 'function') {
    return btoa(JSON.stringify(envelope));
  }
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}

function selectRequirement(
  accepts: PaymentRequirement[],
  network: string,
  preferScheme?: string
): PaymentRequirement | undefined {
  const matches = accepts.filter((r) => r.network === network);
  if (matches.length === 0) return undefined;
  if (preferScheme) {
    const preferred = matches.find((r) => r.scheme === preferScheme);
    if (preferred) return preferred;
  }
  return matches[0];
}

/**
 * Build a `PaymentHandler` function that `@acedatacloud/sdk` can invoke
 * when the API returns `402 Payment Required`.
 */
export function createX402PaymentHandler(
  options: X402PaymentHandlerOptions
): (ctx: SdkPaymentHandlerContext) => Promise<SdkPaymentHandlerResult> {
  const { network, solanaWallet, solanaRpcUrl, evmProvider, evmAddress, preferScheme } = options;

  if (network === 'solana' && !solanaWallet) {
    throw new Error('solanaWallet is required when network="solana"');
  }
  if ((network === 'base' || network === 'skale') && (!evmProvider || !evmAddress)) {
    throw new Error('evmProvider and evmAddress are required for EVM networks');
  }

  return async function x402PaymentHandler(ctx: SdkPaymentHandlerContext) {
    const requirement = selectRequirement(ctx.accepts, network, preferScheme);
    if (!requirement) {
      const available = ctx.accepts.map((a) => a.network).join(', ') || '<none>';
      throw new Error(
        `X402: no payment requirement for network "${network}". Available: ${available}`
      );
    }

    let envelope: X402PaymentEnvelope;
    if (network === 'solana') {
      envelope = await signSolanaPayment(requirement, solanaWallet!, solanaRpcUrl);
    } else if (requirement.scheme === 'upto') {
      envelope = await signEVMUptoPayment(requirement, evmProvider!, evmAddress!);
    } else {
      envelope = await signEVMPayment(requirement, evmProvider!, evmAddress!);
    }
    return { headers: { 'X-Payment': encodePaymentHeader(envelope) } };
  };
}
