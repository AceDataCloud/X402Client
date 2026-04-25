# @acedatacloud/x402-client

> X402 payment protocol client for [AceDataCloud](https://platform.acedata.cloud) APIs.
> Pay per request with USDC — **no API key, no account, no session**.

This is a monorepo with one package per language, each designed as a **plugin** for the official AceDataCloud SDK:

| Language   | Package                                                                    | Plugs into                                             |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| TypeScript | [`@acedatacloud/x402-client`](./typescript) — npm                          | [`@acedatacloud/sdk`](https://github.com/AceDataCloud/SDK) |
| Python     | [`acedatacloud-x402`](./python) — PyPI                                     | [`acedatacloud`](https://pypi.org/project/acedatacloud/)   |

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
