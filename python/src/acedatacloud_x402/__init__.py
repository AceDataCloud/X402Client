"""X402 payment protocol client for AceDataCloud APIs (Python).

Plug-in for `acedatacloud`: when an API returns ``402 Payment Required``,
this package signs the payment envelope and returns it as an ``X-Payment``
header. The SDK retries the request transparently.

    from acedatacloud import AceDataCloud
    from acedatacloud_x402 import create_x402_payment_handler, EVMAccountSigner

    client = AceDataCloud(
        payment_handler=create_x402_payment_handler(
            network="base",
            evm_signer=EVMAccountSigner.from_private_key("0x..."),
        ),
    )
    res = client.openai.chat.completions.create(model="gpt-4o-mini", messages=[...])
"""

from .handler import create_x402_payment_handler
from .signing.evm import EVMAccountSigner, sign_evm_payment
from .signing.solana import SolanaKeypairSigner, sign_solana_payment
from .types import (
    EVMAuthorization,
    EVMPayload,
    PaymentRequiredResponse,
    PaymentRequirement,
    SolanaPayload,
    X402PaymentEnvelope,
    X402PaymentHandlerOptions,
)

__all__ = [
    "create_x402_payment_handler",
    "sign_evm_payment",
    "sign_solana_payment",
    "EVMAccountSigner",
    "SolanaKeypairSigner",
    "EVMAuthorization",
    "EVMPayload",
    "PaymentRequiredResponse",
    "PaymentRequirement",
    "SolanaPayload",
    "X402PaymentEnvelope",
    "X402PaymentHandlerOptions",
]

__version__ = "0.1.0"
