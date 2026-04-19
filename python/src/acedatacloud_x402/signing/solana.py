"""Solana X402 payment signing.

Mirrors typescript/src/solana.ts. Builds an SPL ``TransferChecked`` instruction,
signs and submits it, and returns the on-chain signature inside an
``X-Payment`` envelope.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import base58
import httpx
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from ..types import PaymentRequirement, SolanaPayload, X402PaymentEnvelope

TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ATA_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com"


def _find_ata(owner: Pubkey, mint: Pubkey) -> Pubkey:
    ata, _ = Pubkey.find_program_address(
        [bytes(owner), bytes(TOKEN_PROGRAM_ID), bytes(mint)], ATA_PROGRAM_ID
    )
    return ata


def _build_transfer_checked_data(amount: int, decimals: int) -> bytes:
    """SPL ``TransferChecked`` layout: [12 (u8), amount (u64 LE), decimals (u8)]."""
    return bytes([12]) + amount.to_bytes(8, "little") + bytes([decimals])


@dataclass
class SolanaKeypairSigner:
    """Minimal Solana signer wrapping a ``solders.Keypair``."""

    keypair: Keypair

    @classmethod
    def from_secret_key(cls, secret_key: bytes) -> SolanaKeypairSigner:
        return cls(keypair=Keypair.from_bytes(secret_key))

    @classmethod
    def from_base58(cls, encoded: str) -> SolanaKeypairSigner:
        return cls.from_secret_key(base58.b58decode(encoded))

    @property
    def public_key(self) -> Pubkey:
        return self.keypair.pubkey()


def _get_latest_blockhash(rpc_url: str) -> Hash:
    with httpx.Client(timeout=15.0) as client:
        resp = client.post(
            rpc_url,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getLatestBlockhash",
                "params": [{"commitment": "confirmed"}],
            },
        )
        resp.raise_for_status()
        data = resp.json()
    blockhash_str = data["result"]["value"]["blockhash"]
    return Hash.from_string(blockhash_str)


def _send_transaction(rpc_url: str, tx: Transaction) -> str:
    encoded = base58.b58encode(bytes(tx)).decode("ascii")
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            rpc_url,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "sendTransaction",
                "params": [encoded, {"encoding": "base58", "preflightCommitment": "confirmed"}],
            },
        )
        resp.raise_for_status()
        data = resp.json()
    if "error" in data:
        raise RuntimeError(f"Solana sendTransaction failed: {data['error']}")
    signature: str = data["result"]
    return signature


def sign_solana_payment(
    requirements: PaymentRequirement,
    signer: SolanaKeypairSigner,
    rpc_url: str | None = None,
) -> X402PaymentEnvelope:
    """Sign and submit an SPL USDC transfer and return the X-Payment envelope."""
    extra: dict[str, Any] = requirements.get("extra") or {}
    pay_to = Pubkey.from_string(requirements["payTo"])
    mint = Pubkey.from_string(requirements["asset"])
    amount = int(requirements["maxAmountRequired"])
    decimals = int(extra.get("decimals") or 6)
    compute_unit_limit = int(extra.get("computeUnitLimit") or 0)
    compute_unit_price = int(extra.get("computeUnitPriceMicroLamports") or 0)
    endpoint = rpc_url or extra.get("rpcUrl") or DEFAULT_RPC_URL

    payer = signer.public_key
    source_ata = _find_ata(payer, mint)
    dest_ata = _find_ata(pay_to, mint)

    instructions: list[Instruction] = []
    if compute_unit_limit > 0:
        instructions.append(set_compute_unit_limit(compute_unit_limit))
    if compute_unit_price > 0:
        instructions.append(set_compute_unit_price(compute_unit_price))

    transfer_ix = Instruction(
        program_id=TOKEN_PROGRAM_ID,
        accounts=[
            AccountMeta(pubkey=source_ata, is_signer=False, is_writable=True),
            AccountMeta(pubkey=mint, is_signer=False, is_writable=False),
            AccountMeta(pubkey=dest_ata, is_signer=False, is_writable=True),
            AccountMeta(pubkey=payer, is_signer=True, is_writable=False),
        ],
        data=_build_transfer_checked_data(amount, decimals),
    )
    instructions.append(transfer_ix)

    blockhash = _get_latest_blockhash(endpoint)
    message = Message.new_with_blockhash(instructions, payer, blockhash)
    tx = Transaction([signer.keypair], message, blockhash)

    signature = _send_transaction(endpoint, tx)

    payload: SolanaPayload = {"signature": signature}
    return {
        "x402Version": 2,
        "scheme": requirements.get("scheme") or "exact",
        "network": requirements.get("network") or "solana",
        "payload": dict(payload),
    }
