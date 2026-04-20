package x402

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gagliardetto/solana-go"
	"github.com/mr-tron/base58"
)

var (
	tokenProgramID = solana.MustPublicKeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	ataProgramID   = solana.MustPublicKeyFromBase58("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
	// ComputeBudget111111111111111111111111111111 — for set_compute_unit_{limit,price}.
	computeBudgetID = solana.MustPublicKeyFromBase58("ComputeBudget111111111111111111111111111111")
)

// DefaultSolanaRPC is used when no override is supplied.
const DefaultSolanaRPC = "https://api.mainnet-beta.solana.com"

// SolanaSigner wraps a locally-held keypair.
type SolanaSigner struct {
	privateKey solana.PrivateKey
	publicKey  solana.PublicKey
}

// NewSolanaSignerFromBase58 decodes a base58-encoded 64-byte secret key.
func NewSolanaSignerFromBase58(encoded string) (*SolanaSigner, error) {
	raw, err := base58.Decode(encoded)
	if err != nil {
		return nil, fmt.Errorf("x402: invalid base58 secret key: %w", err)
	}
	return NewSolanaSignerFromBytes(raw)
}

// NewSolanaSignerFromBytes builds a signer from a 64-byte secret key.
func NewSolanaSignerFromBytes(secret []byte) (*SolanaSigner, error) {
	if len(secret) != 64 {
		return nil, fmt.Errorf("x402: Solana secret key must be 64 bytes, got %d", len(secret))
	}
	pk := solana.PrivateKey(secret)
	return &SolanaSigner{privateKey: pk, publicKey: pk.PublicKey()}, nil
}

// Address returns the signer's base58 public key.
func (s *SolanaSigner) Address() string { return s.publicKey.String() }

// findATA computes the associated token account for (owner, mint).
func findATA(owner, mint solana.PublicKey) solana.PublicKey {
	ata, _, err := solana.FindProgramAddress(
		[][]byte{owner.Bytes(), tokenProgramID.Bytes(), mint.Bytes()},
		ataProgramID,
	)
	if err != nil {
		// FindProgramAddress only fails if it cannot find a valid PDA in
		// 255 iterations, which is cryptographically negligible for
		// well-formed inputs.
		panic(err)
	}
	return ata
}

// buildTransferCheckedData produces the SPL instruction data: [12, amount(8 LE), decimals].
func buildTransferCheckedData(amount uint64, decimals uint8) []byte {
	data := make([]byte, 10)
	data[0] = 12
	binary.LittleEndian.PutUint64(data[1:9], amount)
	data[9] = decimals
	return data
}

// computeBudgetSetUnitLimit and computeBudgetSetUnitPrice produce raw
// instruction data for the two common ComputeBudget instructions.
func computeBudgetSetUnitLimit(units uint32) []byte {
	data := make([]byte, 5)
	data[0] = 2 // SetComputeUnitLimit discriminator
	binary.LittleEndian.PutUint32(data[1:5], units)
	return data
}

func computeBudgetSetUnitPrice(microLamports uint64) []byte {
	data := make([]byte, 9)
	data[0] = 3 // SetComputeUnitPrice discriminator
	binary.LittleEndian.PutUint64(data[1:9], microLamports)
	return data
}

// SolanaRPCClient is a tiny, dependency-free JSON-RPC client. Users may
// override the transport via WithHTTPClient.
type solanaRPC struct {
	endpoint string
	http     *http.Client
}

func newSolanaRPC(endpoint string, httpClient *http.Client) *solanaRPC {
	if endpoint == "" {
		endpoint = DefaultSolanaRPC
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &solanaRPC{endpoint: endpoint, http: httpClient}
}

func (c *solanaRPC) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  method,
		"params":  params,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("solana rpc %s: status %d: %s", method, resp.StatusCode, raw)
	}
	var parsed struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("solana rpc %s: bad response: %w (body=%s)", method, err, raw)
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("solana rpc %s: code=%d message=%s", method, parsed.Error.Code, parsed.Error.Message)
	}
	return parsed.Result, nil
}

func (c *solanaRPC) getLatestBlockhash(ctx context.Context) (solana.Hash, error) {
	raw, err := c.call(ctx, "getLatestBlockhash", []any{map[string]any{"commitment": "confirmed"}})
	if err != nil {
		return solana.Hash{}, err
	}
	var parsed struct {
		Value struct {
			Blockhash string `json:"blockhash"`
		} `json:"value"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return solana.Hash{}, err
	}
	h, err := solana.HashFromBase58(parsed.Value.Blockhash)
	if err != nil {
		return solana.Hash{}, fmt.Errorf("parse blockhash: %w", err)
	}
	return h, nil
}

func (c *solanaRPC) sendTransaction(ctx context.Context, tx *solana.Transaction) (string, error) {
	raw, err := tx.MarshalBinary()
	if err != nil {
		return "", fmt.Errorf("marshal tx: %w", err)
	}
	encoded := base58.Encode(raw)
	result, err := c.call(ctx, "sendTransaction", []any{encoded, map[string]any{"encoding": "base58", "preflightCommitment": "confirmed"}})
	if err != nil {
		return "", err
	}
	var sig string
	if err := json.Unmarshal(result, &sig); err != nil {
		return "", fmt.Errorf("parse signature: %w", err)
	}
	return sig, nil
}

// SignSolanaPayment builds, signs, and submits an SPL USDC transfer,
// then returns the X-Payment envelope containing the on-chain
// signature.
func SignSolanaPayment(ctx context.Context, req PaymentRequirement, signer *SolanaSigner, rpcURL string, httpClient *http.Client) (*X402PaymentEnvelope, error) {
	if signer == nil {
		return nil, errors.New("x402: solana signer is nil")
	}

	extra := req.Extra
	if extra == nil {
		extra = map[string]any{}
	}
	if override, ok := extra["rpcUrl"].(string); ok && override != "" && rpcURL == "" {
		rpcURL = override
	}

	payTo, err := solana.PublicKeyFromBase58(req.PayTo)
	if err != nil {
		return nil, fmt.Errorf("x402: invalid payTo: %w", err)
	}
	mint, err := solana.PublicKeyFromBase58(req.Asset)
	if err != nil {
		return nil, fmt.Errorf("x402: invalid asset (mint): %w", err)
	}

	amount, err := parseUint64(req.MaxAmountRequired)
	if err != nil {
		return nil, err
	}
	decimals := uint8(6)
	if v, ok := extraUint(extra, "decimals"); ok {
		decimals = uint8(v)
	}

	payer := signer.publicKey
	sourceATA := findATA(payer, mint)
	destATA := findATA(payTo, mint)

	var instructions []solana.Instruction
	if v, ok := extraUint(extra, "computeUnitLimit"); ok && v > 0 {
		instructions = append(instructions, rawInstruction(
			computeBudgetID,
			nil,
			computeBudgetSetUnitLimit(uint32(v)),
		))
	}
	if v, ok := extraUint(extra, "computeUnitPriceMicroLamports"); ok && v > 0 {
		instructions = append(instructions, rawInstruction(
			computeBudgetID,
			nil,
			computeBudgetSetUnitPrice(v),
		))
	}
	instructions = append(instructions, rawInstruction(
		tokenProgramID,
		[]*solana.AccountMeta{
			{PublicKey: sourceATA, IsSigner: false, IsWritable: true},
			{PublicKey: mint, IsSigner: false, IsWritable: false},
			{PublicKey: destATA, IsSigner: false, IsWritable: true},
			{PublicKey: payer, IsSigner: true, IsWritable: false},
		},
		buildTransferCheckedData(amount, decimals),
	))

	rpc := newSolanaRPC(rpcURL, httpClient)
	blockhash, err := rpc.getLatestBlockhash(ctx)
	if err != nil {
		return nil, fmt.Errorf("get blockhash: %w", err)
	}

	tx, err := solana.NewTransaction(instructions, blockhash, solana.TransactionPayer(payer))
	if err != nil {
		return nil, fmt.Errorf("build tx: %w", err)
	}
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(payer) {
			return &signer.privateKey
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("sign tx: %w", err)
	}

	sig, err := rpc.sendTransaction(ctx, tx)
	if err != nil {
		return nil, err
	}

	return &X402PaymentEnvelope{
		X402Version: 2,
		Scheme:      firstNonEmpty(req.Scheme, "exact"),
		Network:     firstNonEmpty(req.Network, string(NetworkSolana)),
		Payload:     SolanaPayload{Signature: sig},
	}, nil
}

// rawInstruction implements solana.Instruction for a program that takes
// a raw byte slice (ComputeBudget, SPL Token). The solana-go public API
// used to expose a concrete "GenericInstruction" type but its shape has
// shifted across versions, so we construct the minimum surface here.
type rawInstructionImpl struct {
	programID solana.PublicKey
	accounts  []*solana.AccountMeta
	data      []byte
}

func (r *rawInstructionImpl) ProgramID() solana.PublicKey    { return r.programID }
func (r *rawInstructionImpl) Accounts() []*solana.AccountMeta { return r.accounts }
func (r *rawInstructionImpl) Data() ([]byte, error)           { return r.data, nil }

func rawInstruction(programID solana.PublicKey, accounts []*solana.AccountMeta, data []byte) solana.Instruction {
	return &rawInstructionImpl{programID: programID, accounts: accounts, data: data}
}

func parseUint64(s string) (uint64, error) {
	var v uint64
	_, err := fmt.Sscanf(s, "%d", &v)
	if err != nil {
		return 0, fmt.Errorf("x402: invalid uint %q: %w", s, err)
	}
	return v, nil
}

func extraUint(m map[string]any, key string) (uint64, bool) {
	switch v := m[key].(type) {
	case float64:
		return uint64(v), true
	case int:
		return uint64(v), true
	case int64:
		return uint64(v), true
	case uint64:
		return v, true
	case string:
		if v == "" {
			return 0, false
		}
		x, err := parseUint64(v)
		return x, err == nil
	}
	return 0, false
}

// (Unused) buf is retained for potential future encoding helpers.
var _ = bytes.NewReader
