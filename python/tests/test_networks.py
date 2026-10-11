import base64
import json

import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data

from acedatacloud_x402 import EVMAccountSigner, create_x402_payment_handler
from acedatacloud_x402.signing.evm import _build_typed_data, sign_evm_payment

NETWORK_CASES = [
    ("arbitrum", 42161, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    ("polygon", 137, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
    ("optimism", 10, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
]


@pytest.mark.parametrize("alias,chain_id,asset", NETWORK_CASES)
def test_exact_payment_uses_selected_network_and_rejects_domain_mismatch(alias, chain_id, asset):
    signer = EVMAccountSigner.from_private_key(Account.create().key.hex())
    requirement = {
        "scheme": "exact",
        "network": f"eip155:{chain_id}",
        "asset": asset,
        "amount": "1250000",
        "maxTimeoutSeconds": 60,
        "payTo": "0x" + "1" * 40,
        "extra": {"name": "USD Coin", "version": "2"},
    }
    for network in (alias, requirement["network"]):
        handler = create_x402_payment_handler(network=network, evm_signer=signer)
        result = handler({"accepts": [requirement]})
        envelope = json.loads(base64.b64decode(result["headers"]["PAYMENT-SIGNATURE"]))
        assert envelope["accepted"] == requirement
        typed = _build_typed_data(requirement, envelope["payload"]["authorization"])
        assert typed["domain"]["chainId"] == chain_id
        assert typed["domain"]["verifyingContract"] == asset
        signature = envelope["payload"]["signature"]
        assert (
            Account.recover_message(encode_typed_data(full_message=typed), signature=signature)
            == signer.address
        )
        typed["domain"]["chainId"] = 8453
        assert (
            Account.recover_message(encode_typed_data(full_message=typed), signature=signature)
            != signer.address
        )
    with pytest.raises(ValueError, match="disagree"):
        sign_evm_payment({**requirement, "extra": {"chainId": 8453}}, signer)
