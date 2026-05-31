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
from .signing.evm import (
    PERMIT2_ADDRESS,
    X402_UPTO_PERMIT2_PROXY_ADDRESS,
    EVMAccountSigner,
    approve_permit2,
    sign_evm_payment,
    sign_evm_upto_payment,
)
from .signing.solana import SolanaKeypairSigner, sign_solana_payment
from .types import (
    EVMAuthorization,
    EVMPayload,
    EVMUptoPayload,
    PaymentRequiredResponse,
    PaymentRequirement,
    SolanaPayload,
    X402PaymentEnvelope,
    X402PaymentHandlerOptions,
)

__all__ = [
    "create_x402_payment_handler",
    "sign_evm_payment",
    "sign_evm_upto_payment",
    "sign_solana_payment",
    "approve_permit2",
    "EVMAccountSigner",
    "SolanaKeypairSigner",
    "EVMAuthorization",
    "EVMPayload",
    "EVMUptoPayload",
    "PaymentRequiredResponse",
    "PaymentRequirement",
    "SolanaPayload",
    "X402PaymentEnvelope",
    "X402PaymentHandlerOptions",
    "PERMIT2_ADDRESS",
    "X402_UPTO_PERMIT2_PROXY_ADDRESS",
]

__version__ = "0.1.0"
