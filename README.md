# @acedatacloud/x402-client

> X402 payment protocol client for [AceDataCloud](https://platform.acedata.cloud) APIs.
> Pay per request with USDC — **no API key, no account, no session**.

This is a monorepo with one package per language, each designed as a **plugin** for the official AceDataCloud SDK:

| Language   | Package                                                                    | Plugs into                                             |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| TypeScript | [`@acedatacloud/x402-client`](./typescript) — npm                          | [`@acedatacloud/sdk`](https://github.com/AceDataCloud/SDK) |
| Python     | [`acedatacloud-x402`](./python) — PyPI                                     | [`acedatacloud`](https://pypi.org/project/acedatacloud/)   |
| Go         | [`github.com/AceDataCloud/X402Client/go`](./go) — go module (tag-based)    | [`github.com/AceDataCloud/SDK/go`](https://github.com/AceDataCloud/SDK)  |

The SDK does all the API work (task polling, SSE streaming, retries, typed errors). This package only contributes one thing: signing an `X-Payment` header when the server returns `402 Payment Required`.

- 🟦 **Base** — USDC (ERC-20) via EIP-3009 `TransferWithAuthorization`
- 🟪 **Solana** — USDC (SPL) via signed `TransferChecked`
- 🟨 **SKALE** — USDC (bridged) via EIP-3009

All three settle through our production facilitator at **`https://facilitator.acedata.cloud`** ([source](https://github.com/AceDataCloud/FacilitatorX402)).

---

## How it works

```
SDK call (no Bearer token)
      │
      ▼
 api.acedata.cloud  ── 402 Payment Required + accepts[] ──▶  SDK
                                                             │
                                             payment handler │ (this package)
                                                             ▼
                                                    sign X-Payment envelope
                                                             │
      ◀────────────── retry with X-Payment ──────────────────┘
200 OK (+ x402_tx hash in headers)
```

---

## Quick start (TypeScript)

```ts
import { AceDataCloud } from '@acedatacloud/sdk';
import { createX402PaymentHandler } from '@acedatacloud/x402-client';

const client = new AceDataCloud({
  paymentHandler: createX402PaymentHandler({
    network: 'base',
    evmProvider: window.ethereum,
    evmAddress: '0x...',
  }),
});

await client.openai.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hi' }],
});
```

See **[typescript/README.md](./typescript/README.md)** for the full guide.

## Quick start (Python)

```python
from acedatacloud import AceDataCloud
from acedatacloud_x402 import create_x402_payment_handler, EVMAccountSigner

client = AceDataCloud(
    payment_handler=create_x402_payment_handler(
        network="base",
        evm_signer=EVMAccountSigner.from_private_key("0x..."),
    ),
)

client.openai.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Hi"}],
)
```

See **[python/README.md](./python/README.md)** for the full guide.

---

## Repository layout

```
.
├── typescript/   # @acedatacloud/x402-client — published to npm
│   ├── src/
│   ├── scripts/  # live on-chain e2e tests (Base, Solana, SKALE)
│   └── package.json
├── python/       # acedatacloud-x402 — published to PyPI
│   ├── src/acedatacloud_x402/
│   ├── tests/
│   └── pyproject.toml
└── .github/workflows/
    ├── ci.yml            # lint+build both packages
    ├── publish.yml       # npm (TS) on push to main (CalVer)
    └── publish-pypi.yml  # PyPI (Python) on push to main (CalVer)
```

## Development

```bash
# TypeScript
cd typescript && npm install && npm run build

# Python
cd python && pip install -e ".[dev]" && pytest && ruff check .
```

---

## License

MIT © AceDataCloud
# @acedatacloud/x402-client

> X402 payment protocol client for AceDataCloud APIs.
> Pay per request with USDC — **no API key, no account, no session**.

Every [AceDataCloud](https://platform.acedata.cloud) API that costs money (chat completions, image generation, video generation, music generation, web search, …) now speaks the [x402 protocol](https://x402.org). This package ships the only piece the SDK can't do by itself: signing an `X-Payment` header when the server returns `402 Payment Required`. It plugs straight into [`@acedatacloud/sdk`](https://github.com/AceDataCloud/SDK) as a `paymentHandler`.

- 🟦 **Base** — USDC (ERC-20) via EIP-3009 `transferWithAuthorization`
- 🟪 **Solana** — USDC (SPL) via signed transfer
- 🟨 **SKALE** — USDC (bridged) via EIP-3009

All three networks settle through our production facilitator at **`https://facilitator.acedata.cloud`** ([source](https://github.com/AceDataCloud/FacilitatorX402)).

---

## How it works

```
SDK call (no Bearer token)
      │
      ▼
 api.acedata.cloud  ── 402 Payment Required + accepts[] ──▶  SDK
                                                             │
                                              paymentHandler │ (this package)
                                                             ▼
                                                    sign X-Payment envelope
                                                             │
      ◀────────────── retry with X-Payment ──────────────────┘
200 OK (+ x402_tx hash in headers)
```

The SDK keeps doing everything it already does — task polling, SSE streaming, retries, typed errors — and this package contributes exactly one thing: the per-chain signature.

---

## Install

```bash
npm install @acedatacloud/sdk @acedatacloud/x402-client
# extra peers depending on the chain(s) you use:
npm install ethers            # Base / SKALE
npm install @solana/web3.js   # Solana
```

If the npm package is not yet published you can install from GitHub:

```bash
npm install @acedatacloud/sdk github:AceDataCloud/X402Client
```

---

## Quick start

### Base or SKALE (EVM)

```ts
import { AceDataCloud } from '@acedatacloud/sdk';
import { createX402PaymentHandler } from '@acedatacloud/x402-client';

const client = new AceDataCloud({
  // No apiToken — per-request on-chain payment.
  paymentHandler: createX402PaymentHandler({
    network: 'base',                // or 'skale'
    evmProvider: window.ethereum,   // any EIP-1193 provider works
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
    solanaWallet: phantomWallet,     // any wallet adapter with signTransaction()
  }),
});

const task = await client.images.generate({
  provider: 'nano-banana',
  prompt: 'a yellow banana on a white background',
});
const result = await task.wait();    // task polling handled by the SDK
```

Every AceDataCloud endpoint the SDK exposes (`openai.chat`, `images`, `audio`, `video`, `search`, …) works the same way.

---

## Setup

1. **Fund a wallet with USDC** on the network you want to use:
   - Base — [USDC on Base](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
   - Solana — [USDC on Solana](https://explorer.solana.com/address/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
   - SKALE — bridged USDC on SKALE Europa
2. A few cents of USDC is enough for most single requests (prices are listed at [platform.acedata.cloud](https://platform.acedata.cloud)).
3. Construct the handler with whatever wallet primitive you have: a browser provider, a Node `ethers.Wallet`, `@solana/web3.js` keypair, etc.

---

## Low-level signing

If you need to produce an `X-Payment` envelope outside the SDK — for example in a custom fetch wrapper, tests, or an agent framework — the raw signing primitives are exported directly:

```ts
import { signSolanaPayment, signEVMPayment } from '@acedatacloud/x402-client';

const envelope = await signSolanaPayment(paymentRequirement, wallet);
const header = btoa(JSON.stringify(envelope));
```

The live e2e scripts under `scripts/` use this low-level entry point to settle real USDC on chain. For application code, prefer the SDK path above.

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

---

## Dynamic pricing regression

`scripts/test-api-billing-scenarios.ts` runs multiple APIs with different payloads and verifies the advertised 402 amount exactly matches `floor(credits × 0.095215 × 1e6)`, then asserts an `ApiUsage` record with the on-chain tx hash lands in our logging pipeline.

```bash
export X402B_BASE_PAYER_PRIVATE_KEY=0x...   # Base wallet with a few cents of USDC
node --experimental-strip-types scripts/test-api-billing-scenarios.ts
```

---

## Proof of real on-chain settlement

Latest successful live runs on `2026-04-19`:

- **Base** — tx [`0x11313652...5327ec`](https://basescan.org/tx/0x11313652b99cbb07c62fa1125ab1a41dc3c14593efa349c7699bd1b7736327ec)
- **Solana** — tx [`3qB25xsy...eBVzr`](https://explorer.solana.com/tx/3qB25xsyQ36eQsKqk5S57VQXJ1z9tG2rAytrS1tuKkC4NZkJAj2BfmqDdY34VvBabEjpJQwJ2MNXhN325VeeBVzr?cluster=mainnet-beta)
- **SKALE** — tx [`0xc6c7affe...aae42e1`](https://skale-base-explorer.skalenodes.com/tx/0xc6c7affe2a0a2bb89306d4fdc4d84c8fb564533d52799b16361b891c1aae42e1)

All three chains are live. All settlements flow through our own facilitator at `https://facilitator.acedata.cloud`.

---

## Pricing for other APIs

The handler does **not** hardcode AceDataCloud prices. For any x402-enabled API, the server returns the real charge in the first `402` response:

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
- the client signs exactly what the server asks for

If you want to preview the price for another API without paying yet, send the same request once without Bearer auth and without `X-Payment`, then inspect the returned `accepts` list.

At the time of writing, **121 of 122 public APIs have x402 pricing configured** — the only exception is the free `/fish/voices` listing.

---

## Python

There is currently no Python x402 signer. The Python SDK (`acedatacloud`) already exposes the same `payment_handler` hook as the TypeScript SDK — any callable that returns `{"headers": {"X-Payment": "<base64>"}}` works. A Python port of the signing logic in this package is tracked as future work; contributions are welcome.

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
