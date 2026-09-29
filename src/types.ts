/**
 * Shared types for x402-conform.
 *
 * Field names follow the x402 v1 and v2 specifications:
 *   https://github.com/coinbase/x402/tree/main/specs
 */

export type Severity = "error" | "warn" | "info";
export type Status = "pass" | "fail" | "warn" | "skip";

export interface CheckResult {
  id: string;
  title: string;
  status: Status;
  severity: Severity;
  /** One-line explanation of what was observed. */
  detail: string;
  /** Spec reference or rationale. */
  ref?: string;
  durationMs?: number;
}

export interface Report {
  target: string;
  kind: "server" | "facilitator";
  startedAt: string;
  finishedAt: string;
  x402Version?: 1 | 2;
  results: CheckResult[];
  summary: { pass: number; fail: number; warn: number; skip: number };
}

/* ---------- x402 v1 ---------- */

export interface PaymentRequirementsV1 {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType?: string;
  outputSchema?: unknown;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequiredV1 {
  x402Version: 1;
  error?: string;
  accepts: PaymentRequirementsV1[];
}

export interface PaymentPayloadV1 {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: unknown;
}

/* ---------- x402 v2 ---------- */

export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequirementsV2 {
  scheme: string;
  network: string; // CAIP-2, e.g. "eip155:8453"
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirementsV2[];
  extensions?: Record<string, unknown>;
}

export interface PaymentPayloadV2 {
  x402Version: 2;
  resource?: ResourceInfo;
  accepted: PaymentRequirementsV2;
  payload: unknown;
  extensions?: Record<string, unknown>;
}

/* ---------- Exact scheme (EVM, EIP-3009) ---------- */

export interface ExactEvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface ExactEvmPayload {
  signature: string;
  authorization: ExactEvmAuthorization;
}

/* ---------- Facilitator ---------- */

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
}

export interface SupportedResponse {
  kinds: SupportedKind[];
  extensions?: unknown[];
  signers?: Record<string, unknown>;
}

export interface ServerCheckOptions {
  url: string;
  /** Force a protocol version; otherwise auto-detected. */
  version?: 1 | 2;
  /** Number of timed requests for latency sampling. */
  samples?: number;
  timeoutMs?: number;
  /** HTTP method used for the protected resource. */
  method?: string;
}

export interface FacilitatorCheckOptions {
  url: string;
  timeoutMs?: number;
  /** Optional bearer/JWT for facilitators that require auth (e.g. CDP). */
  authorization?: string;
}
