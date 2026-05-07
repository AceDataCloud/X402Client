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
| 3 | Replay the same request with `X-Payment` | `200 OK` + the actual API result (Suno tracks, GPT completion, Midjourney image, ...) |
| 4 | Open the SKALE block explorer | The USDC transfer from the demo wallet to AceDataCloud, settled by our facilitator — gas free |

The whole thing fits on one slide: **HTTP-native per-request micropayments, no
account, no Bearer, no session.**

---

## What the audience needs to understand first (30 seconds)

Show the README diagram or just say it out loud:

```
┌─────────────────────────┐
│  Client (you, curl,     │
│   SDK, agent, ...)      │
└────────────┬────────────┘
             │ 1. POST /suno/audios   (no auth)
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
             │ 3. POST /suno/audios
             │    X-Payment: <base64 envelope>
             ▼
┌─────────────────────────┐      ┌──────────────────────────┐
│  api.acedata.cloud      │ ───▶ │ facilitator.acedata.cloud│
└────────────┬────────────┘      │  verifies + settles tx    │
             │ 4. 200 OK         │  on SKALE (gas free)      │
             ▼                   └────────────┬─────────────┘
        ┌─────────┐                           │
        │ Suno    │                           ▼
        │ tracks  │                ┌──────────────────────┐
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
curl -s -i -X POST https://api.acedata.cloud/suno/audios \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a short SKALE test beat","make_instrumental":true}' \
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
      "maxAmountRequired": "52368",
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

- `maxAmountRequired` is in **base units** (USDC has 6 decimals → `52368` =
  `0.052368 USDC` ≈ $0.05).
- The same call returns **three networks**. The client (or the user) picks one.
  SKALE is what we're demoing; Base / Solana are the same dance with a different
  signing scheme.
- There is **no API key, no Authorization header, no session cookie** anywhere
  on the wire. The only "identity" the request carries on retry is the wallet
  signature.

---

## Step 2 — Run the SKALE end-to-end script

This is the headline moment. One command does steps 1–3 of the diagram in one
shot, with verbose logging so the audience sees each phase:

```bash
cd X402Client/typescript
npx tsx scripts/test-skale-e2e.ts
```

What the script does (the same logic any SDK / agent will do, hand-rolled here
so you can read every line in `scripts/test-skale-e2e.ts`):

1. Load `SKALE_BASE_PRIVATE_KEY` from `.claude/.env`, instantiate an
   `ethers.Wallet`.
2. Send the same `POST /suno/audios` from Step 1, expect `402`, find the entry
   where `network === 'skale'`.
3. Build an EIP-712 `TransferWithAuthorization` payload:
   - `from` = wallet address
   - `to` = `payTo` from the 402 response
   - `value` = `maxAmountRequired`
   - `validAfter / validBefore` = now / now + maxTimeoutSeconds
   - `nonce` = 32 random bytes (replay protection — facilitator will reject any
     duplicate within the validity window)
4. `wallet.signTypedData(domain, types, authorization)` → 65-byte signature.
   The domain pulls `name / version / chainId / verifyingContract` straight
   from the 402 `extra` block, so the client never has to hard-code anything.
5. Wrap into the x402 envelope, base64 it, drop it into the `X-Payment` header,
   replay the request.

**Real output from the 2026-05-07 run** (trimmed, full Suno payload in the
appendix):

```text
=== SKALE X402 Real E2E Test ===
API: https://api.acedata.cloud
Payer wallet: 0xd0479FA9FD8C678303d477433d24C15e3723CC1C

--- Step 1: Request /suno/audios without auth ---
Status: 402
Found skale payment requirement:
  amount: 52368 (0.052368 units)
  payTo: 0x4F0E2D3477a1B94CF33d16E442CEe4733dadCeE7
  asset: 0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20
  chainId: 1187947933
  verifyingContract: 0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20

--- Step 2: Sign EIP-712 authorization ---
Signed payment envelope.
  header length: 636

--- Step 3: Retry /suno/audios with X-Payment ---
Status: 200
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
      ...
    },
    {
      "id": "8d4f1090-f698-47eb-a76a-49a875b546a7",
      "title": "Practice Downbeat",
      "audio_url": "https://cdn1.suno.ai/8d4f1090-f698-47eb-a76a-49a875b546a7.mp3",
      "duration": 196.96,
      ...
    }
  ],
  "started_at": "2026-05-07T05:43:23.139Z",
  "finished_at": "2026-05-07T05:45:07.616Z",
  "elapsed": 104.477
}

SKALE E2E succeeded.
```

Things to point out while the script is running (it takes ~100 seconds for Suno
to actually finish the song — perfect timing for narration):

- The **402 → sign → 200** loop completes in under 2 seconds. The remaining
  ~100 seconds is Suno generating two music tracks, not the payment overhead.
- `header length: 636` — the entire payment proof is **a 636-byte HTTP header**.
  No new endpoint, no callback, no webhook.
- `validBefore = validAfter + maxTimeoutSeconds` — if the facilitator can't
  settle within that window, the signature simply expires. The user is never on
  the hook for a payment that didn't deliver an API result.

---

## Step 3 — Show the on-chain settlement

Open SKALE Europa Hub explorer:

```
https://elated-tan-skat.explorer.mainnet.skalenodes.com/address/0xd0479FA9FD8C678303d477433d24C15e3723CC1C
```

You'll see a fresh USDC `Transfer` event from `0xd047…CC1C` (the demo wallet) to
`0x4F0E…cEE7` (AceDataCloud's collection address) for the exact `0.052368 USDC`
that was quoted in the 402.

The previously verified historical settlement (also in the
[root README table](../README.md#verified-end-to-end)):

- 🟨 SKALE — `POST /openai/chat/completions` — `0.020568 USDC` —
  [`0x621b361a…7b12979`](https://elated-tan-skat.explorer.mainnet.skalenodes.com/tx/0x621b361ad78e6bb6f910dba603a4267bca92ca8748894011cced803227b12979)
- 🟨 SKALE — `POST /midjourney/imagine` (turbo) — `0.025708 USDC` —
  [`0x0e66f646…6b827d3`](https://elated-tan-skat.explorer.mainnet.skalenodes.com/tx/0x0e66f646bdfbf2e29ca8bc3bc19f252aa6109d8cf7aff1ab6836111e56b827d3)

Talking points:

- The transaction's `from` is **the facilitator**, not the user wallet — that's
  why the user never holds gas. The facilitator is allowed to move USDC out of
  the user's wallet because it presents the EIP-3009 signature.
- On SKALE, the facilitator's gas cost is also $0 (chain is gas-free), so the
  unit economics for very-small payments (sub-cent, fractional-cent) actually
  work — unlike Ethereum L1 where a $0.05 payment makes no sense.

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

## Appendix — full Suno response from the 2026-05-07 run

```json
{
  "success": true,
  "task_id": "02515e57-935d-4b2d-a9a5-5de3427ba7f3",
  "trace_id": "b311397b-8974-4b3d-99a4-a0cabd932081",
  "data": [
    {
      "id": "3c8545cd-adec-4d36-b9e4-3d24dfc6576a",
      "title": "Practice Downbeat",
      "image_url": "https://cdn2.suno.ai/image_3c8545cd-adec-4d36-b9e4-3d24dfc6576a.jpeg",
      "image_large_url": "https://cdn2.suno.ai/image_large_3c8545cd-adec-4d36-b9e4-3d24dfc6576a.jpeg",
      "lyric": "[Instrumental]",
      "audio_url": "https://cdn1.suno.ai/3c8545cd-adec-4d36-b9e4-3d24dfc6576a.mp3",
      "video_url": "",
      "created_at": "2026-05-07T05:43:23.790Z",
      "model": "chirp-v4",
      "state": "succeeded",
      "prompt": "a short SKALE test beat",
      "duration": 212.52
    },
    {
      "id": "8d4f1090-f698-47eb-a76a-49a875b546a7",
      "title": "Practice Downbeat",
      "image_url": "https://cdn2.suno.ai/image_8d4f1090-f698-47eb-a76a-49a875b546a7.jpeg",
      "image_large_url": "https://cdn2.suno.ai/image_large_8d4f1090-f698-47eb-a76a-49a875b546a7.jpeg",
      "lyric": "[Instrumental]",
      "audio_url": "https://cdn1.suno.ai/8d4f1090-f698-47eb-a76a-49a875b546a7.mp3",
      "video_url": "",
      "created_at": "2026-05-07T05:43:23.790Z",
      "model": "chirp-v4",
      "state": "succeeded",
      "prompt": "a short SKALE test beat",
      "duration": 196.96
    }
  ],
  "started_at": "2026-05-07T05:43:23.139Z",
  "finished_at": "2026-05-07T05:45:07.616Z",
  "elapsed": 104.477
}
```

Both audio URLs are public CDN links — drop one into a slide and play it on
stage if you want to land the "I just paid 5 cents in USDC for two AI-generated
songs, no signup, no API key" punchline.
