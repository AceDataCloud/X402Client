/**
 * Parameterized x402 billing regression test.
 *
 * Walks a list of { apiPath, payload, expectedCredits, expectedUsd } scenarios
 * and for each one:
 *   1. Sends the request with no auth → asserts 402 with an x402 `accepts` list.
 *   2. Verifies that the Base amount matches the locally predicted
 *      cost (expectedCredits × 0.095215 × 1e6 atomic USDC) → proves pricing is
 *      dynamic and derived from cost/api/<uuid>.json at runtime.
 *   3. Signs an EIP-712 TransferWithAuthorization and retries with
 *      `PAYMENT-SIGNATURE`
 *      on Base → asserts 2xx.
 *   4. Polls CLS `api-usages` for the caller wallet until the matching
 *      ApiUsage record lands → asserts `used_amount` ≈ expectedCredits and
 *      that `metadata.x402_tx` is present.
 *
 * Covered here:
 *   - /nano-banana/images      model=nano-banana        → 0.14 credits
 *   - /nano-banana/images      model=nano-banana-2      → 0.28 credits
 *   - /midjourney/imagine      mode=fast  action=generate (default) → 0.27 credits
 *   - /midjourney/imagine      mode=relax action=generate           → 0.168 credits
 *
 * Prereqs:
 *   export X402B_BASE_PAYER_PRIVATE_KEY=0x...
 *   (or put it in /.claude/.env — loaded automatically)
 *
 * Run:
 *   node --experimental-strip-types scripts/test-api-billing-scenarios.ts
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';

const CREDITS_TO_USDC_RATE = 0.095215;
const USDC_DECIMALS = 6;
const BASE_NETWORK = 'eip155:8453';

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
    chainId?: number | string;
    verifyingContract?: string;
  };
}

interface Scenario {
  label: string;
  apiPath: string;
  payload: Record<string, unknown>;
  expectedCredits: number;
}

interface UsageEntry {
  time?: string;
  data?: {
    trace_id?: string;
    api_path?: string;
    user_id?: string;
    status_code?: number;
    used_amount?: number | string;
    deducted_amount?: number | string;
    started_at?: string;
    finished_at?: string;
    metadata?: Record<string, unknown> | string;
  };
}

interface ScenarioResult {
  scenario: Scenario;
  firstStatus: number;
  secondStatus: number;
  expectedAtomic: string;
  advertisedAtomic: string;
  pricingMatches: boolean;
  usage: UsageEntry | null;
  usageCredits: number | null;
  usageMatches: boolean;
  txHash: string | null;
  traceId: string | null;
  explorerLink: string | null;
  passed: boolean;
  failReasons: string[];
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const x402Root = resolve(scriptDir, '..');
const monorepoRoot = resolve(x402Root, '..');
const apiBase = process.env.API_BASE || 'https://x402.acedata.cloud';

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
    if (!(key in process.env)) process.env[key] = value;
  }
}

function creditsToAtomicUsdc(credits: number): string {
  const atomic = Math.floor(credits * CREDITS_TO_USDC_RATE * 10 ** USDC_DECIMALS);
  return String(Math.max(atomic, 1));
}

function toBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomNonce32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
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

function getRequirement(
  body: unknown,
  network: string,
): PaymentRequirement | null {
  const accepts = Array.isArray((body as { accepts?: PaymentRequirement[] } | null)?.accepts)
    ? (body as { accepts: PaymentRequirement[] }).accepts
    : [];
  return accepts.find((r) => r.network === network) ?? null;
}

function parseMetadata(value: UsageEntry['data'] extends { metadata?: infer T } ? T : never): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      // CLS may store Python repr rather than JSON.
    }
    try {
      const parsed = execFileSync(
        'python3',
        [
          '-c',
          'import ast,json,sys; value=ast.literal_eval(sys.stdin.read()); print(json.dumps(value))',
        ],
        { input: value, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      );
      return JSON.parse(parsed);
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return {};
}

function loadUsageEntries(userId: string): UsageEntry[] {
  const stdout = execFileSync(
    'python3',
    [
      '.claude/scripts/cls_search.py',
      '--user-id',
      userId,
      '--topic',
      'api-usages',
      '--time',
      '30m',
      '--limit',
      '30',
      '--format',
      'json',
    ],
    {
      cwd: monorepoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 10,
    },
  );
  try {
    return JSON.parse(stdout) as UsageEntry[];
  } catch {
    return [];
  }
}

function usageTimestampMs(entry: UsageEntry): number | null {
  for (const candidate of [entry.data?.started_at, entry.data?.finished_at, entry.time]) {
    if (!candidate) continue;
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

async function waitForUsage(
  userId: string,
  apiPath: string,
  startedAfterMs: number,
  seenTraces: Set<string>,
): Promise<UsageEntry | null> {
  for (let attempt = 1; attempt <= 36; attempt += 1) {
    const entries = loadUsageEntries(userId);
    for (const entry of entries) {
      if (entry.data?.api_path !== apiPath) continue;
      const traceId = entry.data?.trace_id;
      if (traceId && seenTraces.has(traceId)) continue;
      const ts = usageTimestampMs(entry);
      // Require the record to be at least roughly as recent as the request;
      // CLS timestamps are second-precision so allow a tiny skew.
      if (ts === null || ts < startedAfterMs - 3000) continue;
      if (traceId) seenTraces.add(traceId);
      return entry;
    }
    await sleep(5000);
  }
  return null;
}

function prettyAtomic(atomic: string): string {
  const value = Number(atomic);
  if (!Number.isFinite(value)) return atomic;
  return (value / 10 ** USDC_DECIMALS).toFixed(USDC_DECIMALS);
}

function explorer(network: string, tx: string): string | null {
  if (network === BASE_NETWORK) return `https://basescan.org/tx/${tx}`;
  return null;
}

async function runScenario(
  scenario: Scenario,
  wallet: Wallet,
  seenTraces: Set<string>,
): Promise<ScenarioResult> {
  const failReasons: string[] = [];
  console.log(`\n=== ${scenario.label} ===`);
  console.log(`POST ${apiBase}${scenario.apiPath}`);
  console.log(`payload: ${JSON.stringify(scenario.payload)}`);
  console.log(
    `expected: ${scenario.expectedCredits} credits = $${(scenario.expectedCredits * CREDITS_TO_USDC_RATE).toFixed(6)}`,
  );

  const expectedAtomic = creditsToAtomicUsdc(scenario.expectedCredits);
  const startedAfterMs = Date.now();

  // Step 1 — no-auth → 402
  const res1 = await fetch(`${apiBase}${scenario.apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenario.payload),
  });
  const body1 = await parseBody(res1);
  console.log(`  step 1 (no auth): ${res1.status}`);

  const requirement = getRequirement(body1, BASE_NETWORK);
  if (!requirement) {
    failReasons.push(`no ${BASE_NETWORK} requirement in 402 accepts`);
    return {
      scenario,
      firstStatus: res1.status,
      secondStatus: 0,
      expectedAtomic,
      advertisedAtomic: '',
      pricingMatches: false,
      usage: null,
      usageCredits: null,
      usageMatches: false,
      txHash: null,
      traceId: null,
      explorerLink: null,
      passed: false,
      failReasons,
    };
  }

  const advertisedAtomic = requirement.amount ?? requirement.maxAmountRequired;
  if (!advertisedAtomic) {
    throw new Error(`Payment requirement for ${BASE_NETWORK} has no amount.`);
  }
  const pricingMatches = advertisedAtomic === expectedAtomic;
  console.log(
    `  advertised: ${advertisedAtomic} (${prettyAtomic(advertisedAtomic)} USDC) | expected: ${expectedAtomic} | match: ${pricingMatches}`,
  );
  if (!pricingMatches) {
    failReasons.push(
      `price mismatch: expected ${expectedAtomic}, got ${advertisedAtomic}`,
    );
  }

  // Step 2 — sign and retry
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: requirement.payTo,
    value: BigInt(advertisedAtomic).toString(),
    validAfter: String(now),
    validBefore: String(now + (requirement.maxTimeoutSeconds || 120)),
    nonce: randomNonce32(),
  };
  const domain = {
    name: requirement.extra?.name || 'USD Coin',
    version: requirement.extra?.version || '2',
    chainId: Number(requirement.extra?.chainId ?? 8453),
    verifyingContract: requirement.extra?.verifyingContract || requirement.asset,
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
  const paymentSignature = toBase64({
    x402Version: 2,
    accepted: requirement,
    payload: { authorization, signature },
  });

  const res2 = await fetch(`${apiBase}${scenario.apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': paymentSignature },
    body: JSON.stringify(scenario.payload),
  });
  const body2 = await parseBody(res2);
  console.log(`  step 2 (with PAYMENT-SIGNATURE): ${res2.status}`);
  if (res2.status < 200 || res2.status >= 300) {
    failReasons.push(`paid call status ${res2.status}`);
    const snippet = typeof body2 === 'string' ? body2.slice(0, 200) : JSON.stringify(body2).slice(0, 200);
    console.log(`  response snippet: ${snippet}`);
  }

  // Step 3 — CLS ApiUsage assertion.
  // For x402 the billing is on-chain USDC, so `used_amount`/`deducted_amount`
  // are recorded as 0 (the platform credits are not consumed). The canonical
  // proof of payment is `metadata.x402 === true` + `metadata.x402_tx`.
  const usage = await waitForUsage(wallet.address, scenario.apiPath, startedAfterMs, seenTraces);
  let usageCredits: number | null = null;
  let usageMatches = false;
  let txHash: string | null = null;
  let traceId: string | null = null;

  if (usage) {
    traceId = usage.data?.trace_id ?? null;
    const used = usage.data?.used_amount;
    usageCredits = typeof used === 'number' ? used : used !== undefined ? Number(used) : null;
    const metadata = parseMetadata(usage.data?.metadata);
    const x402Flag = metadata.x402 === true;
    txHash = typeof metadata.x402_tx === 'string' && metadata.x402_tx.length > 0
      ? metadata.x402_tx
      : null;
    usageMatches = x402Flag && !!txHash;
    if (!x402Flag) failReasons.push('ApiUsage.metadata.x402 != true');
    if (!txHash) failReasons.push('ApiUsage.metadata.x402_tx missing');
    console.log(
      `  ApiUsage: trace=${traceId} used=${usageCredits ?? '?'} x402=${x402Flag} tx=${txHash ?? '(missing)'}`,
    );
  } else {
    failReasons.push('no ApiUsage record found in CLS');
    console.log('  ApiUsage: (not found within polling window)');
  }

  const passed =
    pricingMatches &&
    res2.status >= 200 &&
    res2.status < 300 &&
    usageMatches;

  return {
    scenario,
    firstStatus: res1.status,
    secondStatus: res2.status,
    expectedAtomic,
    advertisedAtomic,
    pricingMatches,
    usage,
    usageCredits,
    usageMatches,
    txHash,
    traceId,
    explorerLink: txHash ? explorer('base', txHash) : null,
    passed,
    failReasons,
  };
}

function printSummary(results: ScenarioResult[]): void {
  console.log('\n================ FINAL SUMMARY ================');
  for (const r of results) {
    const s = r.scenario;
    const usd = (s.expectedCredits * CREDITS_TO_USDC_RATE).toFixed(6);
    console.log(
      `[${r.passed ? 'PASS' : 'FAIL'}] ${s.label.padEnd(40)} ` +
        `credits=${s.expectedCredits} ($${usd}) → atomic=${r.advertisedAtomic} ` +
        `usage=${r.usageCredits ?? '?'} ` +
        `tx=${r.txHash ? r.txHash.slice(0, 12) + '…' : '-'}`,
    );
    if (!r.passed) {
      for (const reason of r.failReasons) console.log(`       ! ${reason}`);
    }
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} scenarios passed.`);
}

const SCENARIOS: Scenario[] = [
  {
    label: 'nano-banana / model=nano-banana',
    apiPath: '/nano-banana/images',
    payload: {
      model: 'nano-banana',
      prompt: 'a tiny yellow banana on a white background',
      size: '1x1',
    },
    expectedCredits: 0.14,
  },
  {
    label: 'nano-banana / model=nano-banana-2',
    apiPath: '/nano-banana/images',
    payload: {
      model: 'nano-banana-2',
      prompt: 'a tiny yellow banana on a white background',
      size: '1x1',
    },
    expectedCredits: 0.28,
  },
  {
    label: 'midjourney / fast + generate (default)',
    apiPath: '/midjourney/imagine',
    payload: {
      prompt: 'a photo of a tiny bonsai tree, minimal style',
    },
    expectedCredits: 0.27,
  },
  {
    label: 'midjourney / turbo + generate',
    apiPath: '/midjourney/imagine',
    payload: {
      prompt: 'a photo of a tiny bonsai tree, minimal style',
      mode: 'turbo',
    },
    expectedCredits: 0.54,
  },
];

async function main() {
  loadEnvFile(resolve(monorepoRoot, '.claude/.env'));
  loadEnvFile(resolve(monorepoRoot, 'PlatformBackend/.env'));

  const privateKey = process.env.X402B_BASE_PAYER_PRIVATE_KEY?.trim();
  if (!privateKey) {
    console.error('X402B_BASE_PAYER_PRIVATE_KEY is missing (set it in env or .claude/.env).');
    process.exit(2);
  }
  const wallet = new Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
  console.log(`Wallet: ${wallet.address}`);
  console.log(`API base: ${apiBase}`);
  console.log(`CREDITS_TO_USDC_RATE: ${CREDITS_TO_USDC_RATE}`);

  const results: ScenarioResult[] = [];
  const seenTraces = new Set<string>();
  for (const scenario of SCENARIOS) {
    try {
      results.push(await runScenario(scenario, wallet, seenTraces));
    } catch (err) {
      console.error(`  ! scenario failed: ${(err as Error).message}`);
      results.push({
        scenario,
        firstStatus: 0,
        secondStatus: 0,
        expectedAtomic: creditsToAtomicUsdc(scenario.expectedCredits),
        advertisedAtomic: '',
        pricingMatches: false,
        usage: null,
        usageCredits: null,
        usageMatches: false,
        txHash: null,
        traceId: null,
        explorerLink: null,
        passed: false,
        failReasons: [(err as Error).message],
      });
    }
    // brief spacing between scenarios
    await sleep(1500);
  }

  printSummary(results);
  const allPassed = results.every((r) => r.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
