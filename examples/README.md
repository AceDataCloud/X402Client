# X402 agent integrations

Give an autonomous agent a **wallet**, not an API key.

These examples show how to expose AceData Cloud APIs (chat, search, image,
music, video) as **paid tools** inside the common agent frameworks. Each tool
call settles on-chain in USDC via the [x402 protocol](https://x402.org) — so
you never provision, rotate, or rate-limit per-agent API keys. The agent pays
for exactly what it uses, per request.

Everything here builds on the published clients:

```bash
pip install acedatacloud acedatacloud-x402
# plus the framework you want:
pip install langchain-core        # langchain_paid_tools.py
pip install openai-agents         # openai_agents_paid_tools.py
pip install crewai                # crewai_paid_tools.py
pip install mcp                   # mcp_x402_server.py
```

Set a funded wallet key (Base USDC by default — swap `network` for `solana`/`skale`):

```bash
export X402_PRIVATE_KEY=0x...     # a wallet holding USDC on the chosen network
```

| File | Framework | What it demonstrates |
| --- | --- | --- |
| `python/langchain_paid_tools.py` | LangChain | `@tool`s that call AceData, paid per-call |
| `python/openai_agents_paid_tools.py` | OpenAI Agents SDK | `function_tool`s backed by x402 |
| `python/crewai_paid_tools.py` | CrewAI | a `BaseTool` an agent can call |
| `python/mcp_x402_server.py` | MCP | an MCP server exposing x402-paid tools to any MCP client |

## The one shared idea

A framework "tool" is just a function. Inside it, call the AceData SDK with an
x402 payment handler attached — the handler signs a `PAYMENT-SIGNATURE` header when the
API answers `402 Payment Required`, and the SDK retries transparently:

```python
from acedatacloud import AceDataCloud
from acedatacloud_x402 import create_x402_payment_handler, EVMAccountSigner

client = AceDataCloud(
    base_url="https://x402.acedata.cloud",
    payment_handler=create_x402_payment_handler(
        network="base",
        evm_signer=EVMAccountSigner.from_private_key(os.environ["X402_PRIVATE_KEY"]),
    ),
)
# client.openai.chat.completions.create(...) / client.images.generate(...) now
# cost USDC per call — no account, no API key.
```

The handler accepts `base`, `skale`, and `solana` as configuration aliases;
x402 v2 requirements on the wire use canonical CAIP-2 network IDs.

> These are illustrative examples, not a published package. Run them against a
> testnet wallet first. For metered endpoints (chat, image edits) the handler
> can prefer the `upto` scheme — see the [x402-client README](../python/README.md).
