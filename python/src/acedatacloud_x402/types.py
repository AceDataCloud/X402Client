"""X402 payment protocol types (Python mirror of typescript/src/types.ts)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict


class PaymentRequirementExtra(TypedDict, total=False):
    name: str
    version: str
    chainId: int
    verifyingContract: str
    decimals: int
    computeUnitLimit: int
    computeUnitPriceMicroLamports: int
    rpcUrl: str
    # upto-scheme additions (Permit2-based metered billing on EVM):
    permit2Address: str
    proxyAddress: str
    facilitatorAddress: str


class PaymentRequirement(TypedDict, total=False):
    """A single entry from the server's ``402`` ``accepts`` list."""

    scheme: str
    network: str
    maxAmountRequired: str
    maxTimeoutSeconds: int
    resource: str
    description: str
    payTo: str
    asset: str
    extra: PaymentRequirementExtra


class PaymentRequiredResponse(TypedDict, total=False):
    x402Version: int
    accepts: list[PaymentRequirement]
    error: str


class EVMAuthorization(TypedDict):
    """EIP-3009 TransferWithAuthorization message."""

    from_: str  # serialized as "from" when wire-encoded
    to: str
    value: str
    validAfter: str
    validBefore: str
    nonce: str


class EVMPayload(TypedDict):
    authorization: dict[str, str]  # uses "from" key, not from_
    signature: str


class EVMUptoPayload(TypedDict):
    """Wire payload for the ``upto`` scheme — a Permit2 ``PermitWitnessTransferFrom``
    authorization plus the EIP-712 signature over it.

    The facilitator parses ``payload.payload.permit2Authorization`` (mirroring
    the field names defined in
    `FacilitatorX402.x402f.chain_handlers.base_upto._parse_upto_payload`).
    """

    permit2Authorization: dict[str, Any]
    signature: str


class SolanaPayload(TypedDict):
    signature: str


class X402PaymentEnvelope(TypedDict):
    x402Version: int
    scheme: str
    network: str
    payload: dict[str, Any]


Network = Literal["solana", "base", "skale"]


@dataclass
class X402PaymentHandlerOptions:
    """Options accepted by :func:`create_x402_payment_handler`."""

    network: Network
    evm_signer: Any | None = None  # EVMAccountSigner
    solana_signer: Any | None = None  # SolanaKeypairSigner
    rpc_url: str | None = None  # optional override for the Solana RPC endpoint
    extra_headers: dict[str, str] = field(default_factory=dict)
