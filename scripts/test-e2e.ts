/**
 * X402 E2E test script.
 *
 * Step 1: Send request without auth → expect 402 + accepts[]
 * Step 2: (Manual) Sign with wallet and retry with X-Payment header
 *
 * Usage:
 *   node --loader ts-node/esm scripts/test-e2e.ts
 *   # or after build:
 *   node dist/scripts/test-e2e.js
 */

const API_BASE = process.env.API_BASE || 'https://api.acedata.cloud';

async function testStep1_Get402() {
  console.log('=== Step 1: Request without auth → expect 402 ===\n');

  const url = `${API_BASE}/suno/audios`;
  console.log(`POST ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test x402 payment', model: 'chirp-v4' }),
  });

  console.log(`Status: ${res.status}`);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  console.log('Response:', JSON.stringify(body, null, 2));

  if (res.status === 402) {
    console.log('\n✅ Got 402 Payment Required');
    const accepts = (body as any).accepts;
    if (Array.isArray(accepts) && accepts.length > 0) {
      console.log(`✅ ${accepts.length} payment requirement(s):`);
      for (const a of accepts) {
        console.log(`   - network: ${a.network}, amount: ${a.maxAmountRequired}, payTo: ${a.payTo}`);
      }
    } else {
      console.log('❌ No accepts[] in 402 response');
    }
  } else if (res.status === 404) {
    console.log('\n⚠️  Got 404 — Gateway may not have the fix deployed yet (PR #106)');
  } else if (res.status === 401 || res.status === 200) {
    console.log('\n⚠️  Got', res.status, '— X402 may not be enabled or route not matched');
  } else {
    console.log('\n❌ Unexpected status:', res.status);
  }
}

async function testFacilitatorSupported() {
  console.log('\n=== Facilitator /supported check ===\n');

  const url = 'https://facilitator.acedata.cloud/supported';
  console.log(`GET ${url}`);

  const res = await fetch(url);
  console.log(`Status: ${res.status}`);
  const text = await res.text();
  if (!text) {
    console.log('⚠️  Empty response body — facilitator may be behind a CDN/proxy stripping responses');
    console.log('   Check that the K8s service is accessible and CLB/stgw is forwarding correctly');
    return;
  }
  const body = JSON.parse(text);
  console.log('Response:', JSON.stringify(body, null, 2));

  const kinds = (body as any).kinds;
  if (Array.isArray(kinds) && kinds.length > 0) {
    console.log(`✅ Facilitator supports ${kinds.length} network(s): ${kinds.map((k: any) => k.network).join(', ')}`);
  } else {
    console.log('❌ Facilitator returned no supported kinds');
  }
}

async function main() {
  await testFacilitatorSupported();
  await testStep1_Get402();

  console.log('\n=== Next steps ===');
  console.log('To complete E2E, use the X402 client SDK with a real wallet:');
  console.log('');
  console.log('  import { createX402Client } from "@acedatacloud/x402-client";');
  console.log('  const client = createX402Client({ baseURL, network: "solana", solanaWallet });');
  console.log('  const result = await client.post("/suno/v1/generations", { prompt: "..." });');
}

main().catch(console.error);
