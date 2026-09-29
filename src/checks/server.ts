/**
 * Conformance checks for an x402 resource server (the thing that returns 402).
 */
import {
  BASE58_RE, CAIP2_RE, DEC_INT_RE, EVM_ADDRESS_RE, HEADERS, KNOWN_V1_NETWORKS, REQUIREMENT_FIELDS, USDC,
  amountOf, b64decode, b64encode, buildPayloadV1, buildPayloadV2, isEvmNetwork, isSvmNetwork, validateFields,
} from "../protocol.js";
import { Runner, http, percentile } from "../runner.js";
import type { PaymentRequiredV1, PaymentRequiredV2, PaymentRequirementsV1, PaymentRequirementsV2, Report, ServerCheckOptions } from "../types.js";

const SPEC_V1 = "specs/x402-specification-v1.md";
const SPEC_V2 = "specs/x402-specification-v2.md";

type Required = PaymentRequiredV1 | PaymentRequiredV2;

export async function checkServer(opts: ServerCheckOptions): Promise<Report> {
  const startedAt = new Date().toISOString();
  const r = new Runner(opts.url, "server");
  const method = opts.method ?? "GET";
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // S01: unpaid request -> 402
  const first = await http(opts.url, { method, timeoutMs });
  if (first.error || first.status === 0) {
    r.fail("S01", "Unpaid request returns 402", `request failed: ${first.error ?? "no response"}`);
    return r.report(startedAt);
  }
  r.expect("S01", "Unpaid request returns 402", first.status === 402,
    `HTTP ${first.status}`, `expected 402, got HTTP ${first.status}`, "RFC 9110 §15.5.3; x402 flow step 2");
  if (first.status !== 402) {
    if (first.status >= 200 && first.status < 300) {
      r.fail("S14", "Never serve protected content without payment", `resource returned HTTP ${first.status} with no payment attached`);
    }
    return r.report(startedAt);
  }

  // S02: locate PaymentRequired (v2 header, or v1 body). Detect version.
  let version: 1 | 2 | undefined = opts.version;
  let required: Required | undefined;
  const hdr = first.headers.get(HEADERS.v2.required);
  if (hdr) {
    const dec = b64decode<PaymentRequiredV2>(hdr);
    if (dec.ok) { required = dec.value; version ??= 2; r.pass("S02", "PaymentRequired is discoverable", `found base64 JSON in ${HEADERS.v2.required.toUpperCase()} header`, SPEC_V2); }
    else r.fail("S02", "PaymentRequired is discoverable", `${HEADERS.v2.required.toUpperCase()} header present but ${dec.error}`, SPEC_V2);
  }
  if (!required && first.json && typeof first.json === "object") {
    required = first.json as Required;
    version ??= detectVersionFromShape(required);
    r.pass("S02", "PaymentRequired is discoverable", `found JSON in 402 response body${version === 2 ? " (v2 without header; header is recommended)" : ""}`, version === 2 ? SPEC_V2 : SPEC_V1);
  }
  if (!required) {
    r.fail("S02", "PaymentRequired is discoverable", `no ${HEADERS.v2.required.toUpperCase()} header and body is not JSON (content-type: ${first.headers.get("content-type") ?? "none"})`);
    return r.report(startedAt);
  }
  version ??= 1;

  // S03: x402Version
  const v = (required as { x402Version?: unknown }).x402Version;
  r.expect("S03", "x402Version is declared and consistent", v === version,
    `x402Version=${String(v)} matches transport (v${version})`, `x402Version=${String(v)}, expected ${version} for the transport used`, version === 2 ? SPEC_V2 : SPEC_V1);

  // S16: content-type on 402
  const ct = first.headers.get("content-type") ?? "";
  r.expect("S16", "402 response has JSON content-type", ct.includes("application/json"),
    `content-type: ${ct}`, `content-type is "${ct || "missing"}"; clients that parse the body expect application/json`, undefined, "warn");

  // S04: accepts array
  const accepts = (required as { accepts?: unknown }).accepts;
  const acceptsOk = Array.isArray(accepts) && accepts.length > 0;
  r.expect("S04", "accepts is a non-empty array", acceptsOk,
    `${(accepts as unknown[]).length} payment option(s)`, `accepts is ${Array.isArray(accepts) ? "empty" : typeof accepts}`);
  if (!acceptsOk) return r.report(startedAt, version);

  // v2: resource info
  if (version === 2) {
    const res = (required as PaymentRequiredV2).resource;
    const resOk = !!res && typeof res === "object" && typeof res.url === "string";
    r.expect("S11", "resource identifies the protected URL", resOk && sameResource(res.url, opts.url),
      `resource.url=${res?.url}`, resOk ? `resource.url="${res.url}" does not match requested "${opts.url}"` : "resource.url missing or not a string", SPEC_V2, resOk ? "warn" : "error");
  }

  // Per-requirement checks
  const reqs = accepts as Array<PaymentRequirementsV1 | PaymentRequirementsV2>;
  const schemaProblems: string[] = [];
  const amountProblems: string[] = [];
  const networkProblems: string[] = [];
  const payToProblems: string[] = [];
  const assetProblems: string[] = [];
  const assetWarnings: string[] = [];
  const timeoutProblems: string[] = [];
  const timeoutWarnings: string[] = [];
  const extraProblems: string[] = [];
  const resourceProblems: string[] = [];

  reqs.forEach((req, i) => {
    const tag = `accepts[${i}]`;
    const p = validateFields(req as unknown as Record<string, unknown>, REQUIREMENT_FIELDS[version!]);
    if (p.length) schemaProblems.push(`${tag}: ${p.join("; ")}`);

    const amt = amountOf(req);
    if (typeof amt === "string") {
      if (!DEC_INT_RE.test(amt)) amountProblems.push(`${tag}: "${amt}" is not a decimal integer string (atomic units)`);
      else if (amt === "0") amountProblems.push(`${tag}: amount is 0`);
    }

    const net = req.network;
    if (typeof net === "string") {
      if (version === 2 && !CAIP2_RE.test(net)) networkProblems.push(`${tag}: "${net}" is not CAIP-2 (e.g. eip155:8453)`);
      if (version === 1 && !KNOWN_V1_NETWORKS.has(net)) networkProblems.push(`${tag}: "${net}" is not a known v1 network slug`);
      if (version === 1 && CAIP2_RE.test(net)) networkProblems.push(`${tag}: CAIP-2 identifier used in a v1 response`);
    }

    const payTo = req.payTo;
    if (typeof payTo === "string" && typeof net === "string") {
      if (isEvmNetwork(net) && !EVM_ADDRESS_RE.test(payTo)) payToProblems.push(`${tag}: payTo "${payTo}" is not a 20-byte hex address`);
      if (isSvmNetwork(net) && !BASE58_RE.test(payTo)) payToProblems.push(`${tag}: payTo "${payTo}" is not base58`);
    }

    const asset = req.asset;
    if (typeof asset === "string" && typeof net === "string") {
      if (isEvmNetwork(net) && !EVM_ADDRESS_RE.test(asset)) assetProblems.push(`${tag}: asset "${asset}" is not a 20-byte hex address`);
      const canon = USDC[net];
      const name = String((req.extra as Record<string, unknown> | undefined)?.name ?? "");
      if (canon && /usdc/i.test(name) && asset.toLowerCase() !== canon.toLowerCase()) {
        assetWarnings.push(`${tag}: extra.name says USDC but asset ${asset} ≠ canonical USDC on ${net} (${canon})`);
      }
    }

    const to = req.maxTimeoutSeconds;
    if (typeof to === "number") {
      if (!Number.isInteger(to) || to <= 0) timeoutProblems.push(`${tag}: maxTimeoutSeconds=${to} must be a positive integer`);
      else if (to > 3600) timeoutWarnings.push(`${tag}: maxTimeoutSeconds=${to} (>1h) widens the replay/expiry window`);
    }

    if (req.scheme === "exact" && typeof net === "string" && isEvmNetwork(net)) {
      const ex = (req.extra ?? {}) as Record<string, unknown>;
      if (typeof ex.name !== "string" || typeof ex.version !== "string") {
        extraProblems.push(`${tag}: exact/EVM requires extra.name and extra.version (EIP-712 domain) for clients to sign`);
      }
    }

    if (version === 1) {
      const res = (req as PaymentRequirementsV1).resource;
      if (typeof res === "string" && !sameResource(res, opts.url)) resourceProblems.push(`${tag}: resource="${res}" ≠ requested URL`);
    }
  });

  r.expect("S05", "PaymentRequirements match the spec schema", schemaProblems.length === 0, "all required fields present with correct types", schemaProblems.join(" | "), version === 2 ? SPEC_V2 : SPEC_V1);
  r.expect("S06", "Amounts are positive atomic-unit integer strings", amountProblems.length === 0, "ok", amountProblems.join(" | "));
  r.expect("S07", "Network identifiers use the correct format", networkProblems.length === 0, version === 2 ? "CAIP-2" : "v1 slugs", networkProblems.join(" | "));
  r.expect("S08", "payTo is a valid address for its network", payToProblems.length === 0, "ok", payToProblems.join(" | "));
  r.expect("S09", "asset is a valid token address", assetProblems.length === 0, "ok", assetProblems.join(" | "));
  if (assetWarnings.length) r.warn("S09b", "asset matches canonical USDC for the network", assetWarnings.join(" | "), "circle.com/multi-chain-usdc");
  r.expect("S10", "maxTimeoutSeconds is a positive integer", timeoutProblems.length === 0, "ok", timeoutProblems.join(" | "));
  if (timeoutWarnings.length) r.warn("S10b", "maxTimeoutSeconds is reasonably bounded", timeoutWarnings.join(" | "));
  r.expect("S17", "exact/EVM options carry EIP-712 domain in extra", extraProblems.length === 0, "extra.name/extra.version present", extraProblems.join(" | "), "specs/schemes/exact/scheme_exact_evm.md");
  if (version === 1) r.expect("S11", "resource identifies the protected URL", resourceProblems.length === 0, "ok", resourceProblems.join(" | "), SPEC_V1, "warn");

  // S12: garbage payment header must not 500
  const payHeader = version === 2 ? HEADERS.v2.signature : HEADERS.v1.payment;
  const garbage = await http(opts.url, { method, timeoutMs, headers: { [payHeader]: "!!not-base64!!" } });
  r.expect("S12", "Malformed payment header is rejected cleanly (4xx, not 5xx)", garbage.status >= 400 && garbage.status < 500,
    `HTTP ${garbage.status}`, `HTTP ${garbage.status} for a garbage ${payHeader.toUpperCase()} header`, "robustness: never crash on client input");

  // S13: wrong x402Version in an otherwise valid payload
  const req0 = reqs[0];
  const good = version === 2 ? buildPayloadV2(req0 as PaymentRequirementsV2, opts.url) : buildPayloadV1(req0 as PaymentRequirementsV1);
  const wrongVersion = { ...good, x402Version: 99 };
  const wv = await http(opts.url, { method, timeoutMs, headers: { [payHeader]: b64encode(wrongVersion) } });
  r.expect("S13", "Unsupported x402Version in payload is rejected (4xx)", wv.status >= 400 && wv.status < 500,
    `HTTP ${wv.status}`, `HTTP ${wv.status} for x402Version=99`);

  // S14: well-formed but unsigned payload must NOT unlock the resource
  const fake = await http(opts.url, { method, timeoutMs, headers: { [payHeader]: b64encode(good) } });
  const leaked = fake.status >= 200 && fake.status < 300;
  r.expect("S14", "Never serve protected content without payment", !leaked,
    `HTTP ${fake.status} for a forged signature`, `HTTP ${fake.status}: resource served for a payload with a forged signature — payment is not being verified`, "security");
  if (!leaked) {
    // S14b: rejection should still be a 402 (re-prompt) with PaymentRequired, not a bare 400/401
    const re402 = fake.status === 402;
    r.expect("S14b", "Rejected payment re-issues 402 with PaymentRequired", re402 && (!!fake.headers.get(HEADERS.v2.required) || !!fake.json),
      "402 with requirements", `HTTP ${fake.status}${re402 ? " without PaymentRequired" : ""}; clients cannot retry without requirements`, undefined, "warn");
  }

  // S15: latency
  const n = Math.max(1, opts.samples ?? 5);
  const times: number[] = [first.ms];
  for (let i = 1; i < n; i++) {
    const s = await http(opts.url, { method, timeoutMs });
    if (!s.error) times.push(s.ms);
  }
  const p50 = percentile(times, 50), p95 = percentile(times, 95);
  r.expect("S15", "402 challenge latency", p95 < 2000, `p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms (n=${times.length})`,
    `p95=${p95.toFixed(0)}ms over ${times.length} samples; agents time out on slow challenges`, undefined, "warn");

  return r.report(startedAt, version);
}

/** Infer the protocol version from the body's shape, independent of what it declares. */
function detectVersionFromShape(body: Required): 1 | 2 {
  const b = body as unknown as { resource?: unknown; accepts?: Array<Record<string, unknown>>; x402Version?: unknown };
  const first = Array.isArray(b.accepts) ? b.accepts[0] : undefined;
  if (b.resource && typeof b.resource === "object") return 2;
  if (first && "amount" in first && !("maxAmountRequired" in first)) return 2;
  if (first && "maxAmountRequired" in first) return 1;
  return b.x402Version === 2 ? 2 : 1;
}

function sameResource(a: string, b: string): boolean {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.host === ub.host && ua.pathname.replace(/\/$/, "") === ub.pathname.replace(/\/$/, "");
  } catch { return a === b; }
}
