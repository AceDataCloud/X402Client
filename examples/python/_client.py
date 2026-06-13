"""Shared x402-paid AceData Cloud client used by the agent examples.

A funded wallet replaces the API key: every SDK call settles on-chain in USDC
via x402, so there is nothing to provision per agent.
"""

import os

from acedatacloud import AceDataCloud
from acedatacloud_x402 import EVMAccountSigner, create_x402_payment_handler


def build_client(network: str = "base") -> AceDataCloud:
    key = os.environ.get("X402_PRIVATE_KEY")
    if not key:
        raise RuntimeError("set X402_PRIVATE_KEY to a wallet holding USDC on the chosen network")
    return AceDataCloud(
        payment_handler=create_x402_payment_handler(
            network=network,
            evm_signer=EVMAccountSigner.from_private_key(key),
        ),
    )


def ask(client: AceDataCloud, question: str, model: str = "gpt-4o-mini") -> str:
    """One paid chat-completion call against AceData Cloud."""
    res = client.openai.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": question}],
        max_tokens=300,
    )
    return res.choices[0].message.content
