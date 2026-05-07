import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';

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

const SKALE_RPC = process.env.SKALE_RPC || 'https://skale-base.skalenodes.com/v1/base';
const SKALE_EXPLORER = process.env.SKALE_EXPLORER || 'https://skale-base-explorer.skalenodes.com';
// keccak256("AuthorizationUsed(address,bytes32)")
const AUTHORIZATION_USED_TOPIC =
  '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

function pad32(addr: string): string {
  return '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function shortHex(value: string, head = 8, tail = 6): string {
  if (!value || value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function fmtUsdc(units: bigint, decimals = 6): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const frac = units % divisor;
  return `${whole}.${frac.toString().padStart(decimals, '0')}`;
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

  // Set up the read-only SKALE RPC connection up front so we can both:
  //   (1) print the wallet's USDC balance before/after the demo, and
  //   (2) scan logs after the API call to find the actual settlement tx hash.
  // SKALE chains are gas-free, so this is "free" reading even on mainnet.
  const provider = new JsonRpcProvider(SKALE_RPC);

  console.log('=== SKALE X402 Real E2E Test ===');
  console.log(`API: ${apiBase}`);
  console.log(`SKALE RPC: ${SKALE_RPC}`);
  console.log(`Payer wallet: ${wallet.address}`);
  console.log(`Explorer (wallet): ${SKALE_EXPLORER}/address/${wallet.address}`);
  console.log('');

  console.log(`--- Step 1: Request ${testApiPath} without auth ---`);
  const t1Start = Date.now();
  const res1 = await fetch(`${apiBase}${testApiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testBody),
  });

  const body1 = (await parseBody(res1)) as { accepts?: PaymentRequirement[] } | string | null;
  const t1Elapsed = Date.now() - t1Start;
  console.log(`Status: ${res1.status}    (${t1Elapsed} ms)`);

  if (res1.status !== 402) {
    console.log('Expected 402 but got a different response.');
    console.log(JSON.stringify(body1, null, 2));
    process.exit(1);
  }

  const accepts = Array.isArray((body1 as { accepts?: PaymentRequirement[] } | null)?.accepts)
    ? (body1 as { accepts: PaymentRequirement[] }).accepts
    : [];

  console.log(`accepts[]: ${accepts.map((item) => item.network).join(', ') || '(none)'}`);

  const skaleRequirement = accepts.find((item) => item.network === 'skale');
  if (!skaleRequirement) {
    console.log('No skale payment requirement in 402 response.');
    console.log(JSON.stringify(body1, null, 2));
    process.exit(1);
  }

  const decimals = skaleRequirement.extra?.decimals ?? 6;
  const chainId = Number(skaleRequirement.extra?.chainId ?? 1187947933);
  const verifyingContract =
    skaleRequirement.extra?.verifyingContract || skaleRequirement.asset;

  console.log('Selected SKALE payment requirement:');
  console.log(`  scheme:            ${skaleRequirement.scheme}`);
  console.log(
    `  amount:            ${skaleRequirement.maxAmountRequired} (${formatAmount(
      skaleRequirement.maxAmountRequired,
      decimals,
    )} USDC)`,
  );
  console.log(`  payTo:             ${skaleRequirement.payTo}`);
  console.log(`  asset (USDC):      ${skaleRequirement.asset}`);
  console.log(`  chainId:           ${chainId}`);
  console.log(`  verifyingContract: ${verifyingContract}`);
  console.log(`  maxTimeoutSeconds: ${skaleRequirement.maxTimeoutSeconds ?? '(default 120)'}`);
  console.log(`  resource:          ${skaleRequirement.resource ?? '(none)'}`);
  console.log(`  description:       ${skaleRequirement.description ?? '(none)'}`);
  console.log('');

  // Snapshot the wallet's USDC balance and the current SKALE block number so
  // we can show "before / after" math + restrict the post-run log scan to a
  // tight block range. We resolve them independently so a balance read failure
  // (e.g. RPC quirks) doesn't kill the block snapshot.
  const usdc = new Contract(verifyingContract, ERC20_ABI, provider);
  let balanceBefore: bigint | undefined;
  let blockBefore: number | undefined;
  try {
    blockBefore = await provider.getBlockNumber();
    console.log(`SKALE head block: ${blockBefore}`);
  } catch (error) {
    console.log(`(could not fetch SKALE head block: ${(error as Error).message})`);
  }
  try {
    balanceBefore = (await usdc.balanceOf(wallet.address)) as bigint;
    console.log(`Wallet USDC balance before: ${fmtUsdc(balanceBefore, decimals)} USDC`);
  } catch (error) {
    console.log(`(could not fetch on-chain balance: ${(error as Error).message})`);
  }
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
    chainId,
    verifyingContract,
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

  const tSignStart = Date.now();
  const signature = await wallet.signTypedData(domain, types, authorization);
  const tSignElapsed = Date.now() - tSignStart;

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

  console.log(`Signed in ${tSignElapsed} ms.  X-Payment header is ${xPayment.length} bytes.`);
  console.log('Signed envelope (decoded):');
  console.log('  domain:');
  console.log(`    name:              "${domain.name}"`);
  console.log(`    version:           "${domain.version}"`);
  console.log(`    chainId:           ${domain.chainId}`);
  console.log(`    verifyingContract: ${domain.verifyingContract}`);
  console.log('  authorization:');
  console.log(`    from:        ${authorization.from}`);
  console.log(`    to:          ${authorization.to}`);
  console.log(
    `    value:       ${authorization.value} (${fmtUsdc(BigInt(authorization.value), decimals)} USDC)`,
  );
  console.log(
    `    validAfter:  ${authorization.validAfter}  (${new Date(Number(authorization.validAfter) * 1000).toISOString()})`,
  );
  console.log(
    `    validBefore: ${authorization.validBefore}  (${new Date(Number(authorization.validBefore) * 1000).toISOString()})`,
  );
  console.log(`    nonce:       ${authorization.nonce}`);
  console.log(`  signature:   ${shortHex(signature, 12, 12)}  (${signature.length - 2}/2 hex chars)`);
  console.log('');

  console.log(`--- Step 3: Retry ${testApiPath} with X-Payment ---`);
  const t3Start = Date.now();
  const res2 = await fetch(`${apiBase}${testApiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': xPayment,
    },
    body: JSON.stringify(testBody),
  });

  const body2 = await parseBody(res2);
  const t3Elapsed = Date.now() - t3Start;
  console.log(`Status: ${res2.status}    (${t3Elapsed} ms)`);
  console.log(`Response body:`);
  console.log(JSON.stringify(body2, null, 2));
  console.log('');

  if (res2.status === 402) {
    console.log('Gateway still returned 402. Most likely the facilitator rejected the signed payment.');
    process.exit(1);
  }

  if (res2.status === 500 || res2.status === 502 || res2.status === 504) {
    console.log(
      `Gateway returned ${res2.status}. Common causes are insufficient SKALE USDC balance, ` +
        `facilitator settlement failure, or transient upstream errors. Retry should be safe ` +
        `if the request never reached 200 (the nonce was not consumed).`,
    );
    process.exit(1);
  }

  if (res2.status !== 200) {
    console.log('Unexpected response status.');
    process.exit(1);
  }

  // Successful response. Now look up the on-chain settlement.
  console.log('--- Step 4: Look up the on-chain settlement on SKALE ---');
  let settlementTxHash: string | undefined;
  let settlementBlock: number | undefined;

  try {
    // The facilitator calls USDC.transferWithAuthorization(...) which emits
    //     AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)
    // Both topics are indexed, so we can locate the exact tx with a tight
    // (fromBlock, toBlock, address, topics) filter. SKALE's RPC caps each
    // getLogs window at ~2000 blocks, so always anchor against the head we
    // captured before the API call (or the current head as a fallback).
    const head = await provider.getBlockNumber();
    const anchor = blockBefore ?? head;
    const fromBlock = Math.max(0, anchor - 5);
    let attempts = 0;
    while (attempts < 8) {
      attempts += 1;
      const toBlock = await provider.getBlockNumber();
      const logs = await provider.getLogs({
        fromBlock,
        toBlock,
        address: verifyingContract,
        topics: [AUTHORIZATION_USED_TOPIC, pad32(wallet.address), authorization.nonce],
      });

      if (logs.length > 0) {
        settlementTxHash = logs[0].transactionHash;
        settlementBlock = logs[0].blockNumber;
        break;
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    if (!settlementTxHash) {
      console.log(
        `(facilitator settlement not yet visible on-chain after ${attempts} polls; ` +
          `the API already returned 200, so the payment is committed — try ` +
          `${SKALE_EXPLORER}/address/${wallet.address} in your browser.)`,
      );
    } else {
      console.log(`Settlement tx (AuthorizationUsed):`);
      console.log(`  hash:      ${settlementTxHash}`);
      console.log(`  block:     ${settlementBlock}`);
      console.log(`  explorer:  ${SKALE_EXPLORER}/tx/${settlementTxHash}`);

      // Also fetch the matching Transfer log inside the same tx so we can
      // print the actual amount that moved (not just maxAmountRequired) —
      // useful as proof to the audience that "you only pay what was quoted".
      try {
        const receipt = await provider.getTransactionReceipt(settlementTxHash);
        if (receipt) {
          const transferLog = receipt.logs.find(
            (log) =>
              log.address.toLowerCase() === verifyingContract.toLowerCase() &&
              log.topics[0] === TRANSFER_TOPIC &&
              log.topics[1] === pad32(wallet.address),
          );
          if (transferLog) {
            const value = BigInt(transferLog.data);
            const toAddr = '0x' + transferLog.topics[2].slice(-40);
            console.log(`  Transfer:  ${fmtUsdc(value, decimals)} USDC -> ${toAddr}`);
          }
          console.log(`  facilitator (tx.from): ${receipt.from}`);
        }
      } catch (error) {
        console.log(`  (could not fetch tx receipt: ${(error as Error).message})`);
      }
    }

    // Closing balance.
    if (balanceBefore !== undefined) {
      try {
        const balanceAfter = (await usdc.balanceOf(wallet.address)) as bigint;
        const delta = balanceBefore - balanceAfter;
        console.log(
          `Wallet USDC balance after:  ${fmtUsdc(balanceAfter, decimals)} USDC  ` +
            `(delta -${fmtUsdc(delta, decimals)} USDC)`,
        );
      } catch (error) {
        console.log(`(could not fetch closing balance: ${(error as Error).message})`);
      }
    }
  } catch (error) {
    console.log(`On-chain lookup failed: ${(error as Error).message}`);
  }

  console.log('');
  console.log('--- Summary ---');
  console.log(`  402 round-trip:        ${t1Elapsed} ms`);
  console.log(`  EIP-712 sign:          ${tSignElapsed} ms`);
  console.log(`  paid call round-trip:  ${t3Elapsed} ms`);
  console.log(`  paid:                  ${formatAmount(skaleRequirement.maxAmountRequired, decimals)} USDC on SKALE`);
  if (settlementTxHash) {
    console.log(`  settlement:            ${SKALE_EXPLORER}/tx/${settlementTxHash}`);
  }
  console.log('');
  console.log('SKALE E2E succeeded.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
