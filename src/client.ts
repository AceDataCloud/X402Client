/**
 * X402 HTTP client.
 *
 * Wraps fetch to automatically handle 402 Payment Required responses:
 *   1. Send request
 *   2. If 402 → parse accepts → pick matching network → wallet sign → encode X-Payment
 *   3. Retry original request with X-Payment header
 */

import { signEVMPayment } from './evm.js';
import { signSolanaPayment } from './solana.js';
import type {
  PaymentRequiredResponse,
  PaymentRequirement,
  X402ClientOptions,
  X402PaymentEnvelope,
  X402Response,
} from './types.js';

function encodePaymentHeader(envelope: X402PaymentEnvelope): string {
  return btoa(JSON.stringify(envelope));
}

function selectRequirement(accepts: PaymentRequirement[], network: string): PaymentRequirement | undefined {
  return accepts.find((r) => r.network === network);
}

export function createX402Client(options: X402ClientOptions) {
  const { baseURL, network, solanaWallet, evmProvider, evmAddress } = options;
  const fetchFn = options.fetch ?? globalThis.fetch;

  async function signPayment(requirement: PaymentRequirement): Promise<X402PaymentEnvelope> {
    if (network === 'solana') {
      if (!solanaWallet) throw new Error('solanaWallet required for Solana network');
      return signSolanaPayment(requirement, solanaWallet);
    }
    // EVM networks: base, skale, etc.
    if (!evmProvider || !evmAddress) throw new Error('evmProvider and evmAddress required for EVM network');
    return signEVMPayment(requirement, evmProvider, evmAddress);
  }

  async function request<T = unknown>(
    path: string,
    init: RequestInit = {}
  ): Promise<X402Response<T>> {
    const url = path.startsWith('http') ? path : `${baseURL}${path}`;

    // First attempt
    const res = await fetchFn(url, init);

    if (res.status !== 402) {
      const data = await res.json() as T;
      return {
        status: res.status,
        data,
        headers: Object.fromEntries(res.headers.entries()),
        paid: false,
      };
    }

    // Parse 402 response
    const body = await res.json() as PaymentRequiredResponse;
    const accepts = body.accepts;
    if (!accepts?.length) {
      throw new Error('402 response has no payment requirements');
    }

    const requirement = selectRequirement(accepts, network);
    if (!requirement) {
      const available = accepts.map((a) => a.network).join(', ');
      throw new Error(`No payment requirement for network "${network}". Available: ${available}`);
    }

    // Sign payment
    const envelope = await signPayment(requirement);
    const xPaymentHeader = encodePaymentHeader(envelope);

    // Retry with X-Payment header
    const retryHeaders = new Headers(init.headers);
    retryHeaders.set('X-Payment', xPaymentHeader);

    const retryRes = await fetchFn(url, { ...init, headers: retryHeaders });
    const retryData = await retryRes.json() as T;

    return {
      status: retryRes.status,
      data: retryData,
      headers: Object.fromEntries(retryRes.headers.entries()),
      xPaymentHeader,
      paid: true,
    };
  }

  /** Convenience: POST JSON */
  async function post<T = unknown>(path: string, body: unknown): Promise<X402Response<T>> {
    return request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Convenience: GET */
  async function get<T = unknown>(path: string): Promise<X402Response<T>> {
    return request<T>(path, { method: 'GET' });
  }

  return { request, post, get };
}

export type X402Client = ReturnType<typeof createX402Client>;
