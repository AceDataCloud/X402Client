package x402

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// A well-known test private key (Hardhat account #0). Never used for real funds.
const testEVMKey = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

// Corresponding address:
const testEVMAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

func TestNewEVMSignerFromPrivateKey_Valid(t *testing.T) {
	s, err := NewEVMSignerFromPrivateKey(testEVMKey)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if !strings.EqualFold(s.Address(), testEVMAddress) {
		t.Fatalf("address mismatch: got %s", s.Address())
	}
}

func TestNewEVMSignerFromPrivateKey_Prefixed(t *testing.T) {
	s, err := NewEVMSignerFromPrivateKey("0x" + testEVMKey)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if !strings.EqualFold(s.Address(), testEVMAddress) {
		t.Fatalf("address mismatch")
	}
}

func TestNewEVMSignerFromPrivateKey_Invalid(t *testing.T) {
	if _, err := NewEVMSignerFromPrivateKey("zzz"); err == nil {
		t.Fatal("expected error")
	}
}

func TestSignEVMPayment_ProducesRecoverableSignature(t *testing.T) {
	signer, _ := NewEVMSignerFromPrivateKey(testEVMKey)
	req := PaymentRequirement{
		Scheme:            "exact",
		Network:           "base",
		MaxAmountRequired: "1000",
		MaxTimeoutSeconds: 120,
		PayTo:             "0x000000000000000000000000000000000000dEaD",
		Asset:             "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
		Extra: map[string]any{
			"name":    "USD Coin",
			"version": "2",
			"chainId": float64(8453),
		},
	}

	env, err := SignEVMPayment(req, signer)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	if env.X402Version != 2 || env.Scheme != "exact" || env.Network != "base" {
		t.Fatalf("bad envelope head: %+v", env)
	}
	payload, ok := env.Payload.(EVMPayload)
	if !ok {
		t.Fatalf("payload type: %T", env.Payload)
	}
	if payload.Authorization.From != testEVMAddress {
		// case-insensitive
		if !strings.EqualFold(payload.Authorization.From, testEVMAddress) {
			t.Fatalf("bad from: %s", payload.Authorization.From)
		}
	}
	if payload.Authorization.Value != "1000" {
		t.Fatalf("bad value: %s", payload.Authorization.Value)
	}

	// Re-derive the address from the signature to verify EIP-712 integrity.
	typedData, err := buildTypedData(req, payload.Authorization)
	if err != nil {
		t.Fatalf("rebuild typed data: %v", err)
	}
	domainSep, _ := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	msgHash, _ := typedData.HashStruct(typedData.PrimaryType, typedData.Message)
	digest := crypto.Keccak256(append(append([]byte{0x19, 0x01}, domainSep...), msgHash...))

	sigHex := strings.TrimPrefix(payload.Signature, "0x")
	sig := common.Hex2Bytes(sigHex)
	if len(sig) != 65 {
		t.Fatalf("signature length: %d", len(sig))
	}
	// Revert V from 27/28 to 0/1 for go-ethereum recovery.
	rec := make([]byte, 65)
	copy(rec, sig)
	rec[64] -= 27

	pub, err := crypto.SigToPub(digest, rec)
	if err != nil {
		t.Fatalf("sig->pub: %v", err)
	}
	recovered := crypto.PubkeyToAddress(*pub)
	if !strings.EqualFold(recovered.Hex(), testEVMAddress) {
		t.Fatalf("signature did not recover signer: recovered=%s want=%s", recovered.Hex(), testEVMAddress)
	}

	// Ensure the envelope serializes and base64-encodes without error.
	header, err := EncodePaymentHeader(env)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		t.Fatalf("b64: %v", err)
	}
	var round map[string]any
	if err := json.Unmarshal(decoded, &round); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if round["network"] != "base" {
		t.Fatalf("round-trip mismatch: %+v", round)
	}
}

func TestBuildTypedData_DefaultsMatchPython(t *testing.T) {
	req := PaymentRequirement{
		MaxAmountRequired: "1",
		PayTo:             "0x000000000000000000000000000000000000dEaD",
		Asset:             "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	}
	td, err := buildTypedData(req, EVMAuthorization{})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if td.Domain.Name != "USD Coin" {
		t.Errorf("default name: %s", td.Domain.Name)
	}
	if td.Domain.Version != "2" {
		t.Errorf("default version: %s", td.Domain.Version)
	}
	if td.Domain.ChainId == nil || (*big.Int)(td.Domain.ChainId).Int64() != 8453 {
		t.Errorf("default chainId: %+v", td.Domain.ChainId)
	}
	if td.PrimaryType != "TransferWithAuthorization" {
		t.Errorf("primary: %s", td.PrimaryType)
	}
	// sanity: required types present
	if _, ok := td.Types["TransferWithAuthorization"]; !ok {
		t.Error("missing TransferWithAuthorization type")
	}
	if _, ok := td.Types["EIP712Domain"]; !ok {
		t.Error("missing EIP712Domain type")
	}
	_ = apitypes.TypedDataDomain{} // ensure import is still required
}

func TestNewHandler_ValidationEVM(t *testing.T) {
	_, err := NewHandler(HandlerOptions{Network: NetworkBase})
	if err == nil {
		t.Fatal("expected error without EVM signer")
	}
	signer, _ := NewEVMSignerFromPrivateKey(testEVMKey)
	_, err = NewHandler(HandlerOptions{Network: NetworkBase, EVMSigner: signer})
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
}

func TestNewHandler_ValidationSolana(t *testing.T) {
	_, err := NewHandler(HandlerOptions{Network: NetworkSolana})
	if err == nil {
		t.Fatal("expected error without Solana signer")
	}
}

func TestNewHandler_UnsupportedNetwork(t *testing.T) {
	if _, err := NewHandler(HandlerOptions{Network: Network("ethereum")}); err == nil {
		t.Fatal("expected unsupported network error")
	}
	if _, err := NewHandler(HandlerOptions{}); err == nil {
		t.Fatal("expected empty network error")
	}
}

func TestHandler_SelectRequirementMatches(t *testing.T) {
	signer, _ := NewEVMSignerFromPrivateKey(testEVMKey)
	h, err := NewHandler(HandlerOptions{Network: NetworkBase, EVMSigner: signer})
	if err != nil {
		t.Fatal(err)
	}
	accepts := []PaymentRequirement{
		{Network: "solana", PayTo: "xxx", Asset: "yyy"},
		{
			Network:           "base",
			Scheme:            "exact",
			MaxAmountRequired: "100",
			PayTo:             "0x000000000000000000000000000000000000dEaD",
			Asset:             "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		},
	}
	header, err := h.Sign(context.Background(), accepts)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		t.Fatalf("b64: %v", err)
	}
	var env map[string]any
	_ = json.Unmarshal(raw, &env)
	if env["network"] != "base" {
		t.Fatalf("wrong network selected: %+v", env)
	}
}

func TestHandler_SelectRequirementMissing(t *testing.T) {
	signer, _ := NewEVMSignerFromPrivateKey(testEVMKey)
	h, _ := NewHandler(HandlerOptions{Network: NetworkBase, EVMSigner: signer})
	_, err := h.Sign(context.Background(), []PaymentRequirement{{Network: "solana"}})
	if err == nil || !strings.Contains(err.Error(), "no payment requirement") {
		t.Fatalf("expected missing-network error, got %v", err)
	}
}

func TestPaymentRequirementFromMap(t *testing.T) {
	req := PaymentRequirementFromMap(map[string]any{
		"scheme":            "exact",
		"network":           "base",
		"maxAmountRequired": "100",
		"maxTimeoutSeconds": float64(60),
		"payTo":             "0xabc",
		"asset":             "0xdef",
		"extra": map[string]any{
			"chainId": float64(8453),
		},
	})
	if req.Scheme != "exact" || req.Network != "base" || req.MaxTimeoutSeconds != 60 {
		t.Fatalf("bad: %+v", req)
	}
	if req.Extra["chainId"] == nil {
		t.Fatalf("missing extra: %+v", req.Extra)
	}
}
