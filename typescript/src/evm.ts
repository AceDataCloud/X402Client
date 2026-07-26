/**
 * EVM X402 payment signing.
 *
 * Two schemes are supported and produce different envelopes:
 *
 * - `exact` — EIP-3009 `TransferWithAuthorization` against the token's own
 *   EIP-712 domain. Pre-authorises the exact amount in the 402 response.
 * - `upto`  — Permit2 `PermitWitnessTransferFrom` against the Permit2 EIP-712
 *   domain, with the AceData upto-proxy as spender. The signer authorises a
 *   ceiling; the facilitator settles for any amount ≤ that ceiling at /record
 *   time (zero settles with no on-chain transaction).
 *
 * Both work with any EIP-1193 provider (MetaMask, WalletConnect, etc.) — only
 * `eth_signTypedData_v4` is used.
 */

import type {
  EVMAuthorization,
  EVMPayload,
  EVMProvider,
  EVMUptoPayload,
  PaymentRequirement,
  Permit2WitnessAuthorization,
  X402PaymentEnvelope,
} from './types.js';

/** Canonical CREATE2 deployment of the Uniswap Permit2 contract. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/** Canonical CREATE2 deployment of the AceData upto-proxy spender. */
export const X402_UPTO_PERMIT2_PROXY_ADDRESS = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';
const VALID_AFTER_SKEW_SECONDS = 30;

function randomNonce32(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Uniformly random uint256 nonce for Permit2 (decimal string, no leading zeros). */
function randomPermit2Nonce(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value.toString();
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
  // Default matches the official x402 SDK (3600s) and this package's upto path;
  // the server's 402 normally supplies the value.
  const maxTimeout = requirements.maxTimeoutSeconds || 3600;
  const value = BigInt(requirements.amount ?? requirements.maxAmountRequired ?? '0').toString();

  const authorization: EVMAuthorization = {
    from: address,
    to: requirements.payTo,
    value,
    validAfter: '0',
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
    accepted: requirements,
    payload,
  };
}

/**
 * Build the Permit2 `PermitWitnessTransferFrom` typed-data object.
 *
 * Mirrors the Python reference (`acedatacloud_x402.signing.evm._build_upto_typed_data`)
 * and the facilitator's `chain_handlers.upto_constants.build_upto_permit2_typed_data`
 * byte-for-byte: any drift breaks signature recovery.
 *
 * Critical:
 *   - The Permit2 EIP-712 domain has **no** `version` field. Adding one
 *     changes the digest and the facilitator recovers a different signer.
 *   - The witness struct is named `Witness` (NOT `X402Witness`).
 *   - The token's own domain is irrelevant — Permit2 holds the allowance.
 */
export function buildUptoTypedData(
  requirements: PaymentRequirement,
  params: {
    from: string;
    permittedAmount: bigint | string | number;
    nonce: bigint | string | number;
    deadline: bigint | string | number;
    validAfter: bigint | string | number;
  }
) {
  const extra = requirements.extra ?? {};
  const facilitatorAddress = extra.facilitatorAddress;
  if (!facilitatorAddress) {
    throw new Error(
      'PaymentRequirement.extra.facilitatorAddress is required for the upto scheme'
    );
  }
  const permit2Address = extra.permit2Address ?? PERMIT2_ADDRESS;
  const spender = extra.proxyAddress ?? X402_UPTO_PERMIT2_PROXY_ADDRESS;
  const verifyingContract = extra.verifyingContract ?? permit2Address;
  const chainId = extra.chainId ?? 8453;

  return {
    types: {
      PermitWitnessTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'witness', type: 'Witness' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      Witness: [
        { name: 'to', type: 'address' },
        { name: 'facilitator', type: 'address' },
        { name: 'validAfter', type: 'uint256' },
      ],
    },
    primaryType: 'PermitWitnessTransferFrom' as const,
    domain: {
      name: extra.name || 'Permit2',
      chainId,
      verifyingContract,
    },
    message: {
      permitted: { token: requirements.asset, amount: params.permittedAmount.toString() },
      spender,
      nonce: params.nonce.toString(),
      deadline: params.deadline.toString(),
      witness: {
        to: requirements.payTo,
        facilitator: facilitatorAddress,
        validAfter: params.validAfter.toString(),
      },
    },
  };
}

/**
 * Sign a Permit2 `PermitWitnessTransferFrom` envelope (`upto` scheme).
 *
 * `requirements.maxAmountRequired` is the **ceiling** the payer signs over.
 * The facilitator may settle any amount `≤` that ceiling at `/record` time.
 *
 * The signer must have already approved Permit2 to pull the token —
 * see {@link approvePermit2} for the one-time on-chain approval.
 */
export async function signEVMUptoPayment(
  requirements: PaymentRequirement,
  provider: EVMProvider,
  address: string,
  opts: { validAfter?: number; deadlineBuffer?: number; nonce?: bigint | string } = {}
): Promise<X402PaymentEnvelope> {
  const now = Math.floor(Date.now() / 1000);
  const validAfter = opts.validAfter ?? now - VALID_AFTER_SKEW_SECONDS;
  const timeout = opts.deadlineBuffer ?? requirements.maxTimeoutSeconds ?? 3600;
  const deadline = (opts.validAfter ?? now) + timeout;
  const nonce = opts.nonce ?? randomPermit2Nonce();
  const permittedAmount = BigInt(requirements.amount ?? requirements.maxAmountRequired ?? '0').toString();

  const typedData = buildUptoTypedData(requirements, {
    from: address,
    permittedAmount,
    nonce,
    deadline,
    validAfter,
  });

  const signature = (await provider.request({
    method: 'eth_signTypedData_v4',
    params: [address, JSON.stringify(typedData)],
  })) as string;

  const extra = requirements.extra ?? {};
  const spender = extra.proxyAddress ?? X402_UPTO_PERMIT2_PROXY_ADDRESS;
  const facilitatorAddress = extra.facilitatorAddress!;

  const permit2Authorization: Permit2WitnessAuthorization = {
    from: address,
    spender,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    permitted: { token: requirements.asset, amount: permittedAmount },
    witness: {
      to: requirements.payTo,
      facilitator: facilitatorAddress,
      validAfter: validAfter.toString(),
    },
  };

  const payload: EVMUptoPayload = { permit2Authorization, signature };

  return {
    x402Version: 2,
    accepted: requirements,
    payload,
  };
}

