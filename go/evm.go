package x402

import (
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// EVMSigner signs EIP-3009 ``TransferWithAuthorization`` messages with a
// locally-held ECDSA private key. Use NewEVMSignerFromPrivateKey to
// construct one.
type EVMSigner struct {
	privateKey *ecdsa.PrivateKey
	address    common.Address
}

// NewEVMSignerFromPrivateKey builds a signer from a hex-encoded secp256k1
// private key. The ``0x`` prefix is optional.
func NewEVMSignerFromPrivateKey(pkHex string) (*EVMSigner, error) {
	pkHex = strings.TrimPrefix(pkHex, "0x")
	pk, err := crypto.HexToECDSA(pkHex)
	if err != nil {
		return nil, fmt.Errorf("invalid EVM private key: %w", err)
	}
	return &EVMSigner{privateKey: pk, address: crypto.PubkeyToAddress(pk.PublicKey)}, nil
}

// Address returns the signer's checksummed 0x address.
func (s *EVMSigner) Address() string { return s.address.Hex() }

// randomNonce32 returns a 0x-prefixed random 32-byte nonce.
func randomNonce32() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "0x" + hex.EncodeToString(b[:]), nil
}

// SignEVMPayment builds and signs a TransferWithAuthorization envelope
// for the given payment requirement. The returned envelope should be
// JSON-encoded and base64-encoded into the ``X-Payment`` header.
func SignEVMPayment(req PaymentRequirement, signer *EVMSigner) (*X402PaymentEnvelope, error) {
	if signer == nil {
		return nil, errors.New("x402: evm signer is nil")
	}
	if req.MaxAmountRequired == "" {
		return nil, errors.New("x402: maxAmountRequired is required")
	}
	value, ok := new(big.Int).SetString(req.MaxAmountRequired, 10)
	if !ok {
		return nil, fmt.Errorf("x402: invalid maxAmountRequired %q", req.MaxAmountRequired)
	}
	maxTimeout := req.MaxTimeoutSeconds
	if maxTimeout <= 0 {
		maxTimeout = 120
	}
	now := time.Now().Unix()
	nonce, err := randomNonce32()
	if err != nil {
		return nil, err
	}
	auth := EVMAuthorization{
		From:        signer.Address(),
		To:          req.PayTo,
		Value:       value.String(),
		ValidAfter:  fmt.Sprintf("%d", now),
		ValidBefore: fmt.Sprintf("%d", now+int64(maxTimeout)),
		Nonce:       nonce,
	}

	typedData, err := buildTypedData(req, auth)
	if err != nil {
		return nil, err
	}
	sig, err := signTypedData(signer.privateKey, typedData)
	if err != nil {
		return nil, fmt.Errorf("x402: EIP-712 sign: %w", err)
	}

	envelope := &X402PaymentEnvelope{
		X402Version: 2,
		Scheme:      firstNonEmpty(req.Scheme, "exact"),
		Network:     firstNonEmpty(req.Network, string(NetworkBase)),
		Payload:     EVMPayload{Authorization: auth, Signature: "0x" + hex.EncodeToString(sig)},
	}
	return envelope, nil
}

// buildTypedData mirrors typescript/src/evm.ts buildTypedData.
func buildTypedData(req PaymentRequirement, auth EVMAuthorization) (apitypes.TypedData, error) {
	extra := req.Extra
	if extra == nil {
		extra = map[string]any{}
	}

	domainName, _ := extra["name"].(string)
	if domainName == "" {
		domainName = "USD Coin"
	}
	domainVersion, _ := extra["version"].(string)
	if domainVersion == "" {
		domainVersion = "2"
	}

	// chainId may arrive as float64 (from JSON) or int.
	var chainID *big.Int
	switch v := extra["chainId"].(type) {
	case float64:
		chainID = big.NewInt(int64(v))
	case int:
		chainID = big.NewInt(int64(v))
	case int64:
		chainID = big.NewInt(v)
	case string:
		chainID, _ = new(big.Int).SetString(v, 10)
	}
	if chainID == nil {
		chainID = big.NewInt(8453) // Base mainnet default, matches TS.
	}

	verifyingContract, _ := extra["verifyingContract"].(string)
	if verifyingContract == "" {
		verifyingContract = req.Asset
	}
	if !common.IsHexAddress(verifyingContract) {
		return apitypes.TypedData{}, fmt.Errorf("x402: invalid verifyingContract %q", verifyingContract)
	}

	return apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"TransferWithAuthorization": []apitypes.Type{
				{Name: "from", Type: "address"},
				{Name: "to", Type: "address"},
				{Name: "value", Type: "uint256"},
				{Name: "validAfter", Type: "uint256"},
				{Name: "validBefore", Type: "uint256"},
				{Name: "nonce", Type: "bytes32"},
			},
		},
		PrimaryType: "TransferWithAuthorization",
		Domain: apitypes.TypedDataDomain{
			Name:              domainName,
			Version:           domainVersion,
			ChainId:           math.NewHexOrDecimal256(chainID.Int64()),
			VerifyingContract: common.HexToAddress(verifyingContract).Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"from":        auth.From,
			"to":          auth.To,
			"value":       auth.Value,
			"validAfter":  auth.ValidAfter,
			"validBefore": auth.ValidBefore,
			"nonce":       auth.Nonce,
		},
	}, nil
}

// signTypedData produces the 65-byte (R||S||V) EIP-712 signature. V is
// normalized to 27/28 to match Ethereum's canonical form, which is what
// the facilitator's ecrecover implementation expects.
func signTypedData(privKey *ecdsa.PrivateKey, typedData apitypes.TypedData) ([]byte, error) {
	domainSeparator, err := typedData.HashStruct("EIP712Domain", typedData.Domain.Map())
	if err != nil {
		return nil, fmt.Errorf("hash domain: %w", err)
	}
	messageHash, err := typedData.HashStruct(typedData.PrimaryType, typedData.Message)
	if err != nil {
		return nil, fmt.Errorf("hash message: %w", err)
	}
	raw := append([]byte{0x19, 0x01}, domainSeparator...)
	raw = append(raw, messageHash...)
	digest := crypto.Keccak256(raw)

	sig, err := crypto.Sign(digest, privKey)
	if err != nil {
		return nil, err
	}
	// crypto.Sign returns V as 0 or 1; canonical EIP-712 uses 27 or 28.
	sig[64] += 27
	return sig, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
