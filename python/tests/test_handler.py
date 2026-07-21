"""Validation tests for the payment-handler factory."""

from __future__ import annotations

import pytest

from acedatacloud_x402 import create_x402_payment_handler


def test_solana_requires_solana_signer():
    with pytest.raises(ValueError):
        create_x402_payment_handler(network="solana")


def test_base_requires_evm_signer():
    with pytest.raises(ValueError):
        create_x402_payment_handler(network="base")


def test_skale_requires_evm_signer():
    with pytest.raises(ValueError):
        create_x402_payment_handler(network="skale")


def test_network_mismatch_raises():
    # ruff: noqa: E501
    from acedatacloud_x402 import EVMAccountSigner

    handler = create_x402_payment_handler(
        network="base",
        evm_signer=EVMAccountSigner.from_private_key(
            "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"
        ),
    )
    with pytest.raises(RuntimeError, match="no payment requirement"):
        handler(
            {
                "url": "x",
                "method": "POST",
                "accepts": [{"network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"}],
            }
        )
