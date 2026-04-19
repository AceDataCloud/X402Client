"""SDK adapter: turn X402 credentials into a ``payment_handler`` for the SDK.

Compatible with both the sync and async :class:`AceDataCloud` clients in
the ``acedatacloud`` package. The returned callable matches the
``SyncPaymentHandler`` signature; the async client will happily await a
sync result too.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable, Sequence
from typing import Any

from .signing.evm import EVMAccountSigner, sign_evm_payment
from .signing.solana import SolanaKeypairSigner, sign_solana_payment
from .types import Network, PaymentRequirement, X402PaymentEnvelope

PaymentHandlerResult = dict[str, dict[str, str]]


def _encode_payment_header(envelope: X402PaymentEnvelope) -> str:
    serialized = json.dumps(envelope, separators=(",", ":"))
    return base64.b64encode(serialized.encode("utf-8")).decode("ascii")


def _select_requirement(
    accepts: Sequence[PaymentRequirement], network: str
) -> PaymentRequirement | None:
    for req in accepts:
        if req.get("network") == network:
            return req
    return None


def create_x402_payment_handler(
    *,
    network: Network,
    evm_signer: EVMAccountSigner | None = None,
    solana_signer: SolanaKeypairSigner | None = None,
    rpc_url: str | None = None,
) -> Callable[[dict[str, Any]], PaymentHandlerResult]:
    """Build a ``payment_handler`` function the SDK can invoke on 402.

    Args:
        network: Target payment network (``"solana"``, ``"base"``, or ``"skale"``).
        evm_signer: Required for ``base`` / ``skale``.
        solana_signer: Required for ``solana``.
        rpc_url: Optional Solana RPC override.

    Returns:
        A callable ``(ctx) -> {"headers": {"X-Payment": "..."}}`` suitable
        for :class:`acedatacloud.AceDataCloud` /
        :class:`acedatacloud.AsyncAceDataCloud`.
    """
    if network == "solana" and solana_signer is None:
        raise ValueError('solana_signer is required when network="solana"')
    if network in ("base", "skale") and evm_signer is None:
        raise ValueError(f'evm_signer is required when network="{network}"')

    def handler(ctx: dict[str, Any]) -> PaymentHandlerResult:
        accepts: Sequence[PaymentRequirement] = ctx.get("accepts") or []
        requirement = _select_requirement(accepts, network)
        if requirement is None:
            available = ", ".join(str(r.get("network")) for r in accepts) or "<none>"
            raise RuntimeError(
                f'X402: no payment requirement for network "{network}". Available: {available}'
            )

        if network == "solana":
            assert solana_signer is not None  # guarded above
            envelope = sign_solana_payment(requirement, solana_signer, rpc_url=rpc_url)
        else:
            assert evm_signer is not None  # guarded above
            envelope = sign_evm_payment(requirement, evm_signer)

        return {"headers": {"X-Payment": _encode_payment_header(envelope)}}

    return handler
