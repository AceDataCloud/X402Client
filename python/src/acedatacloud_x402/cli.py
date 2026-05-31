"""Command-line utilities for the X402 client.

Currently exposes a single command:

* ``acedatacloud-x402 approve-permit2`` — one-time ERC-20 ``approve(Permit2, ∞)``
  required by the Permit2-based ``upto`` scheme.

The CLI imports ``web3`` lazily through :func:`acedatacloud_x402.approve_permit2`,
so the base install stays slim; install the ``[cli]`` extra to enable it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence

from . import (
    PERMIT2_ADDRESS,
    EVMAccountSigner,
    approve_permit2,
)

# Convenience: well-known USDC contracts on chains we support today.
USDC_BY_NETWORK: dict[str, str] = {
    "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "skale": "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
}

DEFAULT_RPC: dict[str, str] = {
    "base": "https://mainnet.base.org",
    "base-sepolia": "https://sepolia.base.org",
    "skale": "https://mainnet.skalenodes.com/v1/elated-tan-skat",
}


def _resolve_private_key(arg_value: str | None) -> str:
    if arg_value:
        return arg_value
    env_value = os.environ.get("X402_PRIVATE_KEY")
    if env_value:
        return env_value
    sys.exit("error: missing private key. Pass --private-key or set X402_PRIVATE_KEY.")


def _run_approve(args: argparse.Namespace) -> int:
    pk = _resolve_private_key(args.private_key)
    rpc_url = args.rpc_url or DEFAULT_RPC.get(args.network)
    if not rpc_url:
        sys.exit(f"error: no default RPC for network {args.network!r}, pass --rpc-url")
    token_address = args.token or USDC_BY_NETWORK.get(args.network)
    if not token_address:
        sys.exit(f"error: no default token for network {args.network!r}, pass --token")

    signer = EVMAccountSigner.from_private_key(pk)
    result = approve_permit2(
        rpc_url=rpc_url,
        signer=signer,
        token_address=token_address,
        amount=int(args.amount, 0) if args.amount else (1 << 256) - 1,
        permit2_address=args.permit2_address or PERMIT2_ADDRESS,
    )
    out = {
        "payer": signer.address,
        "network": args.network,
        "rpc_url": rpc_url,
        "token": token_address,
        "permit2": args.permit2_address or PERMIT2_ADDRESS,
        **result,
    }
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="acedatacloud-x402")
    sub = parser.add_subparsers(dest="command", required=True)

    approve = sub.add_parser(
        "approve-permit2",
        help="One-time ERC-20 approve(Permit2, amount) needed before signing upto payments.",
    )
    approve.add_argument(
        "--network",
        default="base",
        choices=sorted(set(DEFAULT_RPC) | set(USDC_BY_NETWORK)),
        help="EVM network with a known default RPC + USDC address.",
    )
    approve.add_argument(
        "--rpc-url",
        help="Override the RPC endpoint.",
    )
    approve.add_argument(
        "--token",
        help="ERC-20 token contract address. Defaults to USDC for the chosen --network.",
    )
    approve.add_argument(
        "--amount",
        help="Allowance to set (decimal or 0x-hex). Defaults to unlimited (2**256 - 1).",
    )
    approve.add_argument(
        "--permit2-address",
        help="Override Permit2 contract address (defaults to the canonical CREATE2 deployment).",
    )
    approve.add_argument(
        "--private-key",
        help="Hex private key. Falls back to $X402_PRIVATE_KEY.",
    )
    approve.set_defaults(func=_run_approve)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
