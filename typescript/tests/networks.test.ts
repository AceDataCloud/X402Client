import { expect, it } from "vitest";
import { Wallet, verifyTypedData } from "ethers";
import { createX402PaymentHandler } from "../src/sdkAdapter.js";
import { signEVMPayment } from "../src/evm.js";
import type { EVMProvider, PaymentRequirement } from "../src/types.js";

const networks = [
  ["arbitrum", 42161, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
  ["polygon", 137, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"],
  ["optimism", 10, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"],
  ["avalanche", 43114, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"],
] as const;

for (const [alias, chainId, asset] of networks) {
  it(`${alias} signs an interoperable exact payment on the selected chain`, async () => {
    const wallet = Wallet.createRandom();
    let typed: any;
    const provider: EVMProvider = {
      async request({ method, params }) {
        expect(method).toBe("eth_signTypedData_v4");
        typed = JSON.parse(String(params?.[1]));
        const { EIP712Domain: _, ...types } = typed.types;
        return wallet.signTypedData(typed.domain, types, typed.message);
      },
    };
    const requirement: PaymentRequirement = {
      scheme: "exact",
      network: `eip155:${chainId}`,
      asset,
      amount: "1250000",
      maxTimeoutSeconds: 60,
      payTo: "0x" + "1".repeat(40),
      extra: { name: "USD Coin", version: "2" },
    };
    for (const network of [alias, requirement.network]) {
      const handler = createX402PaymentHandler({
        network: network as any,
        evmProvider: provider,
        evmAddress: wallet.address,
      });
      const result = await handler({
        url: "https://api.invalid/paid",
        method: "POST",
        accepts: [requirement],
      });
      const envelope = JSON.parse(
        Buffer.from(result.headers["PAYMENT-SIGNATURE"], "base64").toString()
      );
      expect(envelope.accepted).toEqual(requirement);
      expect(typed.domain.chainId).toBe(chainId);
      expect(typed.domain.verifyingContract).toBe(asset);
      const { EIP712Domain: _, ...types } = typed.types;
      expect(
        verifyTypedData(
          typed.domain,
          types,
          typed.message,
          envelope.payload.signature
        )
      ).toBe(wallet.address);
      expect(
        verifyTypedData(
          { ...typed.domain, chainId: 8453 },
          types,
          typed.message,
          envelope.payload.signature
        )
      ).not.toBe(wallet.address);
    }
    await expect(
      signEVMPayment(
        { ...requirement, extra: { chainId: 8453 } },
        provider,
        wallet.address
      )
    ).rejects.toThrow("disagree");
  });
}
