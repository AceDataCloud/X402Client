package x402

// Network identifies a supported chain.
type Network string

const (
	NetworkBase   Network = "base"
	NetworkSKALE  Network = "skale"
	NetworkSolana Network = "solana"
)

// PaymentRequirement mirrors a single entry in the server's 402 ``accepts`` list.
type PaymentRequirement struct {
	Scheme            string                 `json:"scheme,omitempty"`
	Network           string                 `json:"network,omitempty"`
	MaxAmountRequired string                 `json:"maxAmountRequired"`
	MaxTimeoutSeconds int                    `json:"maxTimeoutSeconds,omitempty"`
	Resource          string                 `json:"resource,omitempty"`
	Description       string                 `json:"description,omitempty"`
	PayTo             string                 `json:"payTo"`
	Asset             string                 `json:"asset"`
	Extra             map[string]any         `json:"extra,omitempty"`
}

// EVMAuthorization is the EIP-3009 message signed by the payer.
type EVMAuthorization struct {
	From        string `json:"from"`
	To          string `json:"to"`
	Value       string `json:"value"`
	ValidAfter  string `json:"validAfter"`
	ValidBefore string `json:"validBefore"`
	Nonce       string `json:"nonce"`
}

// EVMPayload is what the facilitator receives inside the X-Payment envelope.
type EVMPayload struct {
	Authorization EVMAuthorization `json:"authorization"`
	Signature     string           `json:"signature"`
}

// SolanaPayload for wallet-fee-payer mode: the submitted transaction signature.
type SolanaPayload struct {
	Signature string `json:"signature"`
}

// X402PaymentEnvelope is the JSON object base64-encoded into the
// ``X-Payment`` HTTP header.
type X402PaymentEnvelope struct {
	X402Version int    `json:"x402Version"`
	Scheme      string `json:"scheme"`
	Network     string `json:"network"`
	Payload     any    `json:"payload"`
}

// FromMap populates a PaymentRequirement from a ``map[string]any`` as
// received from a 402 response body. Missing or malformed fields are
// silently left at zero values — validation is deferred to signing.
func PaymentRequirementFromMap(m map[string]any) PaymentRequirement {
	var r PaymentRequirement
	r.Scheme, _ = m["scheme"].(string)
	r.Network, _ = m["network"].(string)
	r.MaxAmountRequired, _ = m["maxAmountRequired"].(string)
	if v, ok := m["maxTimeoutSeconds"].(float64); ok {
		r.MaxTimeoutSeconds = int(v)
	}
	r.Resource, _ = m["resource"].(string)
	r.Description, _ = m["description"].(string)
	r.PayTo, _ = m["payTo"].(string)
	r.Asset, _ = m["asset"].(string)
	if extra, ok := m["extra"].(map[string]any); ok {
		r.Extra = extra
	}
	return r
}
