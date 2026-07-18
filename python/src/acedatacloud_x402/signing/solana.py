"""Solana X402 payment transaction construction and partial signing."""

from __future__ import annotations

import base64
import secrets
from dataclasses import dataclass
from typing import Any

import base58
import httpx
from solders.compute_budget import set_compute_unit_limit, set_compute_unit_price
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.null_signer import NullSigner
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction

from ..types import PaymentRequirement, SolanaPayload, X402PaymentEnvelope

TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ATA_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
MEMO_PROGRAM_ID = Pubkey.from_string("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
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


def _assert_token_accounts_exist(rpc_url: str, source_ata: Pubkey, destination_ata: Pubkey) -> None:
    with httpx.Client(timeout=15.0) as client:
        resp = client.post(
            rpc_url,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "getMultipleAccounts",
                "params": [[str(source_ata), str(destination_ata)], {"encoding": "base64"}],
            },
        )
        resp.raise_for_status()
        values = (resp.json().get("result") or {}).get("value") or []
    if len(values) != 2 or values[0] is None:
        raise ValueError(f"Solana payer token account does not exist: {source_ata}")
    if values[1] is None:
        raise ValueError(
            f"Solana payment recipient token account does not exist: {destination_ata}"
        )


def sign_solana_payment(
    requirements: PaymentRequirement,
    signer: SolanaKeypairSigner,
    rpc_url: str | None = None,
) -> X402PaymentEnvelope:
    """Build and partially sign an SPL USDC transfer for facilitator settlement."""
    extra: dict[str, Any] = requirements.get("extra") or {}
    pay_to = Pubkey.from_string(requirements["payTo"])
    mint = Pubkey.from_string(requirements["asset"])
    amount = int(requirements["maxAmountRequired"])
    decimals = int(extra.get("decimals") or 6)
    compute_unit_limit = int(extra.get("computeUnitLimit") or 100_000)
    compute_unit_price = int(extra.get("computeUnitPriceMicroLamports") or 5_000)
    memo = str(extra.get("memo") if extra.get("memo") is not None else secrets.token_hex(16))
    memo_bytes = memo.encode("utf-8")
    if len(memo_bytes) > 256:
        raise ValueError("PaymentRequirement.extra.memo must be at most 256 bytes")
    fee_payer_value = extra.get("feePayer")
    if not fee_payer_value:
        raise ValueError("PaymentRequirement.extra.feePayer is required for Solana")
    fee_payer = Pubkey.from_string(fee_payer_value)
    endpoint = rpc_url or extra.get("rpcUrl") or DEFAULT_RPC_URL

    payer = signer.public_key
    source_ata = _find_ata(payer, mint)
    dest_ata = _find_ata(pay_to, mint)
    _assert_token_accounts_exist(endpoint, source_ata, dest_ata)

    instructions: list[Instruction] = [
        set_compute_unit_limit(compute_unit_limit),
        set_compute_unit_price(compute_unit_price),
    ]

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
    instructions.extend(
        [
            transfer_ix,
            Instruction(program_id=MEMO_PROGRAM_ID, accounts=[], data=memo_bytes),
        ]
    )

    blockhash = _get_latest_blockhash(endpoint)
    message = MessageV0.try_compile(fee_payer, instructions, [], blockhash)
    tx = VersionedTransaction(message, [NullSigner(fee_payer), signer.keypair])
    serialized = base64.b64encode(bytes(tx)).decode("ascii")

    payload: SolanaPayload = {"transaction": serialized}
    return {
        "x402Version": 2,
        "scheme": requirements.get("scheme") or "exact",
        "network": requirements.get("network") or "solana",
        "payload": dict(payload),
    }
