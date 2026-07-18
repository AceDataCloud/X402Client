import base64

from solders.hash import Hash
from solders.keypair import Keypair
from solders.signature import Signature
from solders.transaction import VersionedTransaction

from acedatacloud_x402 import SolanaKeypairSigner
from acedatacloud_x402.signing import solana

TEST_SECRET = bytes(Keypair.from_seed(bytes(range(32))))
FEE_PAYER = "3SPm6qbgsDkj24MuR8Ss4sH97fziqyCiqFKDyeVU2igq"


def _requirement():
    return {
        "scheme": "exact",
        "network": "solana",
        "maxAmountRequired": "952",
        "payTo": "5iVXFrYaYWX2GUTbkQj8mDBoBhAX8bneYigS2LJTia43",
        "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "extra": {
            "feePayer": FEE_PAYER,
            "decimals": 6,
            "computeUnitLimit": 100_000,
            "computeUnitPriceMicroLamports": 5_000,
        },
    }


def test_solana_envelope_contains_partially_signed_transaction(monkeypatch):
    monkeypatch.setattr(solana, "_get_latest_blockhash", lambda _rpc: Hash.default())
    monkeypatch.setattr(solana, "_assert_token_accounts_exist", lambda *_args: None)
    signer = SolanaKeypairSigner.from_secret_key(TEST_SECRET)

    envelope = solana.sign_solana_payment(_requirement(), signer, rpc_url="https://rpc.test")

    assert envelope["payload"].keys() == {"transaction"}
    transaction = VersionedTransaction.from_bytes(
        base64.b64decode(envelope["payload"]["transaction"])
    )
    assert str(transaction.message.account_keys[0]) == FEE_PAYER
    assert transaction.signatures[0] == Signature.default()
    assert transaction.signatures[1] != Signature.default()
    assert len(transaction.message.instructions) == 4


def test_solana_requires_facilitator_fee_payer(monkeypatch):
    monkeypatch.setattr(solana, "_get_latest_blockhash", lambda _rpc: Hash.default())
    monkeypatch.setattr(solana, "_assert_token_accounts_exist", lambda *_args: None)
    requirement = _requirement()
    del requirement["extra"]["feePayer"]

    try:
        solana.sign_solana_payment(
            requirement,
            SolanaKeypairSigner.from_secret_key(TEST_SECRET),
            rpc_url="https://rpc.test",
        )
    except ValueError as error:
        assert "feePayer" in str(error)
    else:
        raise AssertionError("missing feePayer should fail")


def test_solana_rejects_missing_recipient_token_account(monkeypatch):
    monkeypatch.setattr(solana, "_get_latest_blockhash", lambda _rpc: Hash.default())

    def reject_recipient(_rpc, _source, destination):
        raise ValueError(f"Solana payment recipient token account does not exist: {destination}")

    monkeypatch.setattr(solana, "_assert_token_accounts_exist", reject_recipient)

    try:
        solana.sign_solana_payment(
            _requirement(),
            SolanaKeypairSigner.from_secret_key(TEST_SECRET),
            rpc_url="https://rpc.test",
        )
    except ValueError as error:
        assert "recipient token account" in str(error)
    else:
        raise AssertionError("missing recipient ATA should fail before signing")
