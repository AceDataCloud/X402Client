# X402Client Go package

Go implementation of the [AceDataCloud x402 payment client](https://github.com/AceDataCloud/X402Client).

Mirrors the [TypeScript](../typescript) and [Python](../python) packages:
sign an `X-Payment` header for HTTP `402 Payment Required` responses from
AceDataCloud, using on-chain USDC instead of an API token.

Supports:

- 🟦 **Base** — USDC (ERC-20) via EIP-3009 `TransferWithAuthorization`
- 🟪 **Solana** — SPL USDC via signed `TransferChecked`
- 🟨 **SKALE** — USDC (bridged) via EIP-3009

Settlement happens through [`facilitator.acedata.cloud`](https://github.com/AceDataCloud/FacilitatorX402).

## Install

```bash
go get github.com/AceDataCloud/X402Client/go@latest
```

## Quick start — Base / SKALE (EVM)

```go
package main

import (
    "context"
    "log"

    x402 "github.com/AceDataCloud/X402Client/go"
)

func main() {
    signer, err := x402.NewEVMSignerFromPrivateKey("0x<your-private-key>")
    if err != nil { log.Fatal(err) }

    handler, err := x402.NewHandler(x402.HandlerOptions{
        Network:   x402.NetworkBase, // or NetworkSKALE
        EVMSigner: signer,
    })
    if err != nil { log.Fatal(err) }

    // Feed the handler the `accepts` list from a 402 response:
    header, err := handler.Sign(context.Background(), accepts)
    // ...attach header as the "X-Payment" HTTP header and retry.
    _ = header
}
```

## Quick start — Solana

```go
signer, err := x402.NewSolanaSignerFromBase58("<base58-secret>")
handler, _ := x402.NewHandler(x402.HandlerOptions{
    Network:      x402.NetworkSolana,
    SolanaSigner: signer,
    // RPCURL: "https://your-rpc.example", // optional override
})
```

The Solana flow submits the `TransferChecked` transaction to the network
itself and returns the on-chain signature inside the X-Payment envelope.

## Plugging into the AceDataCloud Go SDK

The [`acedatacloud` Go SDK](https://github.com/AceDataCloud/SDK) exposes
a `PaymentHandler` interface that is invoked on 402 responses. Adapter:

```go
import (
    "context"

    acedatacloud "github.com/AceDataCloud/SDK/go"
    x402 "github.com/AceDataCloud/X402Client/go"
)

signer, _ := x402.NewEVMSignerFromPrivateKey(privateKey)
x402Handler, _ := x402.NewHandler(x402.HandlerOptions{
    Network:   x402.NetworkBase,
    EVMSigner: signer,
})

// Bridge x402.Handler → acedatacloud.PaymentHandler (tiny adapter).
bridge := acedatacloud.PaymentHandlerFunc(func(ctx context.Context, pctx acedatacloud.PaymentContext) (acedatacloud.PaymentResult, error) {
    accepts := make([]x402.PaymentRequirement, 0, len(pctx.Accepts))
    for _, a := range pctx.Accepts {
        accepts = append(accepts, x402.PaymentRequirementFromMap(a))
    }
    headers, err := x402Handler.Headers(ctx, accepts)
    if err != nil { return acedatacloud.PaymentResult{}, err }
    return acedatacloud.PaymentResult{Headers: headers}, nil
})

client, _ := acedatacloud.NewClient(acedatacloud.WithPaymentHandler(bridge))
```

## Testing

```bash
cd go
go vet ./...
go test ./...
```

Unit tests verify:

- EIP-712 digest round-trip (signature recovers to the signer's address)
- Default `USD Coin / v2 / chainId=8453` EIP-712 domain matches the TS/Python reference
- Handler validation (missing signer, unsupported network)
- Solana ATA derivation and instruction encoding shapes
- Requirement selection logic

## Live on-chain E2E script

The `scripts/e2e` binary hits a real AceDataCloud endpoint and
completes a SKALE / Base payment end-to-end. Requires USDC balance.

```bash
cd go
SKALE_BASE_PRIVATE_KEY=0x... go run ./scripts/e2e
```
