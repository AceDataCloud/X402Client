# @acedatacloud/x402-client — Python

> X402 payment protocol client for AceDataCloud APIs.
> Plug-in for the [`acedatacloud`](https://pypi.org/project/acedatacloud/) SDK.

Pay-per-request with USDC — no API key, no account, no session. When an AceDataCloud API returns `402 Payment Required`, this package signs the payment envelope and returns it as an `X-Payment` header; the SDK retries transparently.

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

### Solana

```python
from acedatacloud import AceDataCloud
from acedatacloud_x402 import create_x402_payment_handler, SolanaKeypairSigner

client = AceDataCloud(
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
    payment_handler=create_x402_payment_handler(network="base", evm_signer=signer),
)
```

## Low-level signing

If you need to produce an `X-Payment` envelope without going through the SDK:

```python
from acedatacloud_x402 import sign_evm_payment, sign_solana_payment

envelope = sign_evm_payment(requirement, evm_signer)          # dict
envelope = sign_solana_payment(requirement, solana_signer)    # dict
# base64-encode json(envelope) → X-Payment header value
```

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

## Development

```bash
cd python
pip install -e ".[dev]"
pytest
ruff check .
```

## License

MIT © AceDataCloud
