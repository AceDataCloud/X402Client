/**
 * One-time ERC-20 `approve(Permit2, amount)` helper for the `upto` scheme.
 *
 * The Permit2 contract must be allowed to pull the payer's USDC before any
 * `PermitWitnessTransferFrom` signature is settle-able on-chain. Each payer
 * needs to do this exactly once per (token, chain).
 *
 * `ethers` is imported lazily so that browsers / serverless functions that
 * only sign (and never broadcast) don't pull it into their bundle. Install
 * `ethers@^6` to use this helper.
 */

import { PERMIT2_ADDRESS } from './evm.js';

/** Approval result. `skipped: true` means the allowance was already sufficient. */
export interface ApprovePermit2Result {
  skipped: boolean;
  txHash?: string;
  allowanceBefore: string;
  allowanceAfter: string;
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const UINT256_MAX = (1n << 256n) - 1n;

export interface ApprovePermit2Options {
  /** HTTP(S) RPC endpoint for the target EVM chain. */
  rpcUrl: string;
  /** Hex private key (with or without `0x` prefix). */
  privateKey: string;
  /** ERC-20 token contract (USDC on Base is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). */
  tokenAddress: string;
  /** Allowance to set. Defaults to `2**256 - 1` (the Uniswap/x402 convention). */
  amount?: bigint;
  /** Override Permit2 address (defaults to the canonical CREATE2 deployment). */
  permit2Address?: string;
}

/**
 * Submit a one-time `ERC20.approve(Permit2, amount)` transaction.
 *
 * Idempotent: if the existing allowance already meets or exceeds `amount`,
 * no transaction is broadcast and `skipped: true` is returned.
 */
export async function approvePermit2(opts: ApprovePermit2Options): Promise<ApprovePermit2Result> {
  // Lazy import — see file docstring.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ethers: any = await import('ethers');

  const amount = opts.amount ?? UINT256_MAX;
  const permit2Address = opts.permit2Address ?? PERMIT2_ADDRESS;
  const pk = opts.privateKey.startsWith('0x') ? opts.privateKey : `0x${opts.privateKey}`;

  const provider = new ethers.JsonRpcProvider(opts.rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  const erc20 = new ethers.Contract(opts.tokenAddress, ERC20_ABI, wallet);

  const before: bigint = await erc20.allowance(wallet.address, permit2Address);
  if (before >= amount) {
    return {
      skipped: true,
      allowanceBefore: before.toString(),
      allowanceAfter: before.toString(),
    };
  }

  const tx = await erc20.approve(permit2Address, amount);
  const receipt = await tx.wait();
  const after: bigint = await erc20.allowance(wallet.address, permit2Address);

  return {
    skipped: false,
    txHash: receipt?.hash ?? tx.hash,
    allowanceBefore: before.toString(),
    allowanceAfter: after.toString(),
  };
}
