/**
 * Protocol constants and validators. No dependencies.
 */
import type { ExactEvmPayload, PaymentPayloadV1, PaymentPayloadV2, PaymentRequirementsV1, PaymentRequirementsV2 } from "./types.js";

export const HEADERS = {
  v1: { payment: "x-payment", response: "x-payment-response" },
  v2: { required: "payment-required", signature: "payment-signature", response: "payment-response" },
} as const;

/** Canonical USDC contract per network. Source: Circle developer docs. */
export const USDC: Record<string, string> = {
  // v1 slugs
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  "avalanche-fuji": "0x5425890298aed601595a70AB815c96711a31Bc65",
  // v2 CAIP-2
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "eip155:43114": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  "eip155:43113": "0x5425890298aed601595a70AB815c96711a31Bc65",
  "eip155:1": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "eip155:137": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

export const KNOWN_V1_NETWORKS = new Set([
  "base", "base-sepolia", "avalanche", "avalanche-fuji", "solana", "solana-devnet", "polygon", "polygon-amoy", "sei", "sei-testnet", "iotex",
]);

export const CAIP2_RE = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const DEC_INT_RE = /^(0|[1-9][0-9]*)$/;
export const HEX_BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
export const HEX_SIG_RE = /^0x[0-9a-fA-F]{130}$/; // 65-byte ECDSA

export function isEvmNetwork(network: string): boolean {
  return network.startsWith("eip155:") || (KNOWN_V1_NETWORKS.has(network) && !network.startsWith("solana"));
}
export function isSvmNetwork(network: string): boolean {
  return network.startsWith("solana");
}

export function b64encode(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function b64decode<T = unknown>(s: string): { ok: true; value: T } | { ok: false; error: string } {
  try {
    const raw = Buffer.from(s.trim(), "base64").toString("utf8");
    if (!raw) return { ok: false, error: "empty after base64 decode" };
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (e) {
    return { ok: false, error: `not base64 JSON: ${(e as Error).message}` };
  }
}

/** A well-formed but unsigned/invalid exact-EVM payload. Servers MUST reject it. */
export function fakeExactEvmPayload(req: { payTo: string; amount: string }): ExactEvmPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    signature: "0x" + "11".repeat(65),
    authorization: {
      from: "0x000000000000000000000000000000000000dEaD",
      to: req.payTo,
      value: req.amount,
      validAfter: String(now - 60),
      validBefore: String(now + 300),
      nonce: "0x" + "ab".repeat(32),
    },
  };
}

export function buildPayloadV1(req: PaymentRequirementsV1): PaymentPayloadV1 {
  return {
    x402Version: 1,
    scheme: req.scheme,
    network: req.network,
    payload: fakeExactEvmPayload({ payTo: req.payTo, amount: req.maxAmountRequired }),
  };
}

export function buildPayloadV2(req: PaymentRequirementsV2, resourceUrl: string): PaymentPayloadV2 {
  return {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepted: req,
    payload: fakeExactEvmPayload({ payTo: req.payTo, amount: req.amount }),
  };
}

export function amountOf(req: PaymentRequirementsV1 | PaymentRequirementsV2): string | undefined {
  return "amount" in req ? req.amount : (req as PaymentRequirementsV1).maxAmountRequired;
}

export type Field = { name: string; type: "string" | "number" | "object" | "array"; required: boolean };

export const REQUIREMENT_FIELDS: Record<1 | 2, Field[]> = {
  1: [
    { name: "scheme", type: "string", required: true },
    { name: "network", type: "string", required: true },
    { name: "maxAmountRequired", type: "string", required: true },
    { name: "asset", type: "string", required: true },
    { name: "payTo", type: "string", required: true },
    { name: "resource", type: "string", required: true },
    { name: "description", type: "string", required: true },
    { name: "mimeType", type: "string", required: false },
    { name: "maxTimeoutSeconds", type: "number", required: true },
    { name: "extra", type: "object", required: false },
  ],
  2: [
    { name: "scheme", type: "string", required: true },
    { name: "network", type: "string", required: true },
    { name: "amount", type: "string", required: true },
    { name: "asset", type: "string", required: true },
    { name: "payTo", type: "string", required: true },
    { name: "maxTimeoutSeconds", type: "number", required: true },
    { name: "extra", type: "object", required: false },
  ],
};

export function typeOf(v: unknown): Field["type"] | "other" {
  if (Array.isArray(v)) return "array";
  if (v === null) return "other";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "object") return t;
  return "other";
}

/** Returns a list of schema violations for an object against a field list. */
export function validateFields(obj: Record<string, unknown>, fields: Field[]): string[] {
  const problems: string[] = [];
  for (const f of fields) {
    const v = obj[f.name];
    if (v === undefined) {
      if (f.required) problems.push(`missing required "${f.name}"`);
      continue;
    }
    const t = typeOf(v);
    if (t !== f.type) problems.push(`"${f.name}" should be ${f.type}, got ${t}`);
  }
  return problems;
}
