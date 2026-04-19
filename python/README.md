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

## Development

```bash
cd python
pip install -e ".[dev]"
pytest
ruff check .
```

## License

MIT © AceDataCloud
