# @acedatacloud/x402-client

X402 payment protocol client for AceDataCloud APIs. It wraps the standard `402 Payment Required` flow:

1. send the API request
2. parse the returned payment requirement
3. sign with the configured wallet
4. retry with `X-Payment`

Currently verified live against `https://api.acedata.cloud/openai/chat/completions` on `base`, `solana`, and `skale`.

## Install

After the first npm release:

```bash
npm install @acedatacloud/x402-client
# Solana support:
npm install @solana/web3.js
```

If `npm install` still returns `404`, the package has not been released to npm yet. In that case, use the GitHub source temporarily:

```bash
npm install github:AceDataCloud/X402Client
```

## Usage

### Solana

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

console.log(result.status);
console.log(result.paid);
console.log(result.data);
```

### Base / SKALE

```ts
import { createX402Client } from '@acedatacloud/x402-client';

const client = createX402Client({
  baseURL: 'https://api.acedata.cloud',
  network: 'base', // or 'skale'
  evmProvider: window.ethereum,
  evmAddress: '0xYourAddress...',
});

const result = await client.post('/openai/chat/completions', {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in 3 words' }],
  max_tokens: 10,
});
```

### Low-level signing

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
