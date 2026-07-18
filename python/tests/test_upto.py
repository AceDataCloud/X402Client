"""Tests for the EVM ``upto`` (Permit2) signing path."""

from __future__ import annotations

import base64
import json
import time

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from acedatacloud_x402 import (
    PERMIT2_ADDRESS,
    X402_UPTO_PERMIT2_PROXY_ADDRESS,
    EVMAccountSigner,
    create_x402_payment_handler,
    sign_evm_upto_payment,
)
from acedatacloud_x402.signing.evm import _build_upto_typed_data

# Test vector — ethers.js docs throwaway key. NEVER use in production.
TEST_PRIVATE_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"
FACILITATOR_ADDR = "0x1111111111111111111111111111111111111111"
PAY_TO_ADDR = "0x4d2f00Dac0aCb02C7211cBDe2DbE9d86D7B7b2F2"
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"


def _upto_requirement(*, ceiling: str = "4760750", network: str = "base") -> dict:
    """Mirror of an upto accept entry emitted by PlatformGateway."""
    return {
        "scheme": "upto",
        "network": network,
        "maxAmountRequired": ceiling,
        "maxTimeoutSeconds": 3600,
        "resource": "https://x402.acedata.cloud/openai/chat/completions",
        "description": "AceDataCloud API call (metered)",
        "payTo": PAY_TO_ADDR,
        "asset": USDC_BASE,
        "extra": {
            "name": "Permit2",
            "chainId": 8453,
            "verifyingContract": PERMIT2_ADDRESS,
            "permit2Address": PERMIT2_ADDRESS,
            "proxyAddress": X402_UPTO_PERMIT2_PROXY_ADDRESS,
            "facilitatorAddress": FACILITATOR_ADDR,
        },
    }


def test_upto_envelope_shape():
    signer = EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY)
    envelope = sign_evm_upto_payment(_upto_requirement(), signer)

    assert envelope["x402Version"] == 2
    assert envelope["scheme"] == "upto"
    assert envelope["network"] == "base"

    payload = envelope["payload"]
    assert set(payload.keys()) == {"permit2Authorization", "signature"}
    assert payload["signature"].startswith("0x")
    assert len(payload["signature"]) == 132  # 65 bytes = 130 hex + "0x"

    auth = payload["permit2Authorization"]
    assert auth["from"].lower() == signer.address.lower()
    assert auth["spender"] == X402_UPTO_PERMIT2_PROXY_ADDRESS
    assert auth["permitted"]["token"] == USDC_BASE
    assert auth["permitted"]["amount"] == "4760750"  # ceiling preserved verbatim
    assert auth["witness"]["to"] == PAY_TO_ADDR
    assert auth["witness"]["facilitator"] == FACILITATOR_ADDR
    # nonce & deadline are stringified ints (facilitator parses both formats)
    assert auth["nonce"].isdigit()
    assert auth["deadline"].isdigit()
    assert auth["witness"]["validAfter"].isdigit()
    assert int(auth["deadline"]) > int(auth["witness"]["validAfter"])


def test_upto_default_valid_after_tolerates_chain_clock_lag():
    signer = EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY)
    before = int(time.time())
    envelope = sign_evm_upto_payment(_upto_requirement(network="skale"), signer)
    after = int(time.time())
    auth = envelope["payload"]["permit2Authorization"]

    assert before - 30 <= int(auth["witness"]["validAfter"]) <= after - 30
    assert before + 3600 <= int(auth["deadline"]) <= after + 3600


def test_upto_signature_recovers_to_payer():
    """The signature must recover to the payer when the facilitator
    reconstructs the typed data with the same Permit2 domain — proves
    we are signing over the exact bytes the facilitator will verify."""
    signer = EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY)
    req = _upto_requirement()
    envelope = sign_evm_upto_payment(req, signer, nonce=42, valid_after=1_700_000_000)
    auth = envelope["payload"]["permit2Authorization"]

    # Reconstruct the typed data the same way the facilitator does.
    typed = _build_upto_typed_data(
        req,
        from_address=auth["from"],
        permitted_amount=int(auth["permitted"]["amount"]),
        nonce=int(auth["nonce"]),
        deadline=int(auth["deadline"]),
        valid_after=int(auth["witness"]["validAfter"]),
    )
    signable = encode_typed_data(full_message=typed)
    recovered = Account.recover_message(signable, signature=envelope["payload"]["signature"])
    assert recovered.lower() == signer.address.lower()


def test_upto_typed_data_domain_has_no_version():
    """The Permit2 EIP-712 domain MUST omit the ``version`` field. If we add
    one, ``encode_typed_data`` produces a different digest and the
    facilitator will recover the wrong signer."""
    req = _upto_requirement()
    typed = _build_upto_typed_data(
        req,
        from_address="0x0000000000000000000000000000000000000001",
        permitted_amount=1,
        nonce=1,
        deadline=2,
        valid_after=1,
    )
    assert set(typed["domain"].keys()) == {"name", "chainId", "verifyingContract"}
    assert typed["domain"]["name"] == "Permit2"
    assert typed["domain"]["verifyingContract"] == PERMIT2_ADDRESS
    # EIP712Domain type schema also omits version.
    eip712_fields = [f["name"] for f in typed["types"]["EIP712Domain"]]
    assert "version" not in eip712_fields


def test_upto_requires_facilitator_address():
    """Defensive: missing ``extra.facilitatorAddress`` should fail fast at sign time
    rather than producing an envelope the facilitator will silently reject."""
    signer = EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY)
    req = _upto_requirement()
    del req["extra"]["facilitatorAddress"]
    with pytest.raises(ValueError, match="facilitatorAddress"):
        sign_evm_upto_payment(req, signer)


def test_handler_prefers_upto_when_requested():
    """When the gateway offers both schemes and the user asks for ``upto``,
    the handler must pick the upto variant and produce an upto envelope."""
    handler = create_x402_payment_handler(
        network="base",
        evm_signer=EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY),
        prefer_scheme="upto",
    )
    exact_req = {
        "scheme": "exact",
        "network": "base",
        "maxAmountRequired": "95215",
        "payTo": PAY_TO_ADDR,
        "asset": USDC_BASE,
        "extra": {
            "name": "USD Coin",
            "version": "2",
            "chainId": 8453,
            "verifyingContract": USDC_BASE,
        },
    }
    accepts = [exact_req, _upto_requirement()]
    result = handler({"accepts": accepts})
    header = result["headers"]["X-Payment"]
    envelope = json.loads(base64.b64decode(header))
    assert envelope["scheme"] == "upto"
    assert "permit2Authorization" in envelope["payload"]


def test_handler_falls_back_to_exact_when_upto_unavailable():
    """If the user asks for ``upto`` but the server only offers ``exact``,
    pick the first available entry rather than failing the request."""
    handler = create_x402_payment_handler(
        network="base",
        evm_signer=EVMAccountSigner.from_private_key(TEST_PRIVATE_KEY),
        prefer_scheme="upto",
    )
    exact_req = {
        "scheme": "exact",
        "network": "base",
        "maxAmountRequired": "95215",
        "payTo": PAY_TO_ADDR,
        "asset": USDC_BASE,
        "extra": {
            "name": "USD Coin",
            "version": "2",
            "chainId": 8453,
            "verifyingContract": USDC_BASE,
        },
    }
    result = handler({"accepts": [exact_req]})
    envelope = json.loads(base64.b64decode(result["headers"]["X-Payment"]))
    assert envelope["scheme"] == "exact"
    assert "authorization" in envelope["payload"]
