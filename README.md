# @acedatacloud/x402-client

> X402 payment protocol client for [AceDataCloud](https://platform.acedata.cloud) APIs.
> Pay per request with USDC — **no API key, no account, no session**.

This is a monorepo with one package per language, each designed as a **plugin** for the official AceDataCloud SDK:

| Language   | Package                                                                    | Plugs into                                             |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| TypeScript | [`@acedatacloud/x402-client`](./typescript) — npm                          | [`@acedatacloud/sdk`](https://github.com/AceDataCloud/SDK) |
| Python     | [`acedatacloud-x402`](./python) — PyPI                                     | [`acedatacloud`](https://pypi.org/project/acedatacloud/)   |

The SDK does all the API work (task polling, SSE streaming, retries, typed errors). This package only contributes one thing: signing an `X-Payment` header when the server returns `402 Payment Required`.

- 🟦 **Base** — USDC (ERC-20) via EIP-3009 `TransferWithAuthorization` (`exact` scheme) **and** Permit2 `PermitWitnessTransferFrom` (`upto` scheme — pay-only-what-you-used metering for chat / streaming APIs)
- 🟪 **Solana** — USDC (SPL) via signed `TransferChecked`
- 🟨 **SKALE** — USDC (bridged) via EIP-3009

All settle through our production facilitator at **`https://facilitator.acedata.cloud`** ([source](https://github.com/AceDataCloud/FacilitatorX402)).

Two settlement modes:

| Scheme  | Used for                                  | What gets settled                                   |
| ------- | ----------------------------------------- | --------------------------------------------------- |
| `exact` | Fixed-price endpoints (image, video, ...) | Exactly `maxAmountRequired` from the 402            |
| `upto`  | Metered endpoints (chat, completions)     | Real cost (≤ `maxAmountRequired`), deferred settle  |

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

Fixed-price endpoint (`exact` scheme — Base, Solana, SKALE):

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

Metered endpoint (`upto` scheme — Base only, pay-only-what-you-used). One-time
setup approves Permit2 to pull USDC on the payer's behalf:

```bash
npx tsx scripts/approve-permit2.ts --network base \
  --token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

Then prefer the `upto` scheme on the handler:

```ts
import { approvePermit2, createX402PaymentHandler } from '@acedatacloud/x402-client';

const client = new AceDataCloud({
  paymentHandler: createX402PaymentHandler({
    network: 'base',
    evmProvider: window.ethereum,
    evmAddress: '0x...',
    preferScheme: 'upto', // metered, deferred settle
  }),
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

For the metered `upto` scheme, approve Permit2 once and add `prefer_scheme`:

```bash
acedatacloud-x402 approve-permit2 --network base \
  --token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

```python
client = AceDataCloud(
    payment_handler=create_x402_payment_handler(
        network="base",
        evm_signer=EVMAccountSigner.from_private_key("0x..."),
        prefer_scheme="upto",
    ),
)
```

See **[python/README.md](./python/README.md)** for the full guide.

---

## Verified end-to-end

Live on-chain settlements through `https://facilitator.acedata.cloud`, run from
[`typescript/scripts`](./typescript/scripts) and [`python/tests`](./python/tests):

### Fixed price (`exact` scheme, **2026-04-25**)

| Network    | API endpoint                | USDC paid | Settlement tx |
| ---------- | --------------------------- | --------- | ------------- |
| 🟦 Base    | `POST /openai/chat/completions` | 0.020568 | [`0xa1697ee4…7c2708`](https://basescan.org/tx/0xa1697ee44d6c8d14c8a26c9a41b507fb718bac85c9153396b3e23b565a7c2708) |
| 🟦 Base    | `POST /midjourney/imagine` (turbo) | 0.025708 | [`0x2d161b04…84539b2`](https://basescan.org/tx/0x2d161b04589aad026e6c575509f1867bbeeba6bff6f17064b1a423dd084539b2) |
| 🟨 SKALE   | `POST /openai/chat/completions` | 0.020568 | [`0x621b361a…7b12979`](https://elated-tan-skat.explorer.mainnet.skalenodes.com/tx/0x621b361ad78e6bb6f910dba603a4267bca92ca8748894011cced803227b12979) |
| 🟨 SKALE   | `POST /midjourney/imagine` (turbo) | 0.025708 | [`0x0e66f646…6b827d3`](https://elated-tan-skat.explorer.mainnet.skalenodes.com/tx/0x0e66f646bdfbf2e29ca8bc3bc19f252aa6109d8cf7aff1ab6836111e56b827d3) |
| 🟪 Solana  | `POST /openai/chat/completions` | 0.095215 | [`4fsVAukg…D1Gd3t`](https://solscan.io/tx/4fsVAukgeFpGezcmu84xu4gYm1ANoAzgked8zhV78g2ffFL9AMpNP64Q1QkLoHtxgLuaPXcACBPZiLykwKD1Gd3t) |
| 🟪 Solana  | `POST /midjourney/imagine` (turbo) | 0.115215 | [`5G438pwj…WUeBj`](https://solscan.io/tx/5G438pwjGBPjekkZZgHsqKgkV43nxCLoqMoue7J6aHhRVCYhtnR45EE2SzffnsbQMVxceb8BhdZFA3jTECNWUeBj) |

### Metered (`upto` scheme, **2026-05-31** — Base mainnet)

Each 402 quoted a maximum (`0.004 – 5 USDC`); the facilitator's deferred
settle pulled the **real** post-inference cost, which always landed within ±1
atomic of the gateway's DB cost rule for that model.

| Model                          | Cost (atomic) | Cost (USDC) | Settlement tx |
| ------------------------------ | ------------- | ----------- | ------------- |
| `claude-sonnet-4-5-20250929`   | 151           | 0.000151    | [`0xc1f90cc6…3b093dd8`](https://basescan.org/tx/0xc1f90cc6c2d71b50ab863ce3ac6a940a0c30291c156b71ba839cdfef3b093dd8) |
| `gpt-5.5`                      | 135           | 0.000135    | [`0xda8f0ff0…feeafcca57`](https://basescan.org/tx/0xda8f0ff09aeccd8b175188984b3f2d1b84b9c78d933625dd118dd8feeafcca57) |
| `glm-4.7`                      | 262           | 0.000262    | [`0xae9bba18…07c5dda`](https://basescan.org/tx/0xae9bba183545283d3b67c245f41f840b948c4141d90a437ffb978ebfc07c5dda) |

Payer wallet [`0x5d4f08D5…fA41B105`](https://basescan.org/address/0x5d4f08D5c2bb60703284bc06671Eb680fA41B105).

For a step-by-step walkthrough of the upto flow (including the one-time
`approve(Permit2, ∞)` and the deferred `/record` settle), see
[**docs/UPTO_DEMO.md**](./docs/UPTO_DEMO.md). For the `exact` SKALE flow, see
[**docs/SKALE_DEMO.md**](./docs/SKALE_DEMO.md).

Reproduce with the live e2e scripts (need a funded test wallet for each chain):

```bash
cd typescript

# Base (exact) / SKALE — set X402B_BASE_PAYER_PRIVATE_KEY or SKALE_BASE_PRIVATE_KEY
TEST_API_PATH='/openai/chat/completions' \
  TEST_BODY='{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"max_tokens":10}' \
  npx tsx scripts/test-real-e2e.ts        # Base (exact)
npx tsx scripts/test-skale-e2e.ts         # SKALE

# Base (upto) — one-time Permit2 approval, then metered chat call
npx tsx scripts/approve-permit2.ts --network base --token 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
npx tsx scripts/test-upto-e2e.ts          # Base (upto, deferred settle)

# Solana — set X402B_SOLANA_PAYER_PRIVATE_KEY (base58)
npx tsx scripts/test-solana-e2e.ts
```

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
