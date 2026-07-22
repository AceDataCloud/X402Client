/**
 * Real E2E test: X402 payment flow on Solana.
 *
 * Flow: POST without auth → 402 → build Solana tx (facilitator fee payer) → partial sign → PAYMENT-SIGNATURE → retry
 *
 * Required env: X402B_SOLANA_PAYER_PRIVATE_KEY (base58 secret key)
 * Optional env: SOLANA_RPC_URL, X402B_SOLANA_FACILITATOR_ADDRESS, API_BASE
 * Loaded from (in order): process.env, ../../.claude/.env, ../../PlatformBackend/.env
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { signSolanaPayment } from '../src/solana.ts';

const SOLANA_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

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
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PAYER_PRIVATE_KEY = process.env.X402B_SOLANA_PAYER_PRIVATE_KEY?.trim();
if (!PAYER_PRIVATE_KEY) {
  console.error('ERROR: X402B_SOLANA_PAYER_PRIVATE_KEY is missing. Add it to .claude/.env or PlatformBackend/.env.');
  process.exit(1);
}

// Use a cheap API for testing (openai chat completion is fast + cheap)
const TEST_API_PATH = process.env.TEST_API_PATH || '/openai/chat/completions';
const TEST_BODY = process.env.TEST_BODY
  ? JSON.parse(process.env.TEST_BODY)
  : {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say hi in 3 words' }],
      max_tokens: 10,
    };

interface PaymentRequirement {
  scheme: string;
  network: string;
  amount?: string;
  maxAmountRequired?: string;
  maxTimeoutSeconds: number;
  resource: string;
  payTo: string;
  asset: string;
  extra?: {
    decimals?: number;
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: number;
    rpcUrl?: string;
    feePayer?: string;
    memo?: string;
  };
}

async function main() {
  // Reconstruct keypair from base58 secret
  const secretKey = bs58.decode(PAYER_PRIVATE_KEY);
  // @solana/web3.js v1 Keypair
  const { Keypair } = await import('@solana/web3.js');
  const payer = Keypair.fromSecretKey(secretKey);

  console.log('=== Real E2E X402 Test (Solana) ===');
  console.log(`Payer wallet: ${payer.publicKey.toBase58()}`);

  // Step 1: Request without auth → 402
  console.log('--- Step 1: POST without auth → expect 402 ---');
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

  const body402 = (await res1.json()) as { accepts: PaymentRequirement[] };
  const solReq = body402.accepts.find((a) => a.network === SOLANA_NETWORK);
  if (!solReq) {
    console.log(`ERROR: No ${SOLANA_NETWORK} network in 402 response`);
    console.log('Available:', body402.accepts.map((a) => a.network));
    process.exit(1);
  }
  const amountValue = solReq.amount ?? solReq.maxAmountRequired;
  if (!amountValue) {
    throw new Error(`Payment requirement for ${SOLANA_NETWORK} has no amount.`);
  }
  const amount = BigInt(amountValue);
  console.log(`✅ Got 402 with ${SOLANA_NETWORK} payment requirement`);
  console.log(`   Amount: ${amountValue} (${Number(amount) / 1e6} USDC)`);
  console.log(`   PayTo: ${solReq.payTo}`);
  console.log(`   Asset (USDC mint): ${solReq.asset}\n`);

  console.log('--- Step 2: Build and partially sign Solana transaction ---');
  const envelope = await signSolanaPayment(
    solReq,
    {
      publicKey: payer.publicKey,
      async signTransaction(value: unknown): Promise<VersionedTransaction> {
        const transaction = value as VersionedTransaction;
        transaction.sign([payer]);
        return transaction;
      },
    },
    SOLANA_RPC,
  );
  const serializedTx = 'transaction' in envelope.payload ? envelope.payload.transaction : '';
  console.log(`   Serialized tx length: ${serializedTx.length} chars\n`);

  // Step 3: Build PAYMENT-SIGNATURE header from the canonical signer envelope
  console.log('--- Step 3: Build PAYMENT-SIGNATURE envelope ---');
  const paymentSignature = btoa(JSON.stringify(envelope));
  console.log(`   PAYMENT-SIGNATURE header length: ${paymentSignature.length} chars\n`);

  // Step 4: Retry with PAYMENT-SIGNATURE header
  console.log('--- Step 4: Retry POST with PAYMENT-SIGNATURE ---');
  const res2 = await fetch(`${API_BASE}${TEST_API_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'PAYMENT-SIGNATURE': paymentSignature,
    },
    body: JSON.stringify(TEST_BODY),
  });

  console.log(`Status: ${res2.status}`);
  const headers2: Record<string, string> = {};
  res2.headers.forEach((v, k) => { headers2[k] = v; });
  console.log('Response headers:', JSON.stringify(headers2, null, 2));

  const body2 = await res2.text();
  console.log(`Body: ${body2.slice(0, 500)}\n`);

  if (res2.status === 200) {
    console.log('✅✅✅ FULL E2E SUCCESS — Solana X402 payment accepted! ✅✅✅');
  } else if (res2.status === 402) {
    console.log('⚠️  Got 402 again — facilitator verify rejected the payment.');
    console.log('   Check facilitator logs for details.');
  } else if (res2.status === 500) {
    console.log('⚠️  Got 500 — auth may have worked but upstream or settle failed.');
  } else {
    console.log(`⚠️  Unexpected status ${res2.status}`);
  }

  console.log('\n=== Test Complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
