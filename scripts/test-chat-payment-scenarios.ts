import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { signSolanaPayment } from '../src/solana.ts';

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

interface UsageEntry {
  time?: string;
  data?: {
    trace_id?: string;
    api_path?: string;
    user_id?: string;
    status_code?: number;
    started_at?: string;
    finished_at?: string;
    metadata?: Record<string, unknown> | string;
  };
}

interface TraceEntry {
  content?: string;
}

interface ScenarioResult {
  network: 'base' | 'solana' | 'skale';
  wallet: string;
  requirement: PaymentRequirement;
  firstStatus: number;
  secondStatus: number;
  content: string | null;
  traceId: string | null;
  txHash: string | null;
  explorerLink: string | null;
  note: string | null;
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const apiBase = process.env.API_BASE || 'https://api.acedata.cloud';
const apiPath = '/openai/chat/completions';
const solanaRpc = 'https://solana-mainnet.g.alchemy.com/v2/KdwJ2bpGF18YLpi4Te8L1';

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

function randomNonce32(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}

function toBase64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return parseJson(text);
  } catch {
    return text;
  }
}

function formatAmount(amount: string, decimals = 6): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  return (value / 10 ** decimals).toFixed(decimals);
}

function getExplorerLink(network: string, txHash: string): string | null {
  if (!txHash) return null;
  if (network === 'base') return `https://basescan.org/tx/${txHash}`;
  if (network === 'skale') return `https://skale-base-explorer.skalenodes.com/tx/${txHash}`;
  if (network === 'solana') return `https://explorer.solana.com/tx/${txHash}?cluster=mainnet-beta`;
  return null;
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
      '20',
      '--format',
      'json',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 10,
    }
  );
  return parseJson<UsageEntry[]>(stdout);
}

function loadTraceEntries(traceId: string): TraceEntry[] {
  const stdout = execFileSync(
    'python3',
    [
      '.claude/scripts/cls_search.py',
      '--trace-id',
      traceId,
      '--format',
      'json',
      '--time',
      '30m',
      '--limit',
      '200',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 10,
    }
  );
  return parseJson<TraceEntry[]>(stdout);
}

function parseMetadata(value: UsageEntry['data'] extends { metadata?: infer T } ? T : never): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = parseJson<Record<string, unknown>>(value);
      return parsed ?? {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') return value as Record<string, unknown>;
  return {};
}

function getUsageTimestampMs(entry: UsageEntry): number | null {
  const candidates = [
    entry.data?.started_at,
    entry.data?.finished_at,
    entry.time,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const timestamp = Date.parse(candidate);
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return null;
}

function findMatchingUsage(entries: UsageEntry[], startedAfterMs: number): UsageEntry | null {
  for (const entry of entries) {
    const data = entry.data;
    if (!data || data.api_path !== apiPath) continue;
    const timestampMs = getUsageTimestampMs(entry);
    if (timestampMs === null) continue;
    if (timestampMs >= startedAfterMs - 15000) {
      return entry;
    }
  }
  return null;
}

function extractTraceInfo(traceEntries: TraceEntry[]): { txHash: string | null; note: string | null } {
  let note: string | null = null;

  for (const entry of traceEntries) {
    const content = entry.content || '';
    const settleMatch = content.match(/x402: settle succeeded, tx=([A-Za-z0-9x]+)/);
    if (settleMatch) {
      return { txHash: settleMatch[1], note };
    }
    if (!note && content.includes('invalid application id, return')) {
      note = 'gateway /record still returned "invalid application id, return" before x402 settle';
    }
    if (!note) {
      const failedMatch = content.match(/x402: settle failed: (.+)$/);
      if (failedMatch) {
        note = `settle failed: ${failedMatch[1]}`;
      }
    }
    if (!note) {
      const exceptionMatch = content.match(/x402: settle exception: (.+)$/);
      if (exceptionMatch) {
        note = `settle exception: ${exceptionMatch[1]}`;
      }
    }
  }

  return { txHash: null, note };
}

async function waitForUsage(userId: string, startedAfterMs: number): Promise<{
  traceId: string | null;
  txHash: string | null;
  note: string | null;
}> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const entries = loadUsageEntries(userId);
    const usage = findMatchingUsage(entries, startedAfterMs);
    if (usage?.data?.trace_id) {
      const metadata = parseMetadata(usage.data.metadata);
      const txHashFromUsage =
        typeof metadata.x402_tx === 'string' ? metadata.x402_tx : null;
      const noteFromUsage =
        typeof metadata.x402_settle_error === 'string'
          ? `settle failed: ${metadata.x402_settle_error}`
          : typeof metadata.x402_skipped === 'boolean' && metadata.x402_skipped
            ? 'settlement skipped because upstream API did not return 2xx'
            : null;

      if (txHashFromUsage) {
        return {
          traceId: usage.data.trace_id || null,
          txHash: txHashFromUsage,
          note: noteFromUsage,
        };
      }

      const traceEntries = loadTraceEntries(usage.data.trace_id);
      const traceInfo = extractTraceInfo(traceEntries);
      return {
        traceId: usage.data.trace_id || null,
        txHash: traceInfo.txHash,
        note: traceInfo.note || noteFromUsage,
      };
    }
    await sleep(5000);
  }

  return {
    traceId: null,
    txHash: null,
    note: 'no matching api-usage record found in CLS within polling window',
  };
}

async function waitForSolanaConfirmation(connection: Connection, signature: string): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    await sleep(1000);
  }

  throw new Error(`Solana signature not confirmed in time: ${signature}`);
}

async function getRequirement(network: 'base' | 'solana' | 'skale', body: unknown): Promise<PaymentRequirement> {
  const accepts = Array.isArray((body as { accepts?: PaymentRequirement[] } | null)?.accepts)
    ? ((body as { accepts: PaymentRequirement[] }).accepts)
    : [];
  const requirement = accepts.find((item) => item.network === network);
  if (!requirement) {
    throw new Error(`No ${network} payment requirement found in 402 response.`);
  }
  return requirement;
}

async function request402(testLabel: string): Promise<{ res: Response; body: unknown; startedAfterMs: number; chatBody: Record<string, unknown> }> {
  const startedAfterMs = Date.now();
  const chatBody = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: `say hi in 3 words; marker=${testLabel}`,
      },
    ],
    max_tokens: 10,
  };

  const res = await fetch(`${apiBase}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chatBody),
  });
  const body = await parseBody(res);
  return { res, body, startedAfterMs, chatBody };
}

async function runBaseScenario(): Promise<ScenarioResult> {
  const privateKey = process.env.X402B_BASE_PAYER_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error('X402B_BASE_PAYER_PRIVATE_KEY is missing.');
  }
  const wallet = new Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
  const marker = `base-${Date.now()}`;

  console.log('\n=== BASE ===');
  console.log(`Wallet: ${wallet.address}`);

  console.log('Step 1: POST without auth');
  const { res: res1, body: body1, startedAfterMs, chatBody } = await request402(marker);
  console.log(`  Status: ${res1.status}`);
  const requirement = await getRequirement('base', body1);
  console.log(`  amount: ${requirement.maxAmountRequired} (${formatAmount(requirement.maxAmountRequired)} USDC)`);
  console.log(`  payTo: ${requirement.payTo}`);
  console.log(`  asset: ${requirement.asset}`);

  console.log('Step 2: Sign EIP-712 authorization');
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: requirement.payTo,
    value: BigInt(requirement.maxAmountRequired).toString(),
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
  console.log(`  signature: ${signature.slice(0, 18)}...${signature.slice(-10)}`);

  console.log('Step 3: Retry with X-Payment');
  const xPayment = toBase64({
    x402Version: 2,
    scheme: requirement.scheme || 'exact',
    network: 'base',
    payload: { authorization, signature },
  });
  const res2 = await fetch(`${apiBase}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': xPayment,
    },
    body: JSON.stringify(chatBody),
  });
  const body2 = await parseBody(res2) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const content = body2?.choices?.[0]?.message?.content ?? null;
  console.log(`  Status: ${res2.status}`);
  console.log(`  Content: ${content}`);

  console.log('Step 4: Query CLS for trace/tx');
  const clsInfo = await waitForUsage(wallet.address, startedAfterMs);
  console.log(`  trace_id: ${clsInfo.traceId ?? '(missing)'}`);
  console.log(`  tx_hash: ${clsInfo.txHash ?? '(missing)'}`);
  if (clsInfo.note) console.log(`  note: ${clsInfo.note}`);

  return {
    network: 'base',
    wallet: wallet.address,
    requirement,
    firstStatus: res1.status,
    secondStatus: res2.status,
    content,
    traceId: clsInfo.traceId,
    txHash: clsInfo.txHash,
    explorerLink: clsInfo.txHash ? getExplorerLink('base', clsInfo.txHash) : null,
    note: clsInfo.note,
  };
}

async function runSkaleScenario(): Promise<ScenarioResult> {
  const privateKey = process.env.SKALE_BASE_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error('SKALE_BASE_PRIVATE_KEY is missing.');
  }
  const wallet = new Wallet(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
  const marker = `skale-${Date.now()}`;

  console.log('\n=== SKALE ===');
  console.log(`Wallet: ${wallet.address}`);

  console.log('Step 1: POST without auth');
  const { res: res1, body: body1, startedAfterMs, chatBody } = await request402(marker);
  console.log(`  Status: ${res1.status}`);
  const requirement = await getRequirement('skale', body1);
  const decimals = requirement.extra?.decimals ?? 6;
  console.log(`  amount: ${requirement.maxAmountRequired} (${formatAmount(requirement.maxAmountRequired, decimals)} USDC.e)`);
  console.log(`  payTo: ${requirement.payTo}`);
  console.log(`  asset: ${requirement.asset}`);

  console.log('Step 2: Sign EIP-712 authorization');
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: wallet.address,
    to: requirement.payTo,
    value: BigInt(requirement.maxAmountRequired).toString(),
    validAfter: String(now),
    validBefore: String(now + (requirement.maxTimeoutSeconds || 120)),
    nonce: randomNonce32(),
  };
  const domain = {
    name: requirement.extra?.name || 'Bridged USDC',
    version: requirement.extra?.version || '1',
    chainId: Number(requirement.extra?.chainId ?? 1187947933),
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
  console.log(`  signature: ${signature.slice(0, 18)}...${signature.slice(-10)}`);

  console.log('Step 3: Retry with X-Payment');
  const xPayment = toBase64({
    x402Version: 2,
    scheme: requirement.scheme || 'exact',
    network: 'skale',
    payload: { authorization, signature },
  });
  const res2 = await fetch(`${apiBase}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': xPayment,
    },
    body: JSON.stringify(chatBody),
  });
  const body2 = await parseBody(res2) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const content = body2?.choices?.[0]?.message?.content ?? null;
  console.log(`  Status: ${res2.status}`);
  console.log(`  Content: ${content}`);

  console.log('Step 4: Query CLS for trace/tx');
  const clsInfo = await waitForUsage(wallet.address, startedAfterMs);
  console.log(`  trace_id: ${clsInfo.traceId ?? '(missing)'}`);
  console.log(`  tx_hash: ${clsInfo.txHash ?? '(missing)'}`);
  if (clsInfo.note) console.log(`  note: ${clsInfo.note}`);

  return {
    network: 'skale',
    wallet: wallet.address,
    requirement,
    firstStatus: res1.status,
    secondStatus: res2.status,
    content,
    traceId: clsInfo.traceId,
    txHash: clsInfo.txHash,
    explorerLink: clsInfo.txHash ? getExplorerLink('skale', clsInfo.txHash) : null,
    note: clsInfo.note,
  };
}

async function runSolanaScenario(): Promise<ScenarioResult> {
  const secret = process.env.X402B_SOLANA_PAYER_PRIVATE_KEY?.trim();
  if (!secret) {
    throw new Error('X402B_SOLANA_PAYER_PRIVATE_KEY is missing.');
  }
  const payer = Keypair.fromSecretKey(bs58.decode(secret));
  const marker = `solana-${Date.now()}`;

  console.log('\n=== SOLANA ===');
  console.log(`Wallet: ${payer.publicKey.toBase58()}`);

  console.log('Step 1: POST without auth');
  const { res: res1, body: body1, startedAfterMs, chatBody } = await request402(marker);
  console.log(`  Status: ${res1.status}`);
  const requirement = await getRequirement('solana', body1);
  console.log(`  amount: ${requirement.maxAmountRequired} (${formatAmount(requirement.maxAmountRequired)} USDC)`);
  console.log(`  payTo: ${requirement.payTo}`);
  console.log(`  asset: ${requirement.asset}`);

  console.log('Step 2: Sign and send Solana payment with SDK wallet path');
  const connection = new Connection(requirement.extra?.rpcUrl ?? solanaRpc, 'confirmed');
  const solanaWallet = {
    publicKey: payer.publicKey,
    async signAndSendTransaction(tx: unknown): Promise<string> {
      const transaction = tx as Transaction;
      transaction.partialSign(payer);
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      await waitForSolanaConfirmation(connection, signature);
      return signature;
    },
  };
  const envelope = await signSolanaPayment(requirement, solanaWallet);
  const signature = 'signature' in envelope.payload ? envelope.payload.signature : null;
  console.log(`  signature: ${signature ?? '(missing)'}`);

  console.log('Step 3: Retry with X-Payment');
  const xPayment = toBase64(envelope);
  const res2 = await fetch(`${apiBase}${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': xPayment,
    },
    body: JSON.stringify(chatBody),
  });
  const body2 = await parseBody(res2) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const content = body2?.choices?.[0]?.message?.content ?? null;
  console.log(`  Status: ${res2.status}`);
  console.log(`  Content: ${content}`);

  console.log('Step 4: Query CLS for trace/tx');
  const clsInfo = await waitForUsage(payer.publicKey.toBase58(), startedAfterMs);
  console.log(`  trace_id: ${clsInfo.traceId ?? '(missing)'}`);
  console.log(`  tx_hash: ${clsInfo.txHash ?? '(missing)'}`);
  if (clsInfo.note) console.log(`  note: ${clsInfo.note}`);

  return {
    network: 'solana',
    wallet: payer.publicKey.toBase58(),
    requirement,
    firstStatus: res1.status,
    secondStatus: res2.status,
    content,
    traceId: clsInfo.traceId,
    txHash: clsInfo.txHash,
    explorerLink: clsInfo.txHash ? getExplorerLink('solana', clsInfo.txHash) : null,
    note: clsInfo.note,
  };
}

function printSummary(result: ScenarioResult): void {
  console.log(`\n--- ${result.network.toUpperCase()} SUMMARY ---`);
  console.log(`402 status: ${result.firstStatus}`);
  console.log(`paid call status: ${result.secondStatus}`);
  console.log(`wallet: ${result.wallet}`);
  console.log(`trace_id: ${result.traceId ?? '(missing)'}`);
  console.log(`tx_hash: ${result.txHash ?? '(missing)'}`);
  console.log(`explorer: ${result.explorerLink ?? '(missing)'}`);
  console.log(`content: ${result.content ?? '(missing)'}`);
  if (result.note) {
    console.log(`note: ${result.note}`);
  }
}

async function main() {
  loadEnvFile(resolve(repoRoot, '.claude/.env'));
  loadEnvFile(resolve(repoRoot, 'PlatformBackend/.env'));

  console.log(`API: ${apiBase}${apiPath}`);
  console.log('Testing three x402 chat payment scenarios with CLS follow-up.');

  const results = [
    await runBaseScenario(),
    await runSolanaScenario(),
    await runSkaleScenario(),
  ];

  console.log('\n================ FINAL SUMMARY ================');
  for (const result of results) {
    printSummary(result);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
