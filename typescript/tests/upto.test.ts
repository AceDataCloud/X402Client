/**
 * Tests for the EVM `upto` (Permit2) signing path.
 *
 * Mirrors `python/tests/test_upto.py` exactly so a divergence in either
 * implementation surfaces in CI on both sides.
 */

import { describe, expect, it } from 'vitest';
import { Wallet, TypedDataEncoder, verifyTypedData } from 'ethers';

import {
  PERMIT2_ADDRESS,
  X402_UPTO_PERMIT2_PROXY_ADDRESS,
  buildUptoTypedData,
  signEVMUptoPayment,
  createX402PaymentHandler,
} from '../src/index.js';
import type { EVMProvider, PaymentRequirement } from '../src/index.js';

// Test vector — ethers.js docs throwaway key. NEVER use in production.
const TEST_PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const TEST_ADDRESS = new Wallet(TEST_PRIVATE_KEY).address;
const FACILITATOR_ADDR = '0x1111111111111111111111111111111111111111';
const PAY_TO_ADDR = '0x4f0e2d3477a1b94cf33d16e442cee4733dadcee7';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function uptoRequirement(
  overrides: Partial<PaymentRequirement> = {}
): PaymentRequirement {
  return {
    scheme: 'upto',
    network: 'eip155:8453',
    amount: '4760750',
    maxTimeoutSeconds: 3600,
    resource: 'https://x402.acedata.cloud/openai/chat/completions',
    description: 'AceDataCloud API call (metered)',
    payTo: PAY_TO_ADDR,
    asset: USDC_BASE,
    extra: {
      name: 'Permit2',
      chainId: 8453,
      verifyingContract: PERMIT2_ADDRESS,
      permit2Address: PERMIT2_ADDRESS,
      proxyAddress: X402_UPTO_PERMIT2_PROXY_ADDRESS,
      facilitatorAddress: FACILITATOR_ADDR,
    },
    ...overrides,
  };
}

/** Minimal EIP-1193 provider backed by an ethers Wallet (for offline tests). */
function makeWalletProvider(privateKey: string): { provider: EVMProvider; address: string } {
  const wallet = new Wallet(privateKey);
  const provider: EVMProvider = {
    async request(args) {
      if (args.method !== 'eth_signTypedData_v4') {
        throw new Error(`Unsupported method ${args.method}`);
      }
      const [, payload] = args.params as [string, string];
      const typed = JSON.parse(payload) as {
        domain: Record<string, unknown>;
        types: Record<string, Array<{ name: string; type: string }>>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      // The wire payload MUST declare EIP712Domain: MetaMask silently substitutes
      // an empty domain when it is absent, producing an unrecoverable signature.
      expect(typed.types.EIP712Domain).toBeDefined();
      // ethers derives the domain itself and rejects an explicit EIP712Domain.
      const { primaryType, types, ...rest } = typed;
      void primaryType;
      const { EIP712Domain: _domainTypes, ...structTypes } = types;
      return wallet.signTypedData(rest.domain, structTypes, rest.message);
    },
  };
  return { provider, address: wallet.address };
}

describe('upto envelope', () => {
  it('has the expected shape', async () => {
    const { provider, address } = makeWalletProvider(TEST_PRIVATE_KEY);
    const envelope = await signEVMUptoPayment(uptoRequirement(), provider, address);

    expect(envelope.x402Version).toBe(2);
    expect(envelope.accepted.scheme).toBe('upto');
    expect(envelope.accepted.network).toBe('eip155:8453');

    const payload = envelope.payload as {
      permit2Authorization: Record<string, unknown>;
      signature: string;
    };
    expect(Object.keys(payload).sort()).toEqual(['permit2Authorization', 'signature']);
    expect(payload.signature.startsWith('0x')).toBe(true);
    expect(payload.signature.length).toBe(132); // 65 bytes hex + '0x'

    const auth = payload.permit2Authorization as {
      from: string;
      spender: string;
      permitted: { token: string; amount: string };
      witness: { to: string; facilitator: string; validAfter: string };
      nonce: string;
      deadline: string;
    };
    expect(auth.from.toLowerCase()).toBe(address.toLowerCase());
    expect(auth.spender).toBe(X402_UPTO_PERMIT2_PROXY_ADDRESS);
    expect(auth.permitted.token).toBe(USDC_BASE);
    expect(auth.permitted.amount).toBe('4760750'); // ceiling preserved verbatim
    expect(auth.witness.to).toBe(PAY_TO_ADDR);
    expect(auth.witness.facilitator).toBe(FACILITATOR_ADDR);
    expect(/^\d+$/.test(auth.nonce)).toBe(true);
    expect(/^\d+$/.test(auth.deadline)).toBe(true);
    expect(/^\d+$/.test(auth.witness.validAfter)).toBe(true);
    expect(BigInt(auth.deadline) > BigInt(auth.witness.validAfter)).toBe(true);
  });

  it('backdates default validAfter while preserving the deadline window', async () => {
    const { provider, address } = makeWalletProvider(TEST_PRIVATE_KEY);
    const before = Math.floor(Date.now() / 1000);
    const envelope = await signEVMUptoPayment(
      uptoRequirement({ network: 'eip155:1187947933' }),
      provider,
      address
    );
    const after = Math.floor(Date.now() / 1000);
    const auth = (envelope.payload as {
      permit2Authorization: { deadline: string; witness: { validAfter: string } };
    }).permit2Authorization;

    expect(Number(auth.witness.validAfter)).toBeGreaterThanOrEqual(before - 30);
    expect(Number(auth.witness.validAfter)).toBeLessThanOrEqual(after - 30);
    expect(Number(auth.deadline)).toBeGreaterThanOrEqual(before + 3600);
    expect(Number(auth.deadline)).toBeLessThanOrEqual(after + 3600);
  });

  it('signature recovers to the payer when the facilitator reconstructs the typed data', async () => {
    const { provider, address } = makeWalletProvider(TEST_PRIVATE_KEY);
    const req = uptoRequirement();
    const envelope = await signEVMUptoPayment(req, provider, address, {
      nonce: 42n,
      validAfter: 1_700_000_000,
    });
    const auth = (envelope.payload as {
      permit2Authorization: {
        from: string;
        permitted: { amount: string };
        nonce: string;
        deadline: string;
        witness: { validAfter: string };
      };
      signature: string;
    }).permit2Authorization;
    const signature = (envelope.payload as { signature: string }).signature;

    // Reconstruct typed data the same way the facilitator does.
    const typed = buildUptoTypedData(req, {
      from: auth.from,
      permittedAmount: auth.permitted.amount,
      nonce: auth.nonce,
      deadline: auth.deadline,
      validAfter: auth.witness.validAfter,
    });

    // ethers derives the domain itself and rejects an explicit EIP712Domain.
    const { EIP712Domain: _domainTypes, ...structTypes } = typed.types;

    const recovered = verifyTypedData(typed.domain, structTypes, typed.message, signature);
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());

    // And the digest is reproducible.
    const digest = TypedDataEncoder.hash(typed.domain, structTypes, typed.message);
    expect(digest.startsWith('0x')).toBe(true);
    expect(digest.length).toBe(66);
  });

  it('Permit2 EIP-712 domain MUST omit the version field', () => {
    const typed = buildUptoTypedData(uptoRequirement(), {
      from: '0x0000000000000000000000000000000000000001',
      permittedAmount: 1n,
      nonce: 1n,
      deadline: 2n,
      validAfter: 1n,
    });
    expect(Object.keys(typed.domain).sort()).toEqual(['chainId', 'name', 'verifyingContract']);
    expect(typed.domain.name).toBe('Permit2');
    expect(typed.domain.verifyingContract).toBe(PERMIT2_ADDRESS);
  });

  it('throws when extra.facilitatorAddress is missing', async () => {
    const { provider, address } = makeWalletProvider(TEST_PRIVATE_KEY);
    const req = uptoRequirement();
    delete req.extra!.facilitatorAddress;
    await expect(signEVMUptoPayment(req, provider, address)).rejects.toThrow(
      /facilitatorAddress/
    );
  });
});

describe('createX402PaymentHandler with preferScheme', () => {
  const exactReq: PaymentRequirement = {
    scheme: 'exact',
    network: 'eip155:8453',
    amount: '95215',
    maxTimeoutSeconds: 120,
    resource: 'https://x402.acedata.cloud/glm/chat/completions',
    description: 'fixed price',
    payTo: PAY_TO_ADDR,
    asset: USDC_BASE,
    extra: {
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: USDC_BASE,
    },
  };

  it('picks upto when offered and requested', async () => {
    const { provider, address } = makeWalletProvider(TEST_PRIVATE_KEY);
    const handler = createX402PaymentHandler({
      network: 'base',
      evmProvider: provider,
      evmAddress: address,
      preferScheme: 'upto',
    });

    const result = await handler({
      url: '',
      method: 'POST',
      accepts: [exactReq, uptoRequirement()],
    });
    const decoded = JSON.parse(
      Buffer.from(result.headers['PAYMENT-SIGNATURE'], 'base64').toString('utf8')
    ) as { accepted: PaymentRequirement; payload: Record<string, unknown> };
    expect(decoded.accepted.scheme).toBe('upto');
    expect(decoded.accepted.network).toBe('eip155:8453');
    expect('permit2Authorization' in decoded.payload).toBe(true);
  });

  it('falls back to exact when upto is unavailable', async () => {
    const { provider, address } = makeWalletProvider(TEST_PRIVATE_KEY);
    const handler = createX402PaymentHandler({
      network: 'base',
      evmProvider: provider,
      evmAddress: address,
      preferScheme: 'upto',
    });

    const result = await handler({
      url: '',
      method: 'POST',
      accepts: [exactReq],
    });
    const decoded = JSON.parse(
      Buffer.from(result.headers['PAYMENT-SIGNATURE'], 'base64').toString('utf8')
    ) as { accepted: PaymentRequirement; payload: Record<string, unknown> };
    expect(decoded.accepted.scheme).toBe('exact');
    expect(decoded.accepted.network).toBe('eip155:8453');
    expect('authorization' in decoded.payload).toBe(true);
  });
});
