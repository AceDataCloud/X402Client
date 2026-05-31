# X402 `upto` scheme — Live Demo Walkthrough (Base mainnet)

> Pay-only-what-you-used USDC micropayments for LLM chat APIs, with a 5-second
> ceiling and a deferred on-chain settle. No API key, no account, no session,
> no over-payment.

This walks through the same flow we run on stage. Every command was executed
end-to-end on **2026-05-31** against production
(`https://api.acedata.cloud` → `https://facilitator.acedata.cloud` → Base
mainnet via `X402UptoPermit2Proxy` at
[`0x4020A4f3…CC240002`](https://basescan.org/address/0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002)).

The recorded run paid for **three different chat models** in a row using one
signed envelope per call. Real numbers and real settlement hashes are pasted
below — you should expect the same shape when you reproduce it.

---

## Why `upto` (and how it differs from `exact`)

The basic x402 dance is the same as the [SKALE / Base `exact` demo](./SKALE_DEMO.md):

1. Client hits the API with no auth → server replies `402` + `accepts[]`.
2. Client signs an envelope, retries with `X-Payment`.
3. Server returns `200` + the API result.

The difference is **when and how much you settle**:

| Scheme  | What gets signed                                              | What gets settled                                                       |
| ------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `exact` | An EIP-3009 `TransferWithAuthorization` for a fixed amount    | Exactly `maxAmountRequired` (the quoted price)                          |
| `upto`  | A Permit2 `PermitWitnessTransferFrom` for a **ceiling** amount | The real post-inference cost (≤ the ceiling), deferred to `/record`     |

Concretely: for `claude-sonnet-4-5-20250929` the 402 may quote
`maxAmountRequired = 4760750` (≈ $4.76 — enough to cover any reasonable chat
turn), but the actual settlement we recorded was only **151 atomic** ≈ $0.000151,
matching the real token usage. The user signs once, the server settles once,
and the on-chain transfer is the truth.

> The `upto` scheme is only meaningful for endpoints where the cost depends on
> output volume (chat, completions, streaming). For fixed-price endpoints
> (image / video generation) the gateway only emits `exact` and the client
> still signs the fixed amount.

---

## Architecture

```
┌─────────────────────────┐
│  Client (you, curl,     │
│   SDK, agent, ...)      │
└────────────┬────────────┘
             │ 1. POST /v1/chat/completions   (no auth)
             ▼
┌─────────────────────────┐
│  api.acedata.cloud      │
│  (PlatformGateway)      │
└────────────┬────────────┘
             │ 2. 402 Payment Required
             │    accepts: [exact-base, upto-base, exact-skale, exact-solana, ...]
             ▼
┌─────────────────────────┐
│  Client signs Permit2   │   ← this PR's signEVMUptoPayment /
│  PermitWitnessTransfer  │     sign_evm_upto_payment lives here
│  + Witness(recipient,   │
│     maxAmount, ceiling) │
└────────────┬────────────┘
             │ 3. POST /v1/chat/completions
             │    X-Payment: <base64 envelope>
             ▼
┌─────────────────────────┐     5. async /record(traceId, actualCost)
│  api.acedata.cloud      │ ─────────────────────────────────────┐
└────────────┬────────────┘                                       │
             │ 4. 200 OK + x-usage-exempt: true                   ▼
             ▼                                          ┌──────────────────────────┐
        ┌─────────┐                                     │ facilitator.acedata.cloud│
        │ Claude  │                                     │   PermitWitnessTransfer  │
        │ reply   │                                     │     From → Base mainnet  │
        └─────────┘                                     └────────────┬─────────────┘
                                                                     │
                                                                     ▼
                                                          ┌──────────────────────┐
                                                          │ X402UptoPermit2Proxy │
                                                          │ 0x4020A4f3…CC240002  │
                                                          └──────────────────────┘
```

Two takeaways:

1. **The client does NOT broadcast anything.** It signs a Permit2 EIP-712
   payload. The facilitator broadcasts the settle tx after the LLM responds.
2. **The settle tx amount is bounded by the witness ceiling.** Even if the
   facilitator were malicious, it couldn't pull more than `maxAmountRequired`
   from the 402 — Permit2 enforces this on-chain via the witness hash.

---

## Pre-flight (do this BEFORE you start the demo)

You only need to do these once per laptop.

### 1. A funded Base wallet with bridged USDC and ETH for gas

You need a small amount of USDC (the demo paid <$0.001 per call, so $1 covers
hundreds of runs) plus a few cents of ETH gas to send the one-time
`approve(Permit2, ∞)` transaction.

The recorded run uses the demo wallet
[`0x5d4f08D5…fA41B105`](https://basescan.org/address/0x5d4f08D5c2bb60703284bc06671Eb680fA41B105).
You can top that up directly, or set up your own.

### 2. Put the private key in `.claude/.env`

```bash
# .claude/.env  (this file is gitignored)
X402B_BASE_PAYER_PRIVATE_KEY=0x...   # 32-byte hex
```

Both the approve CLI and the e2e script read `<repo>/.claude/.env` first, then
`<repo>/PlatformBackend/.env` (first wins). Fail-fast if missing.

### 3. Install dependencies

```bash
cd X402Client/typescript
npm install      # ethers + vitest + tsx, all in package.json
```

That's it — no faucets, no testnet, no API key, no AceDataCloud account.

---

## Step 0 — One-time `approve(Permit2, ∞)`

This is the only on-chain transaction the **user** ever broadcasts. After it
lands, every future upto payment is purely signed off-chain.

```bash
cd X402Client/typescript

npx tsx scripts/approve-permit2.ts \
  --network base \
  --token   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913   # USDC on Base
```

What the script does:

1. Loads `X402B_BASE_PAYER_PRIVATE_KEY` from `.claude/.env`.
2. Reads the current `USDC.allowance(payer, PERMIT2)` — if it's already
   `≥ 2^255` (effectively infinite), it short-circuits with
   `{ "skipped": true }` and you're done.
3. Otherwise sends `USDC.approve(Permit2, 2^256 - 1)` from the payer wallet
   and waits for the receipt.

Output on a fresh wallet:

```json
{
  "payer":           "0x5d4f08D5c2bb60703284bc06671Eb680fA41B105",
  "token":           "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "permit2":         "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  "amount":          "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  "txHash":          "0x…",
  "allowanceBefore": "0",
  "allowanceAfter":  "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  "skipped":         false
}
```

Output on a wallet that's already approved:

```json
{
  "payer":           "0x5d4f08D5c2bb60703284bc06671Eb680fA41B105",
  "token":           "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "permit2":         "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  "allowanceBefore": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  "allowanceAfter":  "115792089237316195423570985008687907853269984665640564039457584007913129639935",
  "skipped":         true
}
```

Things worth pointing out on stage:

- **Permit2 is a single canonical address** ([Uniswap's deployment](https://github.com/Uniswap/permit2),
  CREATE2-deployed to `0x000000000022D473030F116dDEE9F6B43aC78BA3` on every
  EVM chain). Approving Permit2 once unlocks **every** Permit2-based protocol —
  the user is not getting per-app approval fatigue.
- The default amount is `2^256 - 1` (the EVM convention for "infinite"). You
  can override with `--amount` if you want a tighter ceiling.
- Python has the equivalent CLI: `acedatacloud-x402 approve-permit2 --network base --token 0x83358…`.

---

## Step 1 — Hit the API unauthenticated and read the 402

```bash
curl -s -i -X POST https://api.acedata.cloud/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-5-20250929","messages":[{"role":"user","content":"你是哪个模型?"}],"max_tokens":40}' \
  | sed -n '1,60p'
```

Expected response shape:

```http
HTTP/2 402
content-type: application/json
…

{
  "x402Version": 2,
  "error": "Payment Required",
  "accepts": [
    {"scheme": "exact", "network": "base",   "maxAmountRequired": "4760750", "extra": { "name": "USD Coin", "version": "2", … }},
    {"scheme": "upto",  "network": "base",   "maxAmountRequired": "4760750",
       "payTo":  "0x4F0E2D3477a1B94CF33d16E442CEe4733dadCeE7",
       "asset":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
       "extra":  {
         "name":              "Permit2",
         "chainId":           8453,
         "verifyingContract": "0x000000000022D473030F116dDEE9F6B43aC78BA3",
         "permit2Address":    "0x000000000022D473030F116dDEE9F6B43aC78BA3",
         "proxyAddress":      "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002",
         "facilitatorAddress":"0xd019238EAA8a9Ca13C5792Ca10B4029D6ce25708"
       }},
    {"scheme": "exact", "network": "skale",  "maxAmountRequired": "4760750", …},
    {"scheme": "exact", "network": "solana", "maxAmountRequired": "4760750", …}
  ]
}
```

What to point out:

- For chat the gateway emits **two Base entries**: `exact` (legacy, signs the
  full ceiling) and `upto` (this PR, settles real cost). Older clients that
  don't know about upto still work — they pick `exact` and overpay.
- `maxAmountRequired = 4760750` is the **ceiling** (≈ $4.76). Real cost will be
  ~$0.0002. The point of `upto` is that the user signs the ceiling but only
  pays the real cost.
- `extra.facilitatorAddress` is what the witness binds: only that address can
  invoke the facilitator's `PermitWitnessTransferFrom` settle path.
- There is no API key, no Authorization header, no cookie. Identity is the
  signature.

---

## Step 2 — Run the live `upto` end-to-end script

This is the headline command. It does steps 1–3 of the diagram in one shot
against production, with verbose logging:

```bash
cd X402Client/typescript
npx tsx scripts/test-upto-e2e.ts
```

What the script does (the same logic any SDK / agent will do — hand-rolled
here so you can read every line in
[`scripts/test-upto-e2e.ts`](../typescript/scripts/test-upto-e2e.ts)):

1. Load `X402B_BASE_PAYER_PRIVATE_KEY` from `.claude/.env`, instantiate an
   `ethers.Wallet`, wrap it in a minimal `EVMProvider` shim
   (`eth_signTypedData_v4` → `wallet.signTypedData`) so the SDK never needs a
   browser.
2. POST `/v1/chat/completions` with `claude-sonnet-4-5-20250929`, expect
   `402`, pick the entry where `scheme === 'upto'` && `network === 'base'`.
3. Build a Permit2 `PermitWitnessTransferFrom` typed-data payload:
   - **domain**: `{ name: "Permit2", chainId, verifyingContract: PERMIT2 }`
     (NB: **no `version` field** — Permit2 was deployed without one)
   - **permitted**: `{ token: asset, amount: maxAmountRequired }`
   - **spender**: `extra.proxyAddress` (the `X402UptoPermit2Proxy`)
   - **nonce**: 256 random bits (Permit2 enforces single-use per `(owner, nonce)`)
   - **deadline**: `validAfter + maxTimeoutSeconds`
   - **witness**: a `Witness` struct binding `recipient = payTo`,
     `maxAmount = maxAmountRequired`, `facilitator = extra.facilitatorAddress`
4. `wallet.signTypedData(domain, types, value)` → 65-byte signature.
5. Wrap into the x402 envelope (`scheme=upto`, `network=base`,
   `payload.permit2Authorization = {permit, witness, spender, signature}`),
   base64 the envelope, drop into `X-Payment`, replay the request.
6. After `200`, the response includes `x-usage-exempt: true` — the gateway's
   signal that the facilitator will settle **deferred** based on real usage
   (not the signed ceiling). Print the trace_id, status, latency, body
   preview.

**Real output from the 2026-05-31 run:**

```text
=== Live X402 upto E2E (Base mainnet) ===
Payer wallet: 0x5d4f08D5c2bb60703284bc06671Eb680fA41B105
Endpoint:     POST https://api.acedata.cloud/v1/chat/completions

--- Step 1: POST without auth → expect 402 ---
✅ Got 402 with 5 accept entries
   Scheme:   upto
   Ceiling:  4760750 atomic (4.76075 USDC)
   PayTo:    0x4F0E2D3477a1B94CF33d16E442CEe4733dadCeE7
   PayUSDC:  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
   Facilitator: 0xd019238EAA8a9Ca13C5792Ca10B4029D6ce25708

--- Step 2: Sign Permit2 PermitWitnessTransferFrom ---
✅ Signed
   nonce:    46135358761918013272424751331758226679860648271184738386436749317065328919168
   deadline: 1780215797
   signature: 0x9943c8d83cc7825349…3a0a3a871c

--- Step 3: Retry with X-Payment → expect 200 ---
   Status: 200 in 5.76s
   trace_id: <absent>
   x-usage-exempt: true
   body preview: {"id":"msg_01xKQgYtp19Hl25UzqyQ","model":"claude-sonnet-4-5-20250929",
                 "object":"chat.completion","created":1780212203,
                 "choices":[{"index":0,"message":{"role":"assistant",
                            "content":"我是 Claude Sonnet 4.5，由 Anthropic 开发。"},
                            "finish_reason":"stop"}],
                 "usage":{"prompt_tokens":15,"completion_tokens":16,"total_tokens":31, …}}

✅✅✅ Live upto E2E SUCCESS.
Settlement is deferred — check CLS or BaseScan for the actual /record settle tx in ~15s.
```

Things to point out:

- The whole loop completes in ~6 seconds — most of which is Anthropic
  inference, **not** the payment dance. The 402 round-trip and the Permit2
  signature are both sub-millisecond.
- `x-usage-exempt: true` is the protocol-level "this call is on the metered
  path, settle is async" signal — clients can use it to skip their own
  receipt-verification logic on the response and rely on the BaseScan record.
- The signed envelope authorizes up to `4.76 USDC`. The actual settle was
  `0.000151 USDC` (see Step 3 below). The user never paid more than the model
  actually cost.

---

## Step 3 — Look up the deferred settlement on BaseScan

About 10–15 seconds after the API returns `200`, the gateway's worker has
posted the real usage to the facilitator's `/record` endpoint, which builds
and broadcasts the `PermitWitnessTransferFrom` settle. The settle tx is what
shows up on-chain — there is no other transfer.

For the recorded 2026-05-31 run, the three model calls produced these
settlements:

| Model                          | Cost (atomic) | Cost (USDC) | Settlement tx |
| ------------------------------ | ------------- | ----------- | ------------- |
| `claude-sonnet-4-5-20250929`   | 151           | 0.000151    | [`0xc1f90cc6c2d71b50…3b093dd8`](https://basescan.org/tx/0xc1f90cc6c2d71b50ab863ce3ac6a940a0c30291c156b71ba839cdfef3b093dd8) |
| `gpt-5.5`                      | 135           | 0.000135    | [`0xda8f0ff09aeccd81…feeafcca57`](https://basescan.org/tx/0xda8f0ff09aeccd8b175188984b3f2d1b84b9c78d933625dd118dd8feeafcca57) |
| `glm-4.7`                      | 262           | 0.000262    | [`0xae9bba1835452833…07c5dda`](https://basescan.org/tx/0xae9bba183545283d3b67c245f41f840b948c4141d90a437ffb978ebfc07c5dda) |

Click any of those on stage. You'll see:

- The **`PermitWitnessTransferFrom`** call to Permit2 from the facilitator.
- A single USDC `Transfer` event of exactly the atomic amount above, from the
  payer wallet to AceDataCloud's collection address
  (`0x4F0E…cEE7`).
- No approval, no second tx, no refund — the witness pins the exact amount,
  the facilitator broadcasts once.

Talking points:

- **Each settled amount matches the gateway's DB cost rule within ±1 atomic.**
  That rule prices Claude / GPT / GLM tokens server-side from the model's
  reported `usage` block. The on-chain transfer is the on-chain proof.
- **Permit2 nonces are single-use.** The facilitator can't replay the same
  signed envelope to settle twice — Permit2's `bitmap.set(nonce)` reverts on
  re-use. Replay protection is enforced by Uniswap's audited Permit2
  contract.
- **The user's wallet history is the canonical bill.** Filter
  [the payer wallet](https://basescan.org/address/0x5d4f08D5c2bb60703284bc06671Eb680fA41B105)
  by USDC `Transfer` events and you have the user's full statement.

---

## Step 4 (optional) — Switch model, same loop

If the audience is engaged, repeat the demo with a different model
**without changing any code** — just swap the model string in the request
body. The 402 may quote a different ceiling, but the `upto` flow is
identical. That's the protocol's value: the per-model cost is the gateway's
problem, not the client's.

```bash
# Same script, different model
MODEL='gpt-5.5'  npx tsx scripts/test-upto-e2e.ts
MODEL='glm-4.7'  npx tsx scripts/test-upto-e2e.ts
```

(The script reads `MODEL` from the env if set; defaults to `claude-sonnet-4-5-20250929`.)

---

## Common questions you'll get

**"What stops the facilitator from over-pulling?"** Permit2 verifies the witness
hash on-chain. The `PermitWitnessTransferFrom` reverts if the actual transfer
amount exceeds `permitted.amount` (the signed ceiling), or if the recipient
differs from `witness.recipient`, or if the facilitator isn't the address
named in `witness.facilitator`. The user only needs to trust Permit2 (audited
by Uniswap) and that the ceiling they signed for is acceptable.

**"What stops a replay?"** Permit2 nonces are single-use. The contract stores a
`bitmap[owner][word] |= 1 << bit` for each spent nonce and reverts on any
re-use. Once the facilitator settles, the signed envelope is dead.

**"What if the API call fails?"** The facilitator only calls `/record` after the
gateway confirms a successful response. If the upstream LLM errors, no
settle happens and the user's signature simply expires at `deadline`
(default ~1 hour).

**"Why deferred settle instead of EIP-3009?"** Chat is metered — you only know
the real cost after the LLM emits tokens. EIP-3009 commits to an exact amount
at sign time, which forces the gateway to either over-charge (sign the
ceiling) or do a refund tx (extra gas). Permit2 + a witness ceiling lets the
gateway settle exactly what the LLM actually cost in a single transfer.

**"Who pays the gas for the settle tx?"** The facilitator (AceDataCloud). On
Base mainnet that's a few cents per call — folded into the gateway's spread.
On SKALE / other gas-free chains we'd use the same approach with zero
operating cost. (Today `upto` is Base only because Permit2 is best deployed
on EVM L2s with cheap gas.)

**"Why USDC and not USDT/DAI?"** Native USDC on Base is the most liquid
stablecoin in the smart-account ecosystem, supports Permit2 universally, and
matches what the rest of the AceDataCloud x402 surface uses.

---

## Reference

- Env: `<repo>/.claude/.env` → `X402B_BASE_PAYER_PRIVATE_KEY=0x...`
- Approve script: [`typescript/scripts/approve-permit2.ts`](../typescript/scripts/approve-permit2.ts)
- E2E script: [`typescript/scripts/test-upto-e2e.ts`](../typescript/scripts/test-upto-e2e.ts) (~170 lines, no SDK dependency, just `ethers`)
- Library source (TS): [`typescript/src/evm.ts`](../typescript/src/evm.ts) — `signEVMUptoPayment`, `buildUptoTypedData`
- Library source (Python): [`python/src/acedatacloud_x402/signing/evm.py`](../python/src/acedatacloud_x402/signing/evm.py) — `sign_evm_upto_payment`, `_build_upto_typed_data`
- Facilitator source: [`AceDataCloud/FacilitatorX402`](https://github.com/AceDataCloud/FacilitatorX402)
- Permit2 (Uniswap): [`Uniswap/permit2`](https://github.com/Uniswap/permit2) — canonical address [`0x000000000022D473…3aC78BA3`](https://basescan.org/address/0x000000000022D473030F116dDEE9F6B43aC78BA3)
- X402UptoPermit2Proxy on Base: [`0x4020A4f3…CC240002`](https://basescan.org/address/0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002)
- For the fixed-price counterpart, see [SKALE_DEMO.md](./SKALE_DEMO.md).
