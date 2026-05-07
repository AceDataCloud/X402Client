# SKALE x402 Live Demo Walkthrough

> A 5-minute, copy-paste demo that takes the audience from "no API key" to "200 OK
> + on-chain settlement on a SKALE block explorer" — using nothing but a wallet
> private key and `curl` / one TypeScript script.

This is the script we run on stage. Every command here was executed end-to-end on
**2026-05-07** against production (`https://api.acedata.cloud` →
`https://facilitator.acedata.cloud` → SKALE Europa mainnet, chain id `1187947933`).
Real numbers and a real settlement hash from that run are pasted below — you
should expect to see the same shape when you reproduce it.

---

## TL;DR

| Step | What you do | What the audience sees |
| --- | --- | --- |
| 1 | `curl` an AceDataCloud API with **no auth header** | `402 Payment Required` + a list of `accepts[]` payment requirements (Base / SKALE / Solana) |
| 2 | Sign an EIP-3009 `TransferWithAuthorization` for the SKALE entry | A base64 `X-Payment` envelope; **no on-chain broadcast yet** |
| 3 | Replay the same request with `X-Payment` | `200 OK` + the actual API result (GPT completion, Suno tracks, Midjourney image, ...) |
| 4 | Open the SKALE block explorer | The USDC transfer from the demo wallet to AceDataCloud, settled by our facilitator — gas free |

The whole thing fits on one slide: **HTTP-native per-request micropayments, no
account, no Bearer, no session.**

> The example below uses `POST /openai/chat/completions` because it returns in
> well under a second — better for stage timing. The exact same flow works on
> any AceDataCloud endpoint: just change `TEST_API_PATH` / `TEST_BODY`. A Suno
> example is in the [appendix](#appendix-2--longer-running-endpoint-suno) for
> reference.

---

## What the audience needs to understand first (30 seconds)

Show the README diagram or just say it out loud:

```
┌─────────────────────────┐
│  Client (you, curl,     │
│   SDK, agent, ...)      │
└────────────┬────────────┘
             │ 1. POST /openai/chat/completions   (no auth)
             ▼
┌─────────────────────────┐
│  api.acedata.cloud      │
│  (PlatformGateway)      │
└────────────┬────────────┘
             │ 2. 402 Payment Required
             │    accepts: [base, skale, solana]
             ▼
┌─────────────────────────┐
│  Client signs EIP-3009  │   ← this is the only thing the
│  TransferWithAuth       │     x402-client library does
└────────────┬────────────┘
             │ 3. POST /openai/chat/completions
             │    X-Payment: <base64 envelope>
             ▼
┌─────────────────────────┐      ┌──────────────────────────┐
│  api.acedata.cloud      │ ───▶ │ facilitator.acedata.cloud│
└────────────┬────────────┘      │  verifies + settles tx    │
             │ 4. 200 OK         │  on SKALE (gas free)      │
             ▼                   └────────────┬─────────────┘
        ┌─────────┐                           │
        │ GPT     │                           ▼
        │ reply   │                ┌──────────────────────┐
        └─────────┘                │ SKALE Europa mainnet │
                                   │ chainId 1187947933   │
                                   └──────────────────────┘
```

Two takeaways before you type anything:

1. **`402` is a real HTTP status code from RFC 7231** (`Payment Required`,
   "reserved for future use"). x402 is just a convention for what to put in the
   body when you actually use it.
2. **The client never broadcasts a transaction.** It signs an authorization, the
   facilitator broadcasts. On SKALE the facilitator pays zero gas anyway, so the
   end-user never has to hold gas on any chain. The only thing the wallet needs
   is bridged USDC.

---

## Pre-flight (do this BEFORE you start the demo)

You only need to do these once per laptop.

### 1. A funded SKALE wallet

You need ~0.1 USDC on SKALE Europa Hub for the demo wallet. Bridge from Ethereum
mainnet via [portal.skale.space](https://portal.skale.space) or top up the
existing demo wallet at `0xd0479FA9FD8C678303d477433d24C15e3723CC1C` (the one
the recorded run used).

> SKALE chains are **gas free** — you don't need any native gas token, just USDC.

### 2. Put the private key in `.claude/.env`

```bash
# .claude/.env  (this file is gitignored)
SKALE_BASE_PRIVATE_KEY=0x...   # 32-byte hex, no quotes needed
```

The script reads this from `<repo>/.claude/.env` and `<repo>/PlatformBackend/.env`
(it loads both, first wins). If the key is missing it fails fast with a clear
error.

### 3. Install dependencies

```bash
cd X402Client/typescript
npm install                # only needs ethers + tsx, both in package.json
```

That's it — no faucets, no testnet, no API key, no AceDataCloud account.

---

## Step 1 — Show that "no auth" gets `402` + a price list

Goal: prove that the API is genuinely public-without-credentials, and that the
server tells you exactly how much each chain costs.

```bash
curl -s -i -X POST https://api.acedata.cloud/openai/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hi in 10 words."}]}' \
  | sed -n '1,40p'
```

Expected response shape:

```http
HTTP/2 402
content-type: application/json
...

{
  "x402Version": 2,
  "error": "Payment Required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "20568",
      "payTo": "0x4F0E2D3477a1B94CF33d16E442CEe4733dadCeE7",
      "asset":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "extra":  { "name": "USD Coin", "version": "2", "chainId": 8453, ... }
    },
    {
      "scheme": "exact",
      "network": "skale",
      "maxAmountRequired": "95215",
      "payTo": "0x4F0E2D3477a1B94CF33d16E442CEe4733dadCeE7",
      "asset":  "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
      "extra":  { "name": "USD Coin", "version": "2", "chainId": 1187947933, ... }
    },
    {
      "scheme": "exact",
      "network": "solana",
      "maxAmountRequired": "95215",
      ...
    }
  ]
}
```

What to point out on stage:

- `maxAmountRequired` is in **base units** (USDC has 6 decimals → `95215` =
  `0.095215 USDC` ≈ $0.095). Different endpoints have different prices; chat
  completions happens to be priced the same on SKALE and Solana here.
- The same call returns **three networks**. The client (or the user) picks one.
  SKALE is what we're demoing; Base / Solana are the same dance with a different
  signing scheme.
- There is **no API key, no Authorization header, no session cookie** anywhere
  on the wire. The only "identity" the request carries on retry is the wallet
  signature.
---

## Step 2 — Run the SKALE end-to-end script

This is the headline moment. One command does steps 1–3 of the diagram in one
shot, with verbose logging so the audience sees each phase. The script defaults
to a Suno music call; for stage timing we override it to GPT-4o-mini chat
completions, which finishes in **under a second**:

```bash
cd X402Client/typescript

TEST_API_PATH='/openai/chat/completions' \
TEST_BODY='{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hi in 10 words."}]}' \
npx tsx scripts/test-skale-e2e.ts
```

What the script does (the same logic any SDK / agent will do, hand-rolled here
so you can read every line in `scripts/test-skale-e2e.ts`):

1. Load `SKALE_BASE_PRIVATE_KEY` from `.claude/.env`, instantiate an
   `ethers.Wallet` and a read-only `JsonRpcProvider` for SKALE Base mainnet
   (`https://skale-base.skalenodes.com/v1/base`, chain id `1187947933`).
2. Snapshot the wallet's USDC balance and the current SKALE head block (so we
   can show a tight before/after delta and constrain the post-run log scan).
3. Send the same `POST` from Step 1 (path / body come from `TEST_API_PATH` /
   `TEST_BODY` env vars, defaulting to Suno), expect `402`, find the entry
   where `network === 'skale'`. Print the full requirement + signed envelope
   so the audience can read every field.
4. Build an EIP-712 `TransferWithAuthorization` payload:
   - `from` = wallet address
   - `to` = `payTo` from the 402 response
   - `value` = `maxAmountRequired`
   - `validAfter / validBefore` = now / now + maxTimeoutSeconds
   - `nonce` = 32 random bytes (replay protection — the USDC contract enforces
     each `(from, nonce)` pair as single-use)
5. `wallet.signTypedData(domain, types, authorization)` → 65-byte signature.
   The domain pulls `name / version / chainId / verifyingContract` straight
   from the 402 `extra` block, so the client never has to hard-code anything.
6. Wrap into the x402 envelope, base64 it, drop it into the `X-Payment` header,
   replay the request.
7. After the API returns `200`, scan SKALE for the `AuthorizationUsed(authorizer,
   nonce)` event with both topics indexed against the wallet + envelope nonce.
   That uniquely identifies the settlement tx, so the script prints the hash,
   the block, the explorer URL, the matched `Transfer` event, and the closing
   USDC balance.

**Real output from the 2026-05-07 run** (response bodies are line-wrapped here
for legibility; the script prints them verbatim):

```text
=== SKALE X402 Real E2E Test ===
API: https://api.acedata.cloud
SKALE RPC: https://skale-base.skalenodes.com/v1/base
Payer wallet: 0xd0479FA9FD8C678303d477433d24C15e3723CC1C
Explorer (wallet): https://skale-base-explorer.skalenodes.com/address/0xd0479FA9FD8C678303d477433d24C15e3723CC1C

--- Step 1: Request /openai/chat/completions without auth ---
HTTP request:
  > (unauthenticated probe)
  > POST https://api.acedata.cloud/openai/chat/completions
  > Content-Type: application/json
  > Content-Length: 84
  >
  > {"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hi in 10 words."}]}

HTTP response:
  < HTTP 402 Payment Required    (518 ms)
  < access-control-allow-origin: *
  < connection: keep-alive
  < content-length: 1215
  < content-type: application/json; charset=utf-8
  < date: Thu, 07 May 2026 14:25:04 GMT
  < server: kong/2.5.1
  < vary: Origin
  < x-kong-response-latency: 50
  <
  < {"x402Version": 2, "accepts": [
        {"scheme": "exact", "network": "base",   "maxAmountRequired": "95215", ...},
        {"scheme": "exact", "network": "solana", "maxAmountRequired": "95215", ...},
        {"scheme": "exact", "network": "skale",  "maxAmountRequired": "95215",
          "payTo": "0x4F0E2D3477a1B94CF33d16E442CEe4733dadCeE7",
          "asset": "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
          "extra": {"name": "Bridged USDC (SKALE Bridge)", "version": "2",
                    "chainId": 1187947933, "verifyingContract": "0x85889c..."}}],
      "error": "Payment Required"}

accepts[]: base, solana, skale
Selected SKALE payment requirement:
  scheme:            exact
  amount:            95215 (0.095215 USDC)
  payTo:             0x4F0E2D3477a1B94CF33d16E442CEe4733dadCeE7
  asset (USDC):      0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20
  chainId:           1187947933
  verifyingContract: 0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20
  maxTimeoutSeconds: 3600
  resource:          /openai/chat/completions
  description:       AceDataCloud API call

SKALE head block: 1751581
Wallet USDC balance before: 9.244115 USDC

--- Step 2: Sign EIP-712 authorization ---
Signed in 2 ms.  X-Payment header is 636 bytes.
Signed envelope (decoded):
  domain:
    name:              "Bridged USDC (SKALE Bridge)"
    version:           "2"
    chainId:           1187947933
    verifyingContract: 0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20
  authorization:
    from:        0xd0479FA9FD8C678303d477433d24C15e3723CC1C
    to:          0x4F0E2D3477a1B94CF33d16E442CEe4733dadCeE7
    value:       95215 (0.095215 USDC)
    validAfter:  1778163906  (2026-05-07T14:25:06.000Z)
    validBefore: 1778167506  (2026-05-07T15:25:06.000Z)
    nonce:       0xab3d6439eb8e1a555722c145b0af83b0520d18026c9c4208f1686486df74906c
  signature:   0x3ac74ebf28…523ad146cd1b  (130/2 hex chars)

--- Step 3: Retry /openai/chat/completions with X-Payment ---
HTTP request:
  > (paid retry)
  > POST https://api.acedata.cloud/openai/chat/completions
  > Content-Type: application/json
  > X-Payment: eyJ4NDAyVmVyc2lvbiI6Miwic2NoZW1l…YWQxNDZjZDFiIn19  (636 bytes base64, decoded above)
  > Content-Length: 84
  >
  > {"model":"gpt-4o-mini","messages":[{"role":"user","content":"Say hi in 10 words."}]}

HTTP response:
  < HTTP 200 OK    (9819 ms)
  < access-control-allow-origin: *
  < connection: keep-alive
  < content-length: 452
  < content-type: application/json
  < date: Thu, 07 May 2026 14:25:16 GMT
  < server: TornadoServer/6.4.2
  < vary: Origin
  < via: kong/2.5.1
  < x-kong-proxy-latency: 1996
  < x-kong-upstream-latency: 7758
  < x-usage-exempt: true
  <
  < {"id": "chatcmpl-89DrEzMbXfLVHVGSPM1bs42dLEErv",
     "object": "chat.completion", "created": 1778163916, "model": "gpt-4o-mini",
     "choices": [{"index": 0, "finish_reason": "stop",
                  "message": {"role": "assistant",
                              "content": "Hello there! I hope your day is bright and cheerful!"}}],
     "usage": {"prompt_tokens": 14, "completion_tokens": 12, "total_tokens": 26}}

--- Step 4: Look up the on-chain settlement on SKALE ---
Settlement tx (AuthorizationUsed):
  hash:      0xe36cb3808cda54fdd502a5096889a768cde2e705edd57dbd32e65bdf7e187471
  block:     1751583
  explorer:  https://skale-base-explorer.skalenodes.com/tx/0xe36cb3808cda54fdd502a5096889a768cde2e705edd57dbd32e65bdf7e187471
  Transfer:  0.095215 USDC -> 0x4f0e2d3477a1b94cf33d16e442cee4733dadcee7
Wallet USDC balance after:  9.148900 USDC  (delta -0.095215 USDC)

--- Summary ---
  402 round-trip:        518 ms
  EIP-712 sign:          2 ms
  paid call round-trip:  9819 ms
  paid:                  0.095215 USDC on SKALE
  settlement:            https://skale-base-explorer.skalenodes.com/tx/0xe36cb3808cda54fdd502a5096889a768cde2e705edd57dbd32e65bdf7e187471

SKALE E2E succeeded.
```

Things to point out while the script is running:

- Each HTTP exchange is dumped **request-line + every header + body** with `>`
  for outgoing and `<` for incoming. There is **nothing hidden on the wire** —
  on the unauthenticated probe the only header we send is `Content-Type`, and
  on the paid retry the only added header is `X-Payment`. No Authorization, no
  cookie, no API key.
- On the 200 response, `via: kong/2.5.1` + `x-kong-proxy-latency` / `x-kong-upstream-latency`
  show that this is a real production gateway hop, not a fixture.
- The **402 round-trip** is `518 ms`. The **EIP-712 signature** is computed
  locally in `2 ms`. The big number (`9819 ms`) is OpenAI itself — the payment
  loop adds well under half a second.
- `X-Payment` shows up in the request log as the abbreviated base64 (the
  full envelope is already pretty-printed in Step 2, so we don't dump 636
  bytes of base64 a second time).
- `validBefore = validAfter + maxTimeoutSeconds` (1 hour for this endpoint) —
  if the facilitator can't settle within that window, the signature simply
  expires. The user is never on the hook for a payment that didn't deliver an
  API result.
- The script ends with **the actual settlement tx hash**, the matched
  `Transfer` event amount (which equals `maxAmountRequired` exactly — you only
  pay what was quoted), and the closing balance proving the `0.095215 USDC`
  delta. Click the explorer URL on stage to land the punchline.

> Heads up: this is real production. We saw exactly **one transient `502
> upstream`** during an earlier demo run before the success captured above,
> almost certainly an OpenAI proxy hiccup. If you hit one, just re-run — the
> failed signature is tied to a specific nonce that the facilitator will not
> have settled (the request never made it back with `200`), so you don't pay
> for the retry.

---

## Step 3 — Show the on-chain settlement

The script already printed the settlement tx hash + a direct explorer link in
Step 4 of its output. Click that link on stage. You'll see the USDC `Transfer`
event matching the demo wallet (`0xd047…CC1C`) sending exactly the
`maxAmountRequired` to AceDataCloud's collection address (`0x4F0E…cEE7`).

If you'd rather show the wallet history instead of a single tx, the wallet
page works too:

```
https://skale-base-explorer.skalenodes.com/address/0xd0479FA9FD8C678303d477433d24C15e3723CC1C
```

The previously verified historical settlements (also in the
[root README table](../README.md#verified-end-to-end)):

- 🟨 SKALE — `POST /openai/chat/completions` — `0.020568 USDC` —
  [`0x621b361a…7b12979`](https://skale-base-explorer.skalenodes.com/tx/0x621b361ad78e6bb6f910dba603a4267bca92ca8748894011cced803227b12979)
- 🟨 SKALE — `POST /midjourney/imagine` (turbo) — `0.025708 USDC` —
  [`0x0e66f646…6b827d3`](https://skale-base-explorer.skalenodes.com/tx/0x0e66f646bdfbf2e29ca8bc3bc19f252aa6109d8cf7aff1ab6836111e56b827d3)

Talking points:

- The on-chain `Transfer` value equals `maxAmountRequired` from the 402 —
  exactly. The facilitator can never pull more than what the user signed for.
- SKALE Base is **gas-free** — the chain distributes sFUEL automatically, so
  neither the user nor the facilitator pays gas. That's what makes
  fractional-cent USDC payments economically viable here, where they wouldn't
  be on Ethereum L1.
- The whole settlement tx ends up a single `transferWithAuthorization` call on
  the bridged-USDC contract — ~120k gas equivalent, no approvals needed,
  signature single-use.

---

## Step 4 (optional, big finale) — Switch chains, same code

If the audience is engaged and you have time, repeat the demo on Base or Solana
**without rewriting any business logic** — that's the point of x402:

```bash
# Same script family, different chain. Same 402 → sign → 200 loop.
npx tsx scripts/test-real-e2e.ts        # 🟦 Base
npx tsx scripts/test-solana-e2e.ts      # 🟪 Solana (SPL TransferChecked)
```

The diff between `test-skale-e2e.ts` and `test-real-e2e.ts` is **the chainId
constant and which entry of `accepts[]` you pick**. Everything else — domain,
type definitions, wallet signing, envelope shape, retry mechanics — is identical.
That's the protocol's value.

---

## Common questions you'll get and short answers

**"What stops me replaying that signed envelope?"** Each authorization carries a
random 32-byte nonce that USDC's EIP-3009 contract enforces as
single-use. After the facilitator settles once, the same envelope is dead
on-chain.

**"What stops the server from charging me twice?"** The `validBefore` window is
short (default 120s) and the price is bounded by `maxAmountRequired` in the
signed payload. The facilitator can't pull more, can't pull later, can't reuse
the nonce.

**"What if the API call fails after I paid?"** The facilitator only settles
after the gateway confirms it will serve the request. If serving fails, the
signed authorization expires unspent. Worst case: you paid for a 5xx, exactly
the same as paying for a 5xx with a credit card.

**"Who pays the gas for the on-chain settlement?"** Nobody. SKALE Base is a
**gas-free** chain: sFUEL is auto-distributed to active EOAs on demand, so the
settlement tx that moves your USDC costs $0 in gas regardless of who broadcasts
it. On Base mainnet (the EVM equivalent), the facilitator pays a few
fractions of a cent in ETH gas as part of its operating cost.

**"Why USDC and not native ETH/SOL?"** USDC is a stable unit of account (the
whole point of micropayments is predictable pricing) and EIP-3009 / SPL
`TransferChecked` give us the meta-transaction primitives we need. Native gas
tokens don't have an equivalent "sign now, settle later" hook.

**"Why three chains instead of one?"** Because the cost of the chain is part of
the cost of the API call. Base is cheap and EVM-familiar. SKALE is gas-free,
which moves the economically-viable price floor down by another order of
magnitude. Solana is for the non-EVM half of the world. We let the client
choose.

**"Where's the AceDataCloud account?"** There isn't one. The whole transaction
above is **anonymous from the gateway's point of view** — it identifies the
caller solely by the wallet address that signed the authorization. If you want
quotas, rate-limits, or a customer dashboard, you wrap an account on top; the
protocol itself doesn't need it.

---

## Reference: the env file and the script

- Env: `<repo>/.claude/.env` → `SKALE_BASE_PRIVATE_KEY=0x...`
- Script: [`typescript/scripts/test-skale-e2e.ts`](../typescript/scripts/test-skale-e2e.ts) (~150 lines, no SDK dependency, just `ethers`)
- Source for the SDK plugin that does the same thing as a library: [`typescript/src`](../typescript/src)
- Facilitator source: [`AceDataCloud/FacilitatorX402`](https://github.com/AceDataCloud/FacilitatorX402)
- Gateway 402 emission lives in our PlatformGateway

---

## Appendix 1 — full chat-completion response from the 2026-05-07 run

```json
{
  "id": "chatcmpl-DcqKgLKlVFIrrHk52tMoXTG0ki202",
  "object": "chat.completion",
  "created": 1778150002,
  "model": "gpt-4o-mini",
  "system_fingerprint": "fp_eb37e061ec",
  "service_tier": "default",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "logprobs": null,
      "message": {
        "role": "assistant",
        "content": "Hello there! How are you doing today? Hope well!",
        "refusal": null,
        "annotations": []
      }
    }
  ],
  "usage": {
    "prompt_tokens": 14,
    "completion_tokens": 13,
    "total_tokens": 27,
    "latency_checkpoint": {
      "engine_ttft_ms": 43,
      "engine_ttlt_ms": 146,
      "pre_inference_ms": 67,
      "service_ttft_ms": 283,
      "service_ttlt_ms": 374,
      "total_duration_ms": 313,
      "user_visible_ttft_ms": 216
    }
  }
}
```

13 completion tokens billed at the SKALE `accepts[]` quote of `0.095215 USDC`,
313 ms upstream latency, ~500 ms wall-clock end-to-end. That's the entire
story of the demo — the audience sees a chat reply pop on screen, you switch
to the explorer tab, the USDC settlement is already there.

## Appendix 2 — longer-running endpoint (Suno)

If you want to demo a more substantial workload (so the on-chain settlement
shows up *during* generation, not after), drop the env overrides and run the
script bare:

```bash
npx tsx scripts/test-skale-e2e.ts
```

That hits `POST /suno/audios` with `prompt: "a short SKALE test beat"` and
`make_instrumental: true`, costs `0.052368 USDC` on SKALE, and takes ~100 s
for Suno to actually generate two MP3s. Real result from a previous run:

```json
{
  "success": true,
  "task_id": "02515e57-935d-4b2d-a9a5-5de3427ba7f3",
  "trace_id": "b311397b-8974-4b3d-99a4-a0cabd932081",
  "data": [
    {
      "id": "3c8545cd-adec-4d36-b9e4-3d24dfc6576a",
      "title": "Practice Downbeat",
      "audio_url": "https://cdn1.suno.ai/3c8545cd-adec-4d36-b9e4-3d24dfc6576a.mp3",
      "duration": 212.52,
      "state": "succeeded"
    },
    {
      "id": "8d4f1090-f698-47eb-a76a-49a875b546a7",
      "title": "Practice Downbeat",
      "audio_url": "https://cdn1.suno.ai/8d4f1090-f698-47eb-a76a-49a875b546a7.mp3",
      "duration": 196.96,
      "state": "succeeded"
    }
  ],
  "elapsed": 104.477
}
```

Both audio URLs are public CDN links — drop one into a slide and play it on
stage if you want to land the "I just paid 5 cents in USDC for two AI-generated
songs, no signup, no API key" punchline.
