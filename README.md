# @acedatacloud/x402-client

X402 payment protocol client for AceDataCloud APIs. Automatically handles `402 Payment Required` → wallet signing → retry.

Currently verified against AceDataCloud's `openai/chat/completions` path with `base`, `solana`, and `skale`.

## Install

```bash
npm install @acedatacloud/x402-client
# Solana support (optional):
npm install @solana/web3.js
```

## Usage

### Solana

```typescript
import { createX402Client } from '@acedatacloud/x402-client';

const client = createX402Client({
  baseURL: 'https://api.acedata.cloud',
  network: 'solana',
  solanaWallet: phantomWallet, // wallet-fee-payer mode: must support signAndSendTransaction
});

// Automatically handles 402 → sign USDC transfer → retry
const result = await client.post('/openai/chat/completions', {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in 3 words' }],
  max_tokens: 10,
});

console.log(result.data);    // API response
console.log(result.paid);    // true if 402→payment→retry occurred
```

### Base / SKALE (EVM)

```typescript
import { createX402Client } from '@acedatacloud/x402-client';

const client = createX402Client({
  baseURL: 'https://api.acedata.cloud',
  network: 'base', // or 'skale'
  evmProvider: window.ethereum,         // any EIP-1193 provider
  evmAddress: '0xYourAddress...',
});

const result = await client.post('/openai/chat/completions', {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hi in 3 words' }],
  max_tokens: 10,
});
```

### Low-level signing

```typescript
import { signSolanaPayment, signEVMPayment } from '@acedatacloud/x402-client';

// Sign without the auto-retry wrapper
const envelope = await signSolanaPayment(paymentRequirement, wallet);
const header = btoa(JSON.stringify(envelope));
// Use header in your own HTTP client
```

## How it works

1. Client sends API request (no Bearer token)
2. Server returns `402` with `{ accepts: [{ network, maxAmountRequired, payTo, asset, ... }] }`
3. Client picks the requirement matching the configured `network`
4. **Solana**: builds SPL `TransferChecked` tx → wallet `signAndSendTransaction` → encodes `{ signature }`
5. **EVM**: builds EIP-712 `TransferWithAuthorization` → wallet `eth_signTypedData_v4` → encodes `{ authorization, signature }`
6. Client retries the original request with `X-Payment: <base64 encoded envelope>`
7. Server verifies + settles payment → returns API result
