# @acedatacloud/x402-client — Python

> X402 payment protocol client for AceDataCloud APIs.
> Plug-in for the [`acedatacloud`](https://pypi.org/project/acedatacloud/) SDK.

Pay-per-request with USDC — no API key, no account, no session. When an AceDataCloud API returns `402 Payment Required`, this package signs the payment envelope and returns it as a `PAYMENT-SIGNATURE` header; the SDK retries transparently.

- 🟦 **Base** — USDC (ERC-20) via EIP-3009 `TransferWithAuthorization`
- 🟪 **Solana** — USDC (SPL) via signed `TransferChecked`
- 🟨 **SKALE** — USDC (bridged) via EIP-3009

## Install

```bash
pip install acedatacloud acedatacloud-x402
```

## Quick start

### Base or SKALE (EVM)

```python
from acedatacloud import AceDataCloud
from acedatacloud_x402 import create_x402_payment_handler, EVMAccountSigner

client = AceDataCloud(
    base_url="https://x402.acedata.cloud",
    payment_handler=create_x402_payment_handler(
        network="base",                         # or "skale"
        evm_signer=EVMAccountSigner.from_private_key("0x..."),
    ),
)

res = client.openai.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "Say hi in 3 words"}],
    max_tokens=10,
)
print(res.choices[0].message.content)
```

The handler accepts `base`, `skale`, and `solana` as configuration aliases.
Wire requirements use canonical CAIP-2 IDs: `eip155:8453`,
`eip155:1187947933`, and `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`.

### Solana

Solana payments use a recent blockhash and must reach facilitator broadcast within 60 seconds. Use this network only for APIs expected to complete inside that window; long-running protected calls require a future durable-nonce settlement flow.

```python
from acedatacloud import AceDataCloud
from acedatacloud_x402 import create_x402_payment_handler, SolanaKeypairSigner

client = AceDataCloud(
    base_url="https://x402.acedata.cloud",
    payment_handler=create_x402_payment_handler(
        network="solana",
        solana_signer=SolanaKeypairSigner.from_base58("..."),
    ),
)

task = client.images.generate(
    provider="nano-banana",
    prompt="a yellow banana on a white background",
)
result = task.wait()
```

The same handler works with `AsyncAceDataCloud`:

```python
from acedatacloud import AsyncAceDataCloud

client = AsyncAceDataCloud(
    base_url="https://x402.acedata.cloud",
    payment_handler=create_x402_payment_handler(network="base", evm_signer=signer),
)
```

## Low-level signing

If you need to produce a `PAYMENT-SIGNATURE` envelope without going through the SDK:

```python
from acedatacloud_x402 import sign_evm_payment, sign_solana_payment

envelope = sign_evm_payment(requirement, evm_signer)          # dict
envelope = sign_solana_payment(requirement, solana_signer)    # dict
# base64-encode json(envelope) → PAYMENT-SIGNATURE header value
```

The signers already return the canonical v2
`{ "x402Version": 2, "accepted": requirement, "payload": ... }` envelope.

## Metered billing — the `upto` scheme

For APIs whose true cost is only known after the response (chat completions,
image edits, etc.) AceDataCloud advertises an extra `upto` accept entry
alongside `exact`. `upto` uses Uniswap Permit2 to authorize a **ceiling**;
the server settles the actual amount at `/record` time (which may be `0`).

```python
from acedatacloud_x402 import (
    EVMAccountSigner,
    create_x402_payment_handler,
)

client = AceDataCloud(
    base_url="https://x402.acedata.cloud",
    payment_handler=create_x402_payment_handler(
        network="base",
        evm_signer=EVMAccountSigner.from_private_key("0x..."),
        prefer_scheme="upto",   # opt-in; defaults to whatever the server lists first
    ),
)
```

A one-time on-chain `ERC20.approve(Permit2, ∞)` is required before the first
`upto` payment. Use the bundled CLI:

```bash
pip install 'acedatacloud-x402[cli]'
X402_PRIVATE_KEY=0x... acedatacloud-x402 approve-permit2 --network base
```

or programmatically:

```python
from acedatacloud_x402 import EVMAccountSigner, approve_permit2

approve_permit2(
    rpc_url="https://mainnet.base.org",
    signer=EVMAccountSigner.from_private_key("0x..."),
    token_address="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  # USDC on Base
)
```

The helper is idempotent — re-running it after the allowance is already at
or above the requested amount returns `{"skipped": true}` without sending a
transaction.

### Verified live on Base mainnet (2026-05-31)

End-to-end runs through `https://facilitator.acedata.cloud` against three
metered chat endpoints, payer wallet
[`0x5d4f08D5c2bb60703284bc06671Eb680fA41B105`](https://basescan.org/address/0x5d4f08D5c2bb60703284bc06671Eb680fA41B105):

| API | Model | Credits charged | USDC settled | Tx |
| --- | --- | --- | --- | --- |
| `POST /v1/chat/completions` | claude-sonnet-4-5 | 0.001587893 | 0.000151 | [`0xc1f90cc6…b093dd8`](https://basescan.org/tx/0xc1f90cc6c2d71b50ab863ce3ac6a940a0c30291c156b71ba839cdfef3b093dd8) |
| `POST /openai/chat/completions` | gpt-5.5 | 0.001427432 | 0.000135 | [`0xda8f0ff0…fcca57`](https://basescan.org/tx/0xda8f0ff09aeccd8b175188984b3f2d1b84b9c78d933625dd118dd8feeafcca57) |
| `POST /glm/chat/completions` | glm-4.7 | 0.002753977 | 0.000262 | [`0xae9bba18…7c5dda`](https://basescan.org/tx/0xae9bba183545283d3b67c245f41f840b948c4141d90a437ffb978ebfc07c5dda) |

Each call advertised both `exact` and `upto`; the handler picked `upto`, the
worker emitted an `X-Usage-Exempt` placeholder on the first `/record`, and the
facilitator settled at the actual measured cost on the worker's later
`/record`. Each settled amount matches the per-model JSONLogic cost rule in
the gateway DB (within ±1 atomic for rounding).

## Development

```bash
cd python
pip install -e ".[dev]"
pytest
ruff check .
```

## License

MIT © AceDataCloud
