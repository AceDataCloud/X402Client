/**
 * Live E2E test: X402 `upto` (Permit2) payment flow against a real chat API.
 *
 * Flow:
 *   1. POST without auth → 402 with `accepts: [exact, upto]`
 *   2. Build PermitWitnessTransferFrom typed data → sign with the payer wallet
 *   3. Retry with `X-Payment` header → 200 + worker-served chat response
 *   4. Print the gateway-supplied trace ID and (later) the BaseScan settle tx
 *
 * Prereqs:
 *   - `X402B_BASE_PAYER_PRIVATE_KEY` in env (auto-loaded from `.claude/.env`)
 *   - One-time `approvePermit2` already run for the payer + USDC + Base
 *
 * Run: `cd typescript && npx tsx scripts/test-upto-e2e.ts`
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

import { signEVMUptoPayment } from '../src/index.js';
import type { EVMProvider, PaymentRequirement } from '../src/index.js';

function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    let v = trimmed.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
loadEnvFile(resolve(scriptDir, '../../../.claude/.env'));
loadEnvFile(resolve(scriptDir, '../../../PlatformBackend/.env'));

const API_BASE = process.env.API_BASE || 'https://api.acedata.cloud';
const TEST_API_PATH = process.env.TEST_API_PATH || '/v1/chat/completions';
const TEST_BODY = process.env.TEST_BODY
  ? JSON.parse(process.env.TEST_BODY)
  : {
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      max_tokens: 40,
    };

const rawKey = process.env.X402B_BASE_PAYER_PRIVATE_KEY?.trim();
if (!rawKey) {
  console.error(
    'ERROR: X402B_BASE_PAYER_PRIVATE_KEY is missing. Add it to .claude/.env or PlatformBackend/.env.'
  );
  process.exit(1);
}
const PRIVATE_KEY = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;

function makeWalletProvider(privateKey: string): {
  provider: EVMProvider;
  address: string;
} {
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
        message: Record<string, unknown>;
      };
      return wallet.signTypedData(typed.domain, typed.types, typed.message);
    },
  };
  return { provider, address: wallet.address };
}

async function main(): Promise<void> {
  const { provider, address } = makeWalletProvider(PRIVATE_KEY);
  console.log('=== Live X402 upto E2E (Base mainnet) ===');
  console.log(`Payer wallet: ${address}`);
  console.log(`Endpoint:     POST ${API_BASE}${TEST_API_PATH}\n`);

  console.log('--- Step 1: POST without auth → expect 402 ---');
  const res1 = await fetch(`${API_BASE}${TEST_API_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_BODY),
  });
  if (res1.status !== 402) {
    console.error(`ERROR: expected 402, got ${res1.status}`);
    console.error(await res1.text());
    process.exit(1);
  }
  const body402 = (await res1.json()) as { accepts: PaymentRequirement[] };
  console.log(`✅ Got 402 with ${body402.accepts.length} accept entries`);

  const upto = body402.accepts.find(
    (a) => a.network === 'base' && a.scheme === 'upto'
  );
  if (!upto) {
    console.error(
      `ERROR: no base/upto accept in 402. Available: ${body402.accepts
        .map((a) => `${a.network}/${a.scheme}`)
        .join(', ')}`
    );
    process.exit(1);
  }
  const ceiling = Number(upto.maxAmountRequired) / 1e6;
  console.log(`   Scheme:   upto`);
  console.log(`   Ceiling:  ${upto.maxAmountRequired} atomic (${ceiling} USDC)`);
  console.log(`   PayTo:    ${upto.payTo}`);
  console.log(`   PayUSDC:  ${upto.asset}`);
  console.log(`   Facilitator: ${upto.extra?.facilitatorAddress}\n`);

  console.log('--- Step 2: Sign Permit2 PermitWitnessTransferFrom ---');
  const envelope = await signEVMUptoPayment(upto, provider, address);
  console.log(`✅ Signed`);
  const payload = envelope.payload as {
    permit2Authorization: { nonce: string; deadline: string };
    signature: string;
  };
  console.log(`   nonce:    ${payload.permit2Authorization.nonce}`);
  console.log(`   deadline: ${payload.permit2Authorization.deadline}`);
  console.log(
    `   signature: ${payload.signature.slice(0, 20)}...${payload.signature.slice(-10)}\n`
  );
  const xPayment = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');

  console.log('--- Step 3: Retry with X-Payment → expect 200 ---');
  const t0 = Date.now();
  const res2 = await fetch(`${API_BASE}${TEST_API_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': xPayment,
    },
    body: JSON.stringify(TEST_BODY),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`   Status: ${res2.status} in ${elapsed}s`);
  console.log(`   trace_id: ${res2.headers.get('x-trace-id') ?? '<absent>'}`);
  console.log(`   x-usage-exempt: ${res2.headers.get('x-usage-exempt') ?? '<absent>'}`);

  const body2 = await res2.json().catch(() => ({}));
  const preview = JSON.stringify(body2).slice(0, 400);
  console.log(`   body preview: ${preview}\n`);

  if (res2.status === 200) {
    console.log('✅✅✅ Live upto E2E SUCCESS.');
    console.log(
      'Settlement is deferred — check CLS or BaseScan for the actual /record settle tx in ~15s.'
    );
  } else {
    console.error(`⚠️  Unexpected status ${res2.status}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
