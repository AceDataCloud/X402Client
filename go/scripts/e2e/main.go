// Command e2e performs a real on-chain x402 payment to AceDataCloud's
// SKALE/Base facilitator and prints the result.
//
// Requires an EVM private key with USDC balance on the target chain.
// Read from the SKALE_BASE_PRIVATE_KEY env var by default.
//
//	cd go/scripts/e2e
//	SKALE_BASE_PRIVATE_KEY=0x... go run .
//
// This script intentionally does NOT depend on the AceDataCloud Go SDK
// — it exercises the x402 package in isolation against a real 402
// response from api.acedata.cloud.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	x402 "github.com/AceDataCloud/X402Client/go"
)

const (
	apiURL  = "https://api.acedata.cloud/v1/chat/completions"
	network = "skale" // or "base" / "solana"
)

func main() {
	pk := os.Getenv("SKALE_BASE_PRIVATE_KEY")
	if pk == "" {
		fmt.Fprintln(os.Stderr, "SKALE_BASE_PRIVATE_KEY not set")
		os.Exit(1)
	}

	signer, err := x402.NewEVMSignerFromPrivateKey(pk)
	if err != nil {
		fail(err)
	}
	fmt.Printf("Payer: %s\n", signer.Address())

	handler, err := x402.NewHandler(x402.HandlerOptions{
		Network:   x402.Network(network),
		EVMSigner: signer,
	})
	if err != nil {
		fail(err)
	}

	body := map[string]any{
		"model":    "gpt-4o-mini",
		"messages": []map[string]any{{"role": "user", "content": "Say hi in 3 words."}},
	}
	bodyBytes, _ := json.Marshal(body)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// 1. First request — expect 402 Payment Required.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(bodyBytes))
	if err != nil {
		fail(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	fmt.Println("\n=== Request 1: (no X-Payment) ===")
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fail(err)
	}
	respBody, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	fmt.Printf("Status: %d (%.2fs)\n", resp.StatusCode, time.Since(start).Seconds())

	if resp.StatusCode != http.StatusPaymentRequired {
		fmt.Printf("Body: %s\n", respBody)
		fmt.Println("Expected 402 Payment Required but got a different status. Exiting.")
		os.Exit(1)
	}

	var parsed struct {
		Accepts []map[string]any `json:"accepts"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		fail(fmt.Errorf("parse 402 body: %w", err))
	}
	accepts := make([]x402.PaymentRequirement, 0, len(parsed.Accepts))
	for _, a := range parsed.Accepts {
		accepts = append(accepts, x402.PaymentRequirementFromMap(a))
	}
	if len(accepts) == 0 {
		fail(fmt.Errorf("no accepts in 402 body"))
	}
	for _, a := range accepts {
		fmt.Printf("  accepts: network=%s payTo=%s amount=%s asset=%s\n", a.Network, a.PayTo, a.MaxAmountRequired, a.Asset)
	}

	// 2. Sign and retry.
	fmt.Println("\n=== Signing X-Payment header ===")
	header, err := handler.Sign(ctx, accepts)
	if err != nil {
		fail(err)
	}
	fmt.Printf("Header (base64, %d bytes)\n", len(header))
	preview := header
	if len(preview) > 80 {
		preview = preview[:80] + "..."
	}
	fmt.Printf("Preview: %s\n", preview)

	req2, _ := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(bodyBytes))
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Accept", "application/json")
	req2.Header.Set("X-Payment", header)

	fmt.Println("\n=== Request 2: (with X-Payment) ===")
	start = time.Now()
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		fail(err)
	}
	body2, _ := io.ReadAll(resp2.Body)
	_ = resp2.Body.Close()
	fmt.Printf("Status: %d (%.2fs)\n", resp2.StatusCode, time.Since(start).Seconds())

	if resp2.StatusCode >= 400 {
		fmt.Printf("Body: %s\n", body2)
		os.Exit(1)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body2, &decoded); err == nil {
		choices, _ := decoded["choices"].([]any)
		if len(choices) > 0 {
			if msg, ok := choices[0].(map[string]any)["message"].(map[string]any); ok {
				fmt.Printf("\nAssistant: %v\n", msg["content"])
			}
		}
	} else {
		fmt.Printf("Body: %s\n", body2)
	}

	// Surface the x402 tx hash if the gateway returned one.
	if tx := resp2.Header.Get("X-402-Tx"); tx != "" {
		fmt.Printf("\nx402 tx: %s\n", tx)
	}
	fmt.Println(strings.Repeat("=", 40))
	fmt.Println("SUCCESS")
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "error: %v\n", err)
	os.Exit(1)
}
