import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

interface PaymentRequirement {
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
    chainId?: number | string;
    verifyingContract?: string;
    decimals?: number;
  };
}

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

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getPrivateKey(): string {
  const raw = process.env.SKALE_BASE_PRIVATE_KEY?.trim();
  if (!raw) {
    throw new Error('SKALE_BASE_PRIVATE_KEY is missing. Put it in .claude/.env or export it before running.');
  }

  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

function randomNonce32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

function formatAmount(amount: string, decimals = 6): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return (value / 10 ** decimals).toString();
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  loadEnvFile(resolve(scriptDir, '../../../.claude/.env'));
  loadEnvFile(resolve(scriptDir, '../../../PlatformBackend/.env'));

  const apiBase = process.env.API_BASE || 'https://api.acedata.cloud';
  const testApiPath = process.env.TEST_API_PATH || '/suno/audios';
  const testBody = process.env.TEST_BODY
    ? JSON.parse(process.env.TEST_BODY)
    : { prompt: process.env.SUNO_PROMPT || 'a short SKALE test beat', make_instrumental: true };
  const wallet = new Wallet(getPrivateKey());

  console.log('=== SKALE X402 Real E2E Test ===');
  console.log(`API: ${apiBase}`);
  console.log(`Payer wallet: ${wallet.address}`);
  console.log('');

  console.log(`--- Step 1: Request ${testApiPath} without auth ---`);
  const res1 = await fetch(`${apiBase}${testApiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testBody),
  });

  const body1 = await parseBody(res1) as { accepts?: PaymentRequirement[] } | string | null;
  console.log(`Status: ${res1.status}`);

  if (res1.status !== 402) {
    console.log('Expected 402 but got a different response.');
    console.log(JSON.stringify(body1, null, 2));
    process.exit(1);
  }

  const accepts = Array.isArray((body1 as { accepts?: PaymentRequirement[] } | null)?.accepts)
    ? (body1 as { accepts: PaymentRequirement[] }).accepts
    : [];

  const skaleRequirement = accepts.find((item) => item.network === 'skale');
  if (!skaleRequirement) {
    console.log('No skale payment requirement in 402 response.');
    console.log(`Available networks: ${accepts.map((item) => item.network).join(', ') || '(none)'}`);
    console.log(JSON.stringify(body1, null, 2));
    process.exit(1);
  }

  const decimals = skaleRequirement.extra?.decimals ?? 6;
  console.log('Found skale payment requirement:');
  console.log(`  amount: ${skaleRequirement.maxAmountRequired} (${formatAmount(skaleRequirement.maxAmountRequired, decimals)} units)`);
  console.log(`  payTo: ${skaleRequirement.payTo}`);
  console.log(`  asset: ${skaleRequirement.asset}`);
  console.log(`  chainId: ${skaleRequirement.extra?.chainId ?? 1187947933}`);
  console.log(`  verifyingContract: ${skaleRequirement.extra?.verifyingContract ?? skaleRequirement.asset}`);
  console.log('');

  console.log('--- Step 2: Sign EIP-712 authorization ---');
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: skaleRequirement.payTo,
    value: BigInt(skaleRequirement.maxAmountRequired).toString(),
    validAfter: String(now),
    validBefore: String(now + (skaleRequirement.maxTimeoutSeconds || 120)),
    nonce: randomNonce32(),
  };

  const domain = {
    name: skaleRequirement.extra?.name || 'USD Coin',
    version: skaleRequirement.extra?.version || '2',
    chainId: Number(skaleRequirement.extra?.chainId ?? 1187947933),
    verifyingContract: skaleRequirement.extra?.verifyingContract || skaleRequirement.asset,
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
  const envelope = {
    x402Version: 2,
    scheme: skaleRequirement.scheme || 'exact',
    network: 'skale',
    payload: {
      authorization,
      signature,
    },
  };

  const xPayment = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
  console.log('Signed payment envelope.');
  console.log(`  header length: ${xPayment.length}`);
  console.log('');

  console.log(`--- Step 3: Retry ${testApiPath} with X-Payment ---`);
  const res2 = await fetch(`${apiBase}${testApiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': xPayment,
    },
    body: JSON.stringify(testBody),
  });

  const body2 = await parseBody(res2);
  console.log(`Status: ${res2.status}`);
  console.log(JSON.stringify(body2, null, 2));
  console.log('');

  if (res2.status === 200) {
    console.log('SKALE E2E succeeded.');
    return;
  }

  if (res2.status === 402) {
    console.log('Gateway still returned 402. Most likely the facilitator rejected the signed payment.');
    process.exit(1);
  }

  if (res2.status === 500) {
    console.log('Gateway returned 500. Common causes are insufficient SKALE USDC balance or facilitator settlement failure.');
    process.exit(1);
  }

  console.log('Unexpected response status.');
  process.exit(1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
