package x402

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// HandlerOptions configures a Handler. At least one signer must be set
// for the selected network.
type HandlerOptions struct {
	Network      Network
	EVMSigner    *EVMSigner
	SolanaSigner *SolanaSigner
	// RPCURL optionally overrides the Solana RPC endpoint. Ignored for EVM.
	RPCURL string
	// HTTPClient optionally overrides the http.Client used for Solana RPC.
	HTTPClient *http.Client
}

// Handler produces ``X-Payment`` headers for a given 402 accepts list.
//
// It is intentionally self-contained — it does NOT depend on the
// AceDataCloud SDK's ``PaymentHandler`` interface. Plug it into the SDK
// with a trivial 4-line adapter; see the README.
type Handler struct {
	opts HandlerOptions
}

// NewHandler constructs a Handler and validates its options.
func NewHandler(opts HandlerOptions) (*Handler, error) {
	switch opts.Network {
	case NetworkBase, NetworkSKALE:
		if opts.EVMSigner == nil {
			return nil, fmt.Errorf(`x402: EVMSigner is required when network=%q`, opts.Network)
		}
	case NetworkSolana:
		if opts.SolanaSigner == nil {
			return nil, errors.New(`x402: SolanaSigner is required when network="solana"`)
		}
	case "":
		return nil, errors.New("x402: Network is required")
	default:
		return nil, fmt.Errorf("x402: unsupported network %q", opts.Network)
	}
	return &Handler{opts: opts}, nil
}

// Sign picks the matching requirement from ``accepts``, signs the
// payment (and for Solana submits it on-chain), and returns the
// ``X-Payment`` HTTP header value.
func (h *Handler) Sign(ctx context.Context, accepts []PaymentRequirement) (string, error) {
	req, err := h.selectRequirement(accepts)
	if err != nil {
		return "", err
	}
	var envelope *X402PaymentEnvelope
	switch h.opts.Network {
	case NetworkSolana:
		envelope, err = SignSolanaPayment(ctx, req, h.opts.SolanaSigner, h.opts.RPCURL, h.opts.HTTPClient)
	default:
		envelope, err = SignEVMPayment(req, h.opts.EVMSigner)
	}
	if err != nil {
		return "", err
	}
	return EncodePaymentHeader(envelope)
}

// Headers is a convenience that wraps Sign and returns a
// ``{"X-Payment": "<value>"}`` map, ready to merge into HTTP headers.
func (h *Handler) Headers(ctx context.Context, accepts []PaymentRequirement) (map[string]string, error) {
	value, err := h.Sign(ctx, accepts)
	if err != nil {
		return nil, err
	}
	return map[string]string{"X-Payment": value}, nil
}

// selectRequirement returns the first accepts entry whose network matches
// the configured handler network.
func (h *Handler) selectRequirement(accepts []PaymentRequirement) (PaymentRequirement, error) {
	for _, a := range accepts {
		if a.Network == string(h.opts.Network) {
			return a, nil
		}
	}
	var available string
	for i, a := range accepts {
		if i > 0 {
			available += ", "
		}
		available += a.Network
	}
	if available == "" {
		available = "<none>"
	}
	return PaymentRequirement{}, fmt.Errorf("x402: no payment requirement for network %q. Available: %s", h.opts.Network, available)
}

// EncodePaymentHeader serializes and base64-encodes an envelope.
func EncodePaymentHeader(envelope *X402PaymentEnvelope) (string, error) {
	raw, err := json.Marshal(envelope)
	if err != nil {
		return "", fmt.Errorf("x402: marshal envelope: %w", err)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}
