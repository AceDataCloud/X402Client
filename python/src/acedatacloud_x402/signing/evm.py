"""EVM X402 payment signing (EIP-712 ``TransferWithAuthorization``).

Mirrors typescript/src/evm.ts. Uses ``eth_account`` for EIP-712 signing so
we do not need a full ``web3.py`` install.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any

from eth_account import Account
from eth_account.messages import encode_typed_data

from ..types import EVMPayload, PaymentRequirement, X402PaymentEnvelope


def _random_nonce_32() -> str:
    return "0x" + os.urandom(32).hex()


@dataclass
class EVMAccountSigner:
    """Minimal signer wrapping a local EVM private key.

    The private key is kept in memory and used to sign EIP-712 typed data.
    """

    private_key: str
    address: str

    @classmethod
    def from_private_key(cls, private_key: str) -> EVMAccountSigner:
        if not private_key.startswith("0x"):
            private_key = "0x" + private_key
        acct = Account.from_key(private_key)
        return cls(private_key=private_key, address=acct.address)

    def sign_typed_data(self, typed_data: dict[str, Any]) -> str:
        signable = encode_typed_data(full_message=typed_data)
        signed = Account.sign_message(signable, private_key=self.private_key)
        return signed.signature.hex()


def _build_typed_data(
    requirements: PaymentRequirement, authorization: dict[str, str]
) -> dict[str, Any]:
    extra = requirements.get("extra") or {}
    asset = requirements.get("asset")
    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {
            "name": extra.get("name") or "USD Coin",
            "version": extra.get("version") or "2",
            "chainId": extra.get("chainId") or 8453,
            "verifyingContract": extra.get("verifyingContract") or asset,
        },
        "message": authorization,
    }


def sign_evm_payment(
    requirements: PaymentRequirement, signer: EVMAccountSigner
) -> X402PaymentEnvelope:
    """Sign an EIP-712 ``TransferWithAuthorization`` envelope for an EVM chain."""
    now = int(time.time())
    max_timeout = int(requirements.get("maxTimeoutSeconds") or 120)
    value = str(int(requirements["maxAmountRequired"]))

    authorization: dict[str, str] = {
        "from": signer.address,
        "to": requirements["payTo"],
        "value": value,
        "validAfter": str(now),
        "validBefore": str(now + max_timeout),
        "nonce": _random_nonce_32(),
    }

    typed_data = _build_typed_data(requirements, authorization)
    signature = signer.sign_typed_data(typed_data)
    if not signature.startswith("0x"):
        signature = "0x" + signature

    payload: EVMPayload = {"authorization": authorization, "signature": signature}
    return {
        "x402Version": 2,
        "scheme": requirements.get("scheme") or "exact",
        "network": requirements.get("network") or "base",
        "payload": dict(payload),
    }
