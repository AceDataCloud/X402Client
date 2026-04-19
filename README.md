# @acedatacloud/x402-client

> X402 payment protocol client for AceDataCloud APIs.
> Pay per request with USDC — **no API key, no account, no session**.

Every [AceDataCloud](https://platform.acedata.cloud) API that costs money (chat completions, image generation, video generation, music generation, web search, …) now speaks the [x402 protocol](https://x402.org). This client wraps the full flow so you can call them as if they were free endpoints and let your wallet pay on the fly.

- 🟦 **Base** — USDC (ERC-20) via EIP-3009 `transferWithAuthorization`
- 🟪 **Solana** — USDC (SPL) via signed transfer
- 🟨 **SKALE** — USDC (bridged) via EIP-3009

All three networks settle through our own production facilitator at **`https://facilitator.acedata.cloud`** ([source](https://github.com/AceDataCloud/FacilitatorX402)).

---

## Table of contents

- [How it works](#how-it-works)
- [Install](#install)
- [Quick start](#quick-start)
- [Setup](#setup)
- [Running the real end-to-end tests](#running-the-real-end-to-end-tests)
- [Dynamic pricing regression](#dynamic-pricing-regression)
- [Proof of real on-chain settlement](#proof-of-real-on-chain-settlement)
- [Configuring other APIs](#configuring-other-apis)
- [Release flow (CalVer)](#release-flow-calver)

---

## How it works

```
┌─────────┐    1. POST /openai/chat/completions     ┌──────────────────────┐
│         │──────────(no Bearer, no X-Payment)────▶│                      │
│         │                                         │  api.acedata.cloud   │
│         │◀───── 2. 402 Payment Required ──────────│  (Kong → Gateway)    │
│ Client  │      { accepts: [{ network, payTo,      │                      │
│ (you)   │          maxAmountRequired, asset }] }  └──────────┬───────────┘
│         │                                                    │
│         │                                                    │ 3a. /verify
│         │                                                    ▼
│         │     4. POST /openai/chat/completions    ┌──────────────────────┐
│         │────── ( X-Payment: base64(envelope) )──▶│ facilitator.acedata  │
│         │                                         │        .cloud        │
│         │◀───── 5. 200 OK + API response ─────────│ (FacilitatorX402 —   │
└─────────┘                                         │  self-hosted,        │
                                                    │  EVM + Solana)       │
                                                    └──────────┬───────────┘
                                                               │ 3b. /settle
                                                               ▼
                                                        ⛓  on-chain USDC tx
```

**Step 1.** Client sends the request normally — no auth header.
**Step 2.** Gateway evaluates the JsonLogic cost rule for the endpoint + payload, converts Credits → atomic USDC via `X402_CREDITS_TO_USDC_RATE = 0.095215`, returns a `402` with an `accepts` list describing exactly which network, payTo address, asset contract, and amount to pay.
**Step 3a.** Client picks a network its wallet supports, signs a typed envelope (EIP-712 `TransferWithAuthorization` on EVM chains, or an SPL transfer transaction on Solana), base64-encodes it, and puts it in `X-Payment`.
**Step 4.** Gateway calls our facilitator `/verify` to check signature/nonce/amount/validity, then — **only if the upstream API call succeeds** — calls `/settle` to broadcast the on-chain transaction. This two-phase design means failed calls never charge you.
**Step 5.** Gateway returns the normal API response; the on-chain tx hash is recorded in the `ApiUsage` record's `metadata.x402_tx`.

**Why this design is safe**

- Price is **fully server-authoritative**: the client never hardcodes amounts; it signs exactly what the 402 advertised.
- Settlement is **post-success**: if the upstream API returns 5xx or fails, the facilitator never broadcasts the tx — no on-chain charge.
- Nonces are stored facilitator-side, so the same signed envelope cannot be replayed.

---

## Install

```bash
npm install @acedatacloud/x402-client
# extra peers depending on the chain(s) you use:
npm install ethers            # Base / SKALE
npm install @solana/web3.js   # Solana
```

The package auto-publishes on every push to `main` with a CalVer version (`YYYY.M.D[.N]`).

---

## Quick start

### Base or SKALE (EVM)

```ts
import { createX402Client } from '@acedatacloud/x402-client';

const client = createX402Client({
  baseURL: 'https://api.acedata.cloud',
  network: 'base',                  // or 'skale'
  evmProvider: window.ethereum,     // any EIP-1193 provider works
  evmAddress: '0xYourAddress...',
});

const result = await client.post('/openai/chat/completions', {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in 3 words' }],
  max_tokens: 10,
});

console.log(result.status);        // 200
console.log(result.paid);          // true
console.log(result.data.choices);  // the chat response
```

### Solana

```ts
import { createX402Client } from '@acedatacloud/x402-client';

const client = createX402Client({
  baseURL: 'https://api.acedata.cloud',
  network: 'solana',
  solanaWallet: phantomWallet,   // any wallet adapter with signTransaction()
});

const result = await client.post('/nano-banana/images', {
  model: 'nano-banana-2',
  prompt: 'a yellow banana on a white background',
  size: '1x1',
});
```

---

## Setup

1. **Fund a wallet with USDC** on the network you want to use:
   - Base — [USDC on Base](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
   - Solana — [USDC on Solana](https://explorer.solana.com/address/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
   - SKALE — bridged USDC on the SKALE `base` chain
2. **Install the package** as shown above.
3. **Pass a wallet/provider** that can sign EIP-712 (EVM) or a transaction (Solana). Any of the following work on EVM: MetaMask, Rabby, Coinbase Wallet, WalletConnect, viem's local account, a raw `ethers.Wallet`.
4. **Call the endpoint** — that's it. The client handles the 402 loop, signing, retry, and final parse.

> **Low-level signing (advanced)**
>
> If you need to produce the payment envelope yourself (e.g. in an agent framework), `signEVMPayment` and `signSolanaPayment` are exported and return exactly the base64-encoded `X-Payment` payload.

---

## Running the real end-to-end tests

This repo includes live, on-chain smoke tests. They require a **funded wallet** (a few cents of USDC is plenty).

```bash
git clone https://github.com/AceDataCloud/X402Client.git
cd X402Client
npm install

# Base — EVM private key
export BASE_TEST_PRIVATE_KEY=0x...
node --experimental-strip-types scripts/test-real-e2e.ts

# Solana — base58-encoded secret key
export SOLANA_TEST_PRIVATE_KEY=...
node --experimental-strip-types scripts/test-solana-e2e.ts

# SKALE — EVM private key with funded bridged USDC
export SKALE_BASE_PRIVATE_KEY=0x...
node --experimental-strip-types scripts/test-skale-e2e.ts
```

Each script:

1. Sends `POST /openai/chat/completions` with no auth.
2. Parses the returned `402`.
3. Signs the payment envelope.
4. Retries with `X-Payment`.
5. Prints the trace ID, chain tx hash, and the final chat response.

### What a successful run looks like (Base, trimmed)

```
→ POST https://api.acedata.cloud/openai/chat/completions
← 402 Payment Required
  accepts[0] network=base payTo=0x4d2f... maxAmountRequired=95215 (0.095215 USDC)
✓ signed EIP-712 TransferWithAuthorization
→ POST (with X-Payment)
← 200 OK
  x-trace-id: b60e7f0d-5baf-403f-999a-323f3ffeaa38
  x402_tx:    0x11313652b99cbb07c62fa1125ab1a41dc3c14593efa349c7699bd1b7736327ec
  reply:      "Hello there friend!"
```

---

## Dynamic pricing regression

`scripts/test-api-billing-scenarios.ts` runs **multiple APIs with different payloads** and verifies the advertised 402 amount exactly matches `floor(credits × 0.095215 × 1e6)`, then asserts an `ApiUsage` record with the on-chain tx hash lands in our logging pipeline.

```bash
export X402B_BASE_PAYER_PRIVATE_KEY=0x...   # Base wallet with a few cents of USDC
node --experimental-strip-types scripts/test-api-billing-scenarios.ts
```

Sample output (`2026-04-19`):

| Scenario                  | Endpoint              | Payload               | Credits | Advertised atomic USDC | Match | HTTP |
| ------------------------- | --------------------- | --------------------- | ------- | ---------------------- | ----- | ---- |
| nano-banana default       | `/nano-banana/images` | `model=nano-banana`   | 0.14    | 13 330                 | ✅     | 200  |
| nano-banana-2             | `/nano-banana/images` | `model=nano-banana-2` | 0.28    | 26 660                 | ✅     | 200  |
| midjourney fast (default) | `/midjourney/imagine` | *(no mode)*           | 0.27    | 25 708                 | ✅     | 200  |
| midjourney turbo          | `/midjourney/imagine` | `mode=turbo`          | 0.54    | 51 416                 | ✅     | 200  |

Every price came from the server (no client-side math) and matched our local Credits × rate formula to the atomic unit. **Dynamic pricing across different APIs and different payloads is fully operational.**

---

## Proof of real on-chain settlement

All transactions below were produced by running the scripts in this repo against `https://api.acedata.cloud` on `2026-04-19`. Click any hash to see it on the explorer:

### Base — `test-chat-payment-scenarios.ts`

- trace `b60e7f0d-5baf-403f-999a-323f3ffeaa38`
- tx [`0x11313652b99cbb07c62fa1125ab1a41dc3c14593efa349c7699bd1b7736327ec`](https://basescan.org/tx/0x11313652b99cbb07c62fa1125ab1a41dc3c14593efa349c7699bd1b7736327ec)

### Base — `test-api-billing-scenarios.ts` (4 scenarios → 4 real txs)

| API & payload            | Credits | Tx hash                                                                                                                                                             |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| nano-banana              | 0.14    | [`0x54783c69c6e5ac33690944584e1dca416f8f0615abc4bb248d7cbac9cde821de`](https://basescan.org/tx/0x54783c69c6e5ac33690944584e1dca416f8f0615abc4bb248d7cbac9cde821de) |
| nano-banana-2            | 0.28    | [`0x2102788ced25109cd0d0928b85c11badc92e059460ebb93a7a541dfe01b25f09`](https://basescan.org/tx/0x2102788ced25109cd0d0928b85c11badc92e059460ebb93a7a541dfe01b25f09) |
| midjourney imagine fast  | 0.27    | [`0x04ba94936a2a215b5ff27be32d2c92b45b273ca2e0f4d4f118eae993c31e315b`](https://basescan.org/tx/0x04ba94936a2a215b5ff27be32d2c92b45b273ca2e0f4d4f118eae993c31e315b) |
| midjourney imagine turbo | 0.54    | [`0x375fc6dc84c1838efb3c46fead13319ed939871fc356c8a00b10f06203bd19cd`](https://basescan.org/tx/0x375fc6dc84c1838efb3c46fead13319ed939871fc356c8a00b10f06203bd19cd) |

### Solana — `test-solana-e2e.ts`

- trace `b9f2bc74-2594-48b1-aca5-1bd6a5052319`
- tx [`3qB25xsyQ36eQsKqk5S57VQXJ1z9tG2rAytrS1tuKkC4NZkJAj2BfmqDdY34VvBabEjpJQwJ2MNXhN325VeeBVzr`](https://explorer.solana.com/tx/3qB25xsyQ36eQsKqk5S57VQXJ1z9tG2rAytrS1tuKkC4NZkJAj2BfmqDdY34VvBabEjpJQwJ2MNXhN325VeeBVzr?cluster=mainnet-beta)

### SKALE — `test-skale-e2e.ts`

- trace `c2448a00-678d-4279-bb43-4a56c6bdd6c7`
- tx [`0xc6c7affe2a0a2bb89306d4fdc4d84c8fb564533d52799b16361b891c1aae42e1`](https://skale-base-explorer.skalenodes.com/tx/0xc6c7affe2a0a2bb89306d4fdc4d84c8fb564533d52799b16361b891c1aae42e1)

All three chains are live. All settlements flow through our own facilitator at `https://facilitator.acedata.cloud`.

---

## Configuring other APIs

Every x402-enabled AceDataCloud endpoint uses the **same** client configuration — only the path and body change:

```ts
// chat
await client.post('/openai/chat/completions', { model, messages, max_tokens });

// image
await client.post('/nano-banana/images',      { model, prompt, size });
await client.post('/midjourney/imagine',      { prompt, mode });
await client.post('/flux/images',             { model, prompt });

// video
await client.post('/luma/videos',             { model, prompt });
await client.post('/sora/videos',             { model, prompt });

// music
await client.post('/suno/audios',             { model, prompt });

// search
await client.post('/serp/google-web-search',  { q });
```

You can preview any endpoint's price without paying by sending the request once without `X-Payment` and inspecting the returned `accepts[0].maxAmountRequired`.

At the time of writing, **121 of 122 public APIs have x402 pricing configured** — the only exception is the free `/fish/voices` listing.

---

## Release flow (CalVer)

This repo publishes on every push to `main`:

1. `.github/workflows/publish.yml` builds, computes today's version via CalVer (`YYYY.M.D[.N]`), patches `package.json`, runs `npm publish --provenance --access public`, and creates a matching GitHub Release.
2. The `version` field committed in `package.json` is a placeholder — the real number is stamped at publish time.

If you need a manual publish:

```bash
npm run version:date      # stamps today's date
npm publish --access public
```

---

## License

MIT © AceDataCloud
# @acedatacloud/x402-client

X402 payment protocol client for AceDataCloud APIs. It is designed to
plug into [`@acedatacloud/sdk`](https://github.com/AceDataCloud/SDK) —
the official SDK does all the API work, and this package only
contributes the part the SDK can't do by itself: signing an `X-Payment`
header when the server returns `402 Payment Required`.

Currently verified live on `base`, `solana`, and `skale` against
`https://api.acedata.cloud`.

## Install

```bash
npm install @acedatacloud/sdk @acedatacloud/x402-client
# Solana support:
npm install @solana/web3.js
```

If the npm package has not been released yet, you can install directly
from GitHub:

```bash
npm install github:AceDataCloud/X402Client
```

## Recommended Usage: Plug Into the SDK

The SDK already knows how to call every AceDataCloud endpoint
(`openai.chat`, `images`, `audio`, `video`, …). To pay for those
calls with x402 instead of a Bearer token, just pass a
`paymentHandler` produced by this package:

### EVM (Base / SKALE)

```ts
import { AceDataCloud } from '@acedatacloud/sdk';
import { createX402PaymentHandler } from '@acedatacloud/x402-client';

const client = new AceDataCloud({
  // No apiToken — per-request on-chain payment.
  paymentHandler: createX402PaymentHandler({
    network: 'base',               // or 'skale'
    evmProvider: window.ethereum,
    evmAddress: '0xYourAddress...',
  }),
});

const res = await client.openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in 3 words' }],
  max_tokens: 10,
});
console.log(res.choices[0].message.content);
```

### Solana

```ts
import { AceDataCloud } from '@acedatacloud/sdk';
import { createX402PaymentHandler } from '@acedatacloud/x402-client';

const client = new AceDataCloud({
  paymentHandler: createX402PaymentHandler({
    network: 'solana',
    solanaWallet: phantomWallet,
  }),
});

const task = await client.images.generate({ prompt: 'a sunset' });
const result = await task.wait();
```

On every request the SDK first sends the call unauthenticated. If the
server returns `402`, it passes the `accepts` list to the handler,
which signs and returns the `X-Payment` header. The SDK retries once
with that header. Task polling, streaming, retries, and error mapping
all keep working — this is a one-line swap from Bearer auth.

### Bootstrapping from env

A typical Node process picks up its wallet from environment:

```ts
import 'dotenv/config';
import { JsonRpcProvider, Wallet } from 'ethers';
import { AceDataCloud } from '@acedatacloud/sdk';
import { createX402PaymentHandler } from '@acedatacloud/x402-client';

const wallet = new Wallet(process.env.EVM_PRIVATE_KEY!, new JsonRpcProvider(process.env.BASE_RPC));

const client = new AceDataCloud({
  paymentHandler: createX402PaymentHandler({
    network: 'base',
    // Any EIP-1193-compatible provider works.
    evmProvider: {
      request: async ({ method, params }) => {
        if (method === 'eth_signTypedData_v4') {
          const [, typed] = params as [string, string];
          return wallet.signTypedData(
            JSON.parse(typed).domain,
            JSON.parse(typed).types,
            JSON.parse(typed).message,
          );
        }
        throw new Error(`unsupported: ${method}`);
      },
    },
    evmAddress: wallet.address,
  }),
});
```

## Low-Level Client (No SDK)

If you don't want to use the SDK and just need to send a single
x402-authenticated request, the package also exposes a stand-alone
`createX402Client` that wraps `fetch`:

```ts
import { createX402Client } from '@acedatacloud/x402-client';

const client = createX402Client({
  baseURL: 'https://api.acedata.cloud',
  network: 'solana',
  solanaWallet: phantomWallet,
});

const result = await client.post('/openai/chat/completions', {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in 3 words' }],
  max_tokens: 10,
});
```

This exists mainly for quick experiments and the low-level e2e
scripts. For production integrations, prefer the SDK path above — you
get task polling, SSE streaming, retries, typed errors, and coverage
for every AceDataCloud endpoint for free.

## Low-level signing

```ts
import { signSolanaPayment, signEVMPayment } from '@acedatacloud/x402-client';

const envelope = await signSolanaPayment(paymentRequirement, wallet);
const header = btoa(JSON.stringify(envelope));
```

## Pricing For Other APIs

The client does **not** hardcode AceDataCloud prices.

For any x402-enabled API, the server returns the real charge in the first `402` response:

```json
{
  "accepts": [
    {
      "network": "base",
      "maxAmountRequired": "95215",
      "payTo": "...",
      "asset": "..."
    }
  ]
}
```

That means:

- price is determined server-side by the API path, model, and request body
- different APIs can return different `maxAmountRequired`
- the client simply signs exactly what the server asks for

If you want to preview the price for another API without paying yet, send the same request once without Bearer auth and without `X-Payment`, then inspect the returned `accepts` list.

## Configuring Other APIs

The configuration is the same for all x402-enabled AceDataCloud APIs:

- `baseURL`: usually `https://api.acedata.cloud`
- `network`: `base`, `solana`, or `skale`
- wallet:
  - `solanaWallet` for Solana
  - `evmProvider` + `evmAddress` for Base or SKALE
- actual API path and body:
  - `/openai/chat/completions`
  - `/suno/audios`
  - any other AceDataCloud endpoint that returns `402`

Example with another endpoint:

```ts
const result = await client.post('/suno/audios', {
  prompt: 'a short synthwave loop',
  make_instrumental: true,
});
```

If an endpoint does **not** return `402`, it is not currently using x402 payment flow and should be called with its normal auth path instead.

## Python

There is currently no Python x402 signer. The Python SDK
(`acedatacloud`) already exposes the same `payment_handler` hook as
the TypeScript SDK — any callable that returns
`{"headers": {"X-Payment": "<base64>"}}` works. A Python port of the
signing logic in this package is tracked as future work; contributions
are welcome.

## Live Verification

The repository includes a three-network regression script:

```bash
node --experimental-strip-types scripts/test-chat-payment-scenarios.ts
```

Latest successful live run on `2026-04-19`:

- Base
  - trace: `b60e7f0d-5baf-403f-999a-323f3ffeaa38`
  - tx: [`0x11313652b99cbb07c62fa1125ab1a41dc3c14593efa349c7699bd1b7736327ec`](https://basescan.org/tx/0x11313652b99cbb07c62fa1125ab1a41dc3c14593efa349c7699bd1b7736327ec)
- Solana
  - trace: `b9f2bc74-2594-48b1-aca5-1bd6a5052319`
  - tx: [`3qB25xsyQ36eQsKqk5S57VQXJ1z9tG2rAytrS1tuKkC4NZkJAj2BfmqDdY34VvBabEjpJQwJ2MNXhN325VeeBVzr`](https://explorer.solana.com/tx/3qB25xsyQ36eQsKqk5S57VQXJ1z9tG2rAytrS1tuKkC4NZkJAj2BfmqDdY34VvBabEjpJQwJ2MNXhN325VeeBVzr?cluster=mainnet-beta)
- SKALE
  - trace: `c2448a00-678d-4279-bb43-4a56c6bdd6c7`
  - tx: [`0xc6c7affe2a0a2bb89306d4fdc4d84c8fb564533d52799b16361b891c1aae42e1`](https://skale-base-explorer.skalenodes.com/tx/0xc6c7affe2a0a2bb89306d4fdc4d84c8fb564533d52799b16361b891c1aae42e1)

## Release Flow

This repository is wired for real npm publishing through GitHub Actions:

- `CI` workflow:
  - `npm ci`
  - `npm run build`
  - `npm pack --json --dry-run`
- `Publish` workflow:
  - triggers on GitHub Release `published`
  - can also be run manually with `workflow_dispatch`
  - publishes with `npm publish --provenance --access public`

Operational prerequisite:

- set repository secret `NPM_TOKEN`

Without `NPM_TOKEN`, the workflow can build and validate the package, but it cannot publish to npm.

## How It Works

1. Client sends API request without normal Bearer auth
2. Server returns `402` with payment requirements
3. Client picks the configured network
4. Solana path signs and sends the token transfer
5. EVM path signs `TransferWithAuthorization`
6. Client retries with `X-Payment`
7. Server verifies and settles the payment, then returns the API result

## Releasing

Versions follow **CalVer** (`YYYY.M.D`) to match the convention used by AceDataCloud MCP servers. The date is stamped automatically at publish time by `prepublishOnly`, so the `version` field in the committed `package.json` is a placeholder and does not need manual bumping.

```bash
# preview today's version without touching package.json
npm run version:date:dry

# stamp the date into package.json manually (usually not needed)
npm run version:date

# publish (prepublishOnly stamps the date + runs build)
npm publish --access public
```

If multiple releases are cut on the same day, the helper auto-bumps to `YYYY.M.D.1`, `YYYY.M.D.2`, … Published npm versions will always reflect the actual publish day.

## End-to-End Tests

Real network signing flows live under `scripts/` and settle actual USDC on chain against `https://api.acedata.cloud`:

```bash
npx tsx scripts/test-real-e2e.ts    # Base (EVM)
npx tsx scripts/test-solana-e2e.ts  # Solana
npx tsx scripts/test-skale-e2e.ts   # SKALE
```

The SKALE script reads `SKALE_BASE_PRIVATE_KEY` from a repo-level `.env` (or the process environment). Base and Solana scripts use dedicated funded test wallets hardcoded in each file.
