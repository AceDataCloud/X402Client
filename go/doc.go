// Package x402 is the Go implementation of the AceDataCloud x402 payment
// client. It mirrors the TypeScript (`@acedatacloud/x402-client`) and
// Python (`acedatacloud-x402`) packages.
//
// It signs an ``X-Payment`` header for HTTP 402 responses using either
// EIP-3009 ``TransferWithAuthorization`` (for EVM chains such as Base
// and SKALE) or an SPL ``TransferChecked`` transaction (for Solana).
//
// The package is designed to plug into the AceDataCloud Go SDK
// (``github.com/AceDataCloud/SDK/go``) as a ``PaymentHandler``. See the
// README for the 4-line adapter snippet.
package x402
