#!/usr/bin/env node
/**
 * CLI: `npx tsx scripts/approve-permit2.ts --network base`
 *
 * One-time ERC-20 `approve(Permit2, ∞)` on behalf of the payer wallet. Required
 * exactly once per (payer, token, chain) before any `upto`-scheme x402 payment
 * is settle-able on-chain.
 *
 * Loads the payer key from (in order):
 *   1. `--private-key <hex>`
 *   2. `$X402_PRIVATE_KEY`
 *   3. `$X402B_BASE_PAYER_PRIVATE_KEY` (matches the other e2e scripts)
 *   4. `.claude/.env`, `PlatformBackend/.env` (auto-loaded if present)
 *
 * Idempotent: skips the broadcast if the allowance is already sufficient.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { approvePermit2, PERMIT2_ADDRESS } from '../src/index.js';

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
loadEnvFile(resolve(scriptDir, '../../../.claude/.env'));
loadEnvFile(resolve(scriptDir, '../../../PlatformBackend/.env'));

const USDC_BY_NETWORK: Record<string, string> = {
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  skale: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
};

const DEFAULT_RPC: Record<string, string> = {
  base: 'https://mainnet.base.org',
  'base-sepolia': 'https://sepolia.base.org',
  skale: 'https://mainnet.skalenodes.com/v1/elated-tan-skat',
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const network = args.network || 'base';
  const rpcUrl = args['rpc-url'] || DEFAULT_RPC[network];
  if (!rpcUrl) {
    console.error(`error: no default RPC for network "${network}", pass --rpc-url`);
    process.exit(2);
  }
  const tokenAddress = args.token || USDC_BY_NETWORK[network];
  if (!tokenAddress) {
    console.error(`error: no default token for network "${network}", pass --token`);
    process.exit(2);
  }
  const permit2Address = args['permit2-address'] || PERMIT2_ADDRESS;
  const privateKey =
    args['private-key'] ||
    process.env.X402_PRIVATE_KEY ||
    process.env.X402B_BASE_PAYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error(
      'error: missing private key. Pass --private-key or set X402_PRIVATE_KEY / X402B_BASE_PAYER_PRIVATE_KEY.'
    );
    process.exit(2);
  }
  const amount = args.amount ? BigInt(args.amount) : undefined;

  const result = await approvePermit2({
    rpcUrl,
    privateKey,
    tokenAddress,
    permit2Address,
    amount,
  });
  console.log(
    JSON.stringify({ network, rpcUrl, token: tokenAddress, permit2: permit2Address, ...result }, null, 2)
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
