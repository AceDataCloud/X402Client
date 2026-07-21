"""Tests for the EVM signing primitives."""

from __future__ import annotations

from eth_account import Account

from acedatacloud_x402 import EVMAccountSigner, sign_evm_payment

# Test vector — well-known throwaway key from ethers.js docs. NEVER use in production.
TEST_PRIVATE_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"


def _fake_requirement() -> dict:
    return {
        "scheme": "exact",
        "network": "eip155:8453",
        "amount": "95215",
        "maxTimeoutSeconds": 120,
        "resource": "https://x402.acedata.cloud/openai/chat/completions",
        "description": "chat",
        "payTo": "0x4d2f00Dac0aCb02C7211cBDe2DbE9d86D7B7b2F2",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "extra": {
            "name": "USD Coin",
            "version": "2",
            "chainId": 8453,
            "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
    }


def test_signer_derives_correct_address():
    signer = EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY)
    expected = Account.from_key(TEST_PRIVATE_KEY).address
    assert signer.address == expected


def test_envelope_shape():
    signer = EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY)
    envelope = sign_evm_payment(_fake_requirement(), signer)
    assert envelope["x402Version"] == 2
    assert envelope["accepted"]["scheme"] == "exact"
    assert envelope["accepted"]["network"] == "eip155:8453"
    payload = envelope["payload"]
    assert set(payload.keys()) == {"authorization", "signature"}
    assert payload["signature"].startswith("0x")
    auth = payload["authorization"]
    assert auth["from"].lower() == signer.address.lower()
    assert auth["to"] == "0x4d2f00Dac0aCb02C7211cBDe2DbE9d86D7B7b2F2"
    assert auth["value"] == "95215"
    assert auth["validAfter"] == "0"
    # nonce is 32 random bytes, hex-encoded
    assert auth["nonce"].startswith("0x")
    assert len(auth["nonce"]) == 66  # "0x" + 64 hex chars


def test_handler_produces_payment_signature_header():
    from acedatacloud_x402 import create_x402_payment_handler

    handler = create_x402_payment_handler(
        network="base",
        evm_signer=EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY),
    )
    result = handler(
        {
            "url": "https://x402.acedata.cloud/openai/chat/completions",
            "method": "POST",
            "accepts": [_fake_requirement()],
        }
    )
    assert "headers" in result
    assert "PAYMENT-SIGNATURE" in result["headers"]
    assert len(result["headers"]["PAYMENT-SIGNATURE"]) > 20
