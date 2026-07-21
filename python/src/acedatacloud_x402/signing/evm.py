"""EVM X402 payment signing.

Implements both supported EVM schemes:

* ``exact``  — EIP-3009 ``TransferWithAuthorization`` over USDC
* ``upto``   — Permit2 ``PermitWitnessTransferFrom`` signed for the
  x402 reference proxy (`X402UptoPermit2Proxy`). Lets the server settle
  any amount ≤ the signed ceiling.

Uses ``eth_account`` for EIP-712 signing so we do not need a full
``web3.py`` install.
"""

from __future__ import annotations

import os
import secrets
import time
from dataclasses import dataclass
from typing import Any

from eth_account import Account
from eth_account.messages import encode_typed_data

from ..types import EVMPayload, EVMUptoPayload, PaymentRequirement, X402PaymentEnvelope

# Canonical addresses, deterministically deployed (CREATE2) on every EVM chain.
# Kept in sync with FacilitatorX402.x402f.chain_handlers.upto_constants.
PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3"
X402_UPTO_PERMIT2_PROXY_ADDRESS = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002"
_VALID_AFTER_SKEW_SECONDS = 30


def _random_nonce_32() -> str:
    return "0x" + os.urandom(32).hex()


def _random_permit2_nonce() -> int:
    """Generate a 256-bit Permit2 nonce.

    Permit2 nonces are arbitrary 256-bit integers; uniqueness is enforced on
    chain by the spender (proxy) marking each one used. We just pick uniformly
    at random — collision probability is negligible.
    """
    return secrets.randbits(256)


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
    value = str(int(requirements.get("amount") or requirements.get("maxAmountRequired") or "0"))

    authorization: dict[str, str] = {
        "from": signer.address,
        "to": requirements["payTo"],
        "value": value,
        "validAfter": "0",
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
        "accepted": requirements,
        "payload": dict(payload),
    }


def _build_upto_typed_data(
    requirements: PaymentRequirement,
    *,
    from_address: str,
    permitted_amount: int,
    nonce: int,
    deadline: int,
    valid_after: int,
) -> dict[str, Any]:
    """Build the Permit2 ``PermitWitnessTransferFrom`` typed data.

    Mirrors `FacilitatorX402.x402f.chain_handlers.upto_constants.build_upto_permit2_typed_data`
    exactly so signatures verify against the facilitator's reconstruction.

    Note the Permit2 EIP-712 domain has **no** ``version`` field (Permit2 was
    deployed without one). The token's own domain is irrelevant under upto —
    Permit2 holds the allowance, not USDC.
    """
    extra = requirements.get("extra") or {}
    asset = requirements.get("asset")
    pay_to = requirements["payTo"]
    facilitator_address = extra.get("facilitatorAddress")
    if not facilitator_address:
        raise ValueError(
            "PaymentRequirement.extra.facilitatorAddress is required for the upto scheme"
        )
    permit2_address = extra.get("permit2Address") or PERMIT2_ADDRESS
    spender_proxy = extra.get("proxyAddress") or X402_UPTO_PERMIT2_PROXY_ADDRESS
    verifying_contract = extra.get("verifyingContract") or permit2_address
    chain_id = int(extra.get("chainId") or 8453)

    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "PermitWitnessTransferFrom": [
                {"name": "permitted", "type": "TokenPermissions"},
                {"name": "spender", "type": "address"},
                {"name": "nonce", "type": "uint256"},
                {"name": "deadline", "type": "uint256"},
                {"name": "witness", "type": "Witness"},
            ],
            "TokenPermissions": [
                {"name": "token", "type": "address"},
                {"name": "amount", "type": "uint256"},
            ],
            "Witness": [
                {"name": "to", "type": "address"},
                {"name": "facilitator", "type": "address"},
                {"name": "validAfter", "type": "uint256"},
            ],
        },
        "primaryType": "PermitWitnessTransferFrom",
        "domain": {
            "name": extra.get("name") or "Permit2",
            "chainId": chain_id,
            "verifyingContract": verifying_contract,
        },
        "message": {
            "permitted": {"token": asset, "amount": permitted_amount},
            "spender": spender_proxy,
            "nonce": nonce,
            "deadline": deadline,
            "witness": {
                "to": pay_to,
                "facilitator": facilitator_address,
                "validAfter": valid_after,
            },
        },
    }


def sign_evm_upto_payment(
    requirements: PaymentRequirement,
    signer: EVMAccountSigner,
    *,
    valid_after: int | None = None,
    deadline_buffer: int | None = None,
    nonce: int | None = None,
) -> X402PaymentEnvelope:
    """Sign a Permit2 ``PermitWitnessTransferFrom`` envelope (``upto`` scheme).

    ``requirements.maxAmountRequired`` is the **ceiling** the payer signs over.
    The facilitator may settle any amount ``≤`` that ceiling at ``/record`` time
    (zero settles with no on-chain transaction).

    Args:
        requirements: A single accept entry with ``scheme == "upto"``.
        signer: Account that owns the USDC.
        valid_after: Optional unix seconds floor (defaults to now).
        deadline_buffer: Optional override for the deadline window (defaults
            to ``maxTimeoutSeconds`` or 3600s).
        nonce: Optional override (defaults to a uniformly random 256-bit int).

    Returns:
        A ready-to-send ``X402PaymentEnvelope`` whose payload mirrors the
        ``permit2Authorization`` shape parsed by the facilitator.
    """
    extra = requirements.get("extra") or {}
    permitted_amount = int(
        requirements.get("amount") or requirements.get("maxAmountRequired") or "0"
    )
    now = int(time.time())
    va = int(valid_after if valid_after is not None else now - _VALID_AFTER_SKEW_SECONDS)
    timeout = int(
        deadline_buffer
        if deadline_buffer is not None
        else requirements.get("maxTimeoutSeconds") or 3600
    )
    deadline = (va if valid_after is not None else now) + timeout
    permit_nonce = int(nonce if nonce is not None else _random_permit2_nonce())

    typed_data = _build_upto_typed_data(
        requirements,
        from_address=signer.address,
        permitted_amount=permitted_amount,
        nonce=permit_nonce,
        deadline=deadline,
        valid_after=va,
    )
    signature = signer.sign_typed_data(typed_data)
    if not signature.startswith("0x"):
        signature = "0x" + signature

    spender = extra.get("proxyAddress") or X402_UPTO_PERMIT2_PROXY_ADDRESS
    facilitator_address = extra.get("facilitatorAddress")
    payload: EVMUptoPayload = {
        "permit2Authorization": {
            "from": signer.address,
            "spender": spender,
            "nonce": str(permit_nonce),
            "deadline": str(deadline),
            "permitted": {"token": requirements["asset"], "amount": str(permitted_amount)},
            "witness": {
                "to": requirements["payTo"],
                "facilitator": facilitator_address,
                "validAfter": str(va),
            },
        },
        "signature": signature,
    }

    return {
        "x402Version": 2,
        "accepted": requirements,
        "payload": dict(payload),
    }


# ---------------------------------------------------------------------------
# Permit2 ERC-20 approval helper
# ---------------------------------------------------------------------------
# The ``upto`` scheme requires a one-time ERC-20 ``approve(Permit2, ∞)`` from
# the payer so the Permit2 contract can pull USDC on their behalf. We expose a
# tiny helper that builds and submits that tx — kept dependency-free of web3.py
# at import time; the user only needs web3 installed when they actually call it.

ERC20_APPROVE_ABI = [
    {
        "inputs": [
            {"name": "spender", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "name": "approve",
        "outputs": [{"name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "name": "allowance",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]

UINT256_MAX = (1 << 256) - 1


def approve_permit2(
    *,
    rpc_url: str,
    signer: EVMAccountSigner,
    token_address: str,
    amount: int = UINT256_MAX,
    permit2_address: str = PERMIT2_ADDRESS,
    gas_limit: int | None = None,
) -> dict[str, Any]:
    """Submit a one-time ``ERC20.approve(Permit2, amount)`` transaction.

    Required exactly once per (payer, token, chain) before the ``upto`` scheme
    can be used. By default approves the unlimited (``2**256 - 1``) amount —
    matches the on-chain pattern used by Uniswap / x402 reference clients.

    Skips the broadcast and returns the existing allowance if it is already
    at or above ``amount`` (idempotent).

    Args:
        rpc_url: HTTP(S) RPC endpoint for the target chain.
        signer: Owner of the tokens (and tx sender).
        token_address: ERC-20 token contract (e.g. USDC on Base).
        amount: Allowance to set. Defaults to ``2**256 - 1`` (unlimited).
        permit2_address: Override the canonical Permit2 address (mainly for tests).
        gas_limit: Optional fixed gas cap; defaults to an ``estimate_gas`` call.

    Returns:
        ``{"tx_hash": str | None, "previous_allowance": int,
        "new_allowance": int, "skipped": bool}``
    """
    try:
        from web3 import Web3
    except ImportError as exc:  # pragma: no cover - import-time error path
        raise ImportError(
            "approve_permit2 requires the optional `web3` package. "
            "Install with: pip install 'acedatacloud-x402[cli]'"
        ) from exc

    w3 = Web3(Web3.HTTPProvider(rpc_url))
    token = w3.eth.contract(address=w3.to_checksum_address(token_address), abi=ERC20_APPROVE_ABI)
    owner = w3.to_checksum_address(signer.address)
    spender = w3.to_checksum_address(permit2_address)
    current = int(token.functions.allowance(owner, spender).call())
    if current >= amount:
        return {
            "tx_hash": None,
            "previous_allowance": current,
            "new_allowance": current,
            "skipped": True,
        }

    chain_id = w3.eth.chain_id
    nonce_tx = w3.eth.get_transaction_count(owner)
    tx = token.functions.approve(spender, amount).build_transaction(
        {
            "from": owner,
            "nonce": nonce_tx,
            "chainId": chain_id,
        }
    )
    if gas_limit is not None:
        tx["gas"] = int(gas_limit)
    else:
        tx["gas"] = int(w3.eth.estimate_gas(tx) * 12 // 10)  # +20% headroom

    signed = w3.eth.account.sign_transaction(tx, private_key=signer.private_key)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"approve(Permit2, {amount}) reverted: tx={tx_hash.hex()}")

    new_allowance = int(token.functions.allowance(owner, spender).call())
    return {
        "tx_hash": tx_hash.hex(),
        "previous_allowance": current,
        "new_allowance": new_allowance,
        "skipped": False,
    }
