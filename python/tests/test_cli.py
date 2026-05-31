"""Smoke tests for the ``acedatacloud-x402`` CLI parser.

We deliberately avoid invoking the ``approve-permit2`` action against a live
RPC; the actual web3 call path is exercised in integration / Phase 5 e2e.
"""

from __future__ import annotations

import pytest

from acedatacloud_x402.cli import build_parser


def test_parser_help_lists_approve_permit2(capsys):
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--help"])
    captured = capsys.readouterr().out
    assert "approve-permit2" in captured


def test_approve_permit2_args_parse_defaults():
    parser = build_parser()
    ns = parser.parse_args(["approve-permit2"])
    assert ns.command == "approve-permit2"
    assert ns.network == "base"
    assert ns.private_key is None  # falls back to $X402_PRIVATE_KEY
    assert ns.permit2_address is None


def test_approve_permit2_args_parse_overrides():
    parser = build_parser()
    ns = parser.parse_args(
        [
            "approve-permit2",
            "--network",
            "base-sepolia",
            "--rpc-url",
            "https://rpc.example/eth",
            "--token",
            "0x000000000000000000000000000000000000beef",
            "--amount",
            "0xff",
            "--private-key",
            "0xabc",
        ]
    )
    assert ns.network == "base-sepolia"
    assert ns.rpc_url == "https://rpc.example/eth"
    assert ns.token.endswith("beef")
    assert ns.amount == "0xff"
    assert ns.private_key == "0xabc"
