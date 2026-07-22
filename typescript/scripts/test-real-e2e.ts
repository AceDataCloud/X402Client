/**
 * Real E2E test: X402 payment flow with actual wallet signing.
 *
 * Flow: POST without auth → 402 → EIP-712 sign → PAYMENT-SIGNATURE header → retry
 *
 * Required env: X402B_BASE_PAYER_PRIVATE_KEY
 * Loaded from (in order): process.env, ../../.claude/.env, ../../PlatformBackend/.env
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

const BASE_NETWORK = 'eip155:8453';

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
loadEnvFile(resolve(scriptDir, '../../../.claude/.env'));
loadEnvFile(resolve(scriptDir, '../../../PlatformBackend/.env'));

const API_BASE = process.env.API_BASE || 'https://x402.acedata.cloud';
const TEST_API_PATH = process.env.TEST_API_PATH || '/suno/audios';
const TEST_BODY = process.env.TEST_BODY
  ? JSON.parse(process.env.TEST_BODY)
  : { prompt: 'a short test beat', make_instrumental: true };
const rawKey = process.env.X402B_BASE_PAYER_PRIVATE_KEY?.trim();
if (!rawKey) {
  console.error('ERROR: X402B_BASE_PAYER_PRIVATE_KEY is missing. Add it to .claude/.env or PlatformBackend/.env.');
  process.exit(1);
}
const PRIVATE_KEY = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;

interface PaymentRequirement {
  scheme: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
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
  };
}

function randomNonce32(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function main() {
  const wallet = new Wallet(PRIVATE_KEY);
  console.log('=== Real E2E X402 Test (Base/EVM) ===');
  console.log(`Payer wallet: ${wallet.address}\n`);

  // Step 1: Request without auth → 402
  console.log(`--- Step 1: POST ${TEST_API_PATH} without auth ---`);
  const res1 = await fetch(`${API_BASE}${TEST_API_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_BODY),
  });
  console.log(`Status: ${res1.status}`);
  if (res1.status !== 402) {
    console.log('ERROR: Expected 402, got', res1.status);
    process.exit(1);
  }

  const body402 = await res1.json() as { accepts: PaymentRequirement[] };
  const baseReq = body402.accepts.find((a: PaymentRequirement) => a.network === BASE_NETWORK);
  if (!baseReq) {
    console.log(`ERROR: No ${BASE_NETWORK} network in 402 response`);
    process.exit(1);
  }
  const amount = baseReq.amount ?? baseReq.maxAmountRequired;
  if (!amount) {
    throw new Error(`Payment requirement for ${BASE_NETWORK} has no amount.`);
  }
  console.log(`✅ Got 402 with ${BASE_NETWORK} payment requirement`);
  console.log(`   Amount: ${amount} (${Number(amount) / 1e6} USDC)`);
  console.log(`   PayTo: ${baseReq.payTo}`);
  console.log(`   Asset: ${baseReq.asset}\n`);

  // Step 2: Sign EIP-712 TransferWithAuthorization
  console.log('--- Step 2: Sign EIP-712 TransferWithAuthorization ---');
  const now = Math.floor(Date.now() / 1000);
  const maxTimeout = baseReq.maxTimeoutSeconds || 120;

  const authorization = {
    from: wallet.address,
    to: baseReq.payTo,
    value: BigInt(amount).toString(),
    validAfter: String(now),
    validBefore: String(now + maxTimeout),
    nonce: randomNonce32(),
  };

  const domain = {
    name: baseReq.extra?.name || 'USD Coin',
    version: baseReq.extra?.version || '2',
    chainId: baseReq.extra?.chainId || 8453,
    verifyingContract: baseReq.extra?.verifyingContract || baseReq.asset,
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  const signature = await wallet.signTypedData(domain, types, authorization);
  console.log(`✅ Signed EIP-712 message`);
  console.log(`   Signature: ${signature.slice(0, 20)}...${signature.slice(-10)}`);

  // Step 3: Build PAYMENT-SIGNATURE header
  const envelope = {
    x402Version: 2,
    accepted: baseReq,
    payload: {
      authorization,
      signature,
    },
  };

  const paymentSignature = btoa(JSON.stringify(envelope));
  console.log(`   PAYMENT-SIGNATURE header length: ${paymentSignature.length} chars\n`);

  // Step 4: Retry with PAYMENT-SIGNATURE header
  console.log(`--- Step 3: Retry POST ${TEST_API_PATH} with PAYMENT-SIGNATURE ---`);
  const res2 = await fetch(`${API_BASE}${TEST_API_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': paymentSignature,
    },
    body: JSON.stringify(TEST_BODY),
  });

  console.log(`Status: ${res2.status}`);
  const body2 = await res2.json();
  console.log(`Response: ${JSON.stringify(body2, null, 2).slice(0, 500)}`);

  if (res2.status === 200) {
    console.log('\n✅✅✅ FULL E2E SUCCESS — X402 payment accepted, Suno responded! ✅✅✅');
  } else if (res2.status === 402) {
    console.log('\n⚠️  Got 402 again — facilitator verify may have rejected the payment.');
    console.log('   This could mean:');
    console.log('   - Signature verification failed');
    console.log('   - Payment amount mismatch');
    console.log('   - Facilitator returned isValid=false');
  } else if (res2.status === 500) {
    console.log('\n⚠️  Got 500 — likely insufficient USDC for on-chain settlement.');
    console.log('   The signing + verify flow may have worked, but settlement failed.');
  } else {
    console.log(`\n⚠️  Unexpected status ${res2.status}`);
  }

  console.log('\n=== Test Complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
