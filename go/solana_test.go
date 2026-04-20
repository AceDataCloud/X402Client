package x402

import (
	"strings"
	"testing"

	"github.com/gagliardetto/solana-go"
)

func TestNewSolanaSignerFromBytes_Invalid(t *testing.T) {
	if _, err := NewSolanaSignerFromBytes([]byte("tooShort")); err == nil {
		t.Fatal("expected error for short key")
	}
}

func TestNewSolanaSignerFromBase58_Invalid(t *testing.T) {
	if _, err := NewSolanaSignerFromBase58("not-base58-!!!"); err == nil {
		t.Fatal("expected error for invalid base58")
	}
}

func TestNewSolanaSignerFromBytes_Valid(t *testing.T) {
	// Generate a fresh keypair via solana-go to get a valid 64-byte secret.
	account := solana.NewWallet()
	secret := account.PrivateKey
	signer, err := NewSolanaSignerFromBytes([]byte(secret))
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if signer.Address() != account.PublicKey().String() {
		t.Fatalf("address mismatch: %s vs %s", signer.Address(), account.PublicKey().String())
	}
}

func TestFindATA_Deterministic(t *testing.T) {
	owner := solana.MustPublicKeyFromBase58("11111111111111111111111111111111")
	// USDC on mainnet
	mint := solana.MustPublicKeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	got := findATA(owner, mint)
	// Just verify it's deterministic and a real-looking pubkey.
	if got.String() == "" || got == owner {
		t.Fatalf("bad ATA: %s", got.String())
	}
	again := findATA(owner, mint)
	if !got.Equals(again) {
		t.Fatalf("findATA not deterministic")
	}
}

func TestBuildTransferCheckedData_Shape(t *testing.T) {
	data := buildTransferCheckedData(1000, 6)
	if len(data) != 10 {
		t.Fatalf("expected 10 bytes, got %d", len(data))
	}
	if data[0] != 12 {
		t.Fatalf("expected opcode 12, got %d", data[0])
	}
	if data[9] != 6 {
		t.Fatalf("expected decimals=6, got %d", data[9])
	}
}

func TestSolanaSigner_InvalidLength(t *testing.T) {
	if _, err := NewSolanaSignerFromBytes(make([]byte, 32)); err == nil {
		t.Fatal("expected error for 32-byte key")
	} else if !strings.Contains(err.Error(), "64 bytes") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestComputeBudgetDataShapes(t *testing.T) {
	lim := computeBudgetSetUnitLimit(200_000)
	if len(lim) != 5 || lim[0] != 2 {
		t.Fatalf("unit limit: %v", lim)
	}
	price := computeBudgetSetUnitPrice(1_000)
	if len(price) != 9 || price[0] != 3 {
		t.Fatalf("unit price: %v", price)
	}
}
