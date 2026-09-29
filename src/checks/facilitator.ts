/**
 * Conformance checks for an x402 facilitator (/supported, /verify, /settle).
 *
 * Contract under test (v1 + v2 specs):
 *   - GET  /supported -> 200 { kinds: [{ x402Version, scheme, network }], ... }
 *   - POST /verify    -> 200 { isValid, invalidReason?, payer? } for a well-formed request
 *                        4xx for a malformed request (CDP switched from 200 to 400 on 2026-01-15)
 *   - POST /settle    -> 200 { success, errorReason?, transaction, network, payer? } or 4xx
 *                        never 5xx on client input; transaction "" when success=false
 */
import { CAIP2_RE, KNOWN_V1_NETWORKS, USDC, buildPayloadV1, buildPayloadV2 } from "../protocol.js";
import { Runner, http, percentile } from "../runner.js";
import type { FacilitatorCheckOptions, PaymentRequirementsV1, PaymentRequirementsV2, Report, SettleResponse, SupportedKind, SupportedResponse, VerifyResponse } from "../types.js";

export async function checkFacilitator(opts: FacilitatorCheckOptions): Promise<Report> {
  const startedAt = new Date().toISOString();
  const base = opts.url.replace(/\/$/, "");
  const r = new Runner(base, "facilitator");
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.authorization) headers["authorization"] = opts.authorization;

  // F01: /supported
  const sup = await http(`${base}/supported`, { timeoutMs, headers });
  if (sup.error || sup.status === 0) { r.fail("F01", "GET /supported responds", `request failed: ${sup.error}`); return r.report(startedAt); }
  const supBody = sup.json as SupportedResponse | undefined;
  const kinds = supBody?.kinds;
  const kindsOk = sup.status === 200 && Array.isArray(kinds) && kinds.length > 0;
  r.expect("F01", "GET /supported returns 200 with non-empty kinds[]", kindsOk,
    `${(kinds ?? []).length} kind(s)`, `HTTP ${sup.status}, kinds=${Array.isArray(kinds) ? kinds.length : typeof kinds}`);
  if (!kindsOk) return r.report(startedAt);

  const kindProblems: string[] = [];
  (kinds as SupportedKind[]).forEach((k, i) => {
    if (typeof k.x402Version !== "number") kindProblems.push(`kinds[${i}].x402Version missing`);
    if (typeof k.scheme !== "string") kindProblems.push(`kinds[${i}].scheme missing`);
    if (typeof k.network !== "string") kindProblems.push(`kinds[${i}].network missing`);
    else if (k.x402Version === 2 && !CAIP2_RE.test(k.network)) kindProblems.push(`kinds[${i}].network "${k.network}" not CAIP-2 for v2`);
    else if (k.x402Version === 1 && !KNOWN_V1_NETWORKS.has(k.network)) kindProblems.push(`kinds[${i}].network "${k.network}" unknown v1 slug`);
  });
  r.expect("F02", "Each supported kind declares x402Version, scheme, network", kindProblems.length === 0, "ok", kindProblems.join(" | "));

  // Choose a kind to probe with (prefer exact on an EVM network).
  const kind = (kinds as SupportedKind[]).find(k => k.scheme === "exact" && typeof k.network === "string" && (k.network.startsWith("eip155:") || /^base|avalanche/.test(k.network))) ?? (kinds as SupportedKind[])[0];
  const version = kind.x402Version === 2 ? 2 : 1;
  const network = typeof kind.network === "string" ? kind.network : (version === 2 ? "eip155:84532" : "base-sepolia");
  const scheme = typeof kind.scheme === "string" ? kind.scheme : "exact";
  const asset = USDC[network] ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const payTo = "0x2222222222222222222222222222222222222222";
  const requirements = version === 2
    ? ({ scheme, network, amount: "1000", asset, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } } satisfies PaymentRequirementsV2)
    : ({ scheme, network, maxAmountRequired: "1000", asset, payTo, resource: "https://example.com/paid", description: "conformance probe", mimeType: "application/json", maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } } satisfies PaymentRequirementsV1);
  const payload = version === 2 ? buildPayloadV2(requirements as PaymentRequirementsV2, "https://example.com/paid") : buildPayloadV1(requirements as PaymentRequirementsV1);
  const body = JSON.stringify({ x402Version: version, paymentPayload: payload, paymentRequirements: requirements });

  // F03: malformed /verify body -> 4xx (not 200, not 5xx)
  const bad = await http(`${base}/verify`, { method: "POST", timeoutMs, headers, body: "{not json" });
  r.expect("F03", "POST /verify with malformed JSON returns 4xx", bad.status >= 400 && bad.status < 500,
    `HTTP ${bad.status}`, `HTTP ${bad.status}; malformed input must be a client error (CDP moved this 200→400 on 2026-01-15)`, "docs.cdp.coinbase.com changelog 2026-01-15");

  // F03b: schema-invalid but parseable body -> 4xx
  const bad2 = await http(`${base}/verify`, { method: "POST", timeoutMs, headers, body: JSON.stringify({ x402Version: version, paymentPayload: {}, paymentRequirements: {} }) });
  r.expect("F03b", "POST /verify with schema-invalid body returns 4xx", bad2.status >= 400 && bad2.status < 500,
    `HTTP ${bad2.status}`, `HTTP ${bad2.status} for empty paymentPayload/paymentRequirements`);

  // F04: well-formed request with forged signature -> 200 { isValid:false, invalidReason }
  const ver = await http(`${base}/verify`, { method: "POST", timeoutMs, headers, body });
  const vb = ver.json as VerifyResponse | undefined;
  if (ver.status === 401 || ver.status === 403) {
    r.skip("F04", "POST /verify rejects a forged signature with isValid=false", `HTTP ${ver.status}: facilitator requires authentication; pass --auth`);
    r.skip("F05", "POST /settle fails closed", "skipped: authentication required");
  } else {
    const ok = ver.status === 200 && vb?.isValid === false;
    r.expect("F04", "POST /verify rejects a forged signature with isValid=false", ok,
      `isValid=false invalidReason=${vb?.invalidReason ?? "(none)"}`, ver.status === 200 && vb?.isValid === true
        ? "isValid=true for a forged signature — the facilitator is not verifying signatures"
        : `HTTP ${ver.status} body=${truncate(ver.text)}`, "spec: /verify response");
    if (ok) r.expect("F04b", "invalidReason is populated on rejection", typeof vb?.invalidReason === "string" && vb.invalidReason.length > 0,
      vb?.invalidReason ?? "", "isValid=false without invalidReason; clients cannot tell the user why", undefined, "warn");

    // F05: /settle on an unverifiable payload must fail closed
    const set = await http(`${base}/settle`, { method: "POST", timeoutMs, headers, body });
    const sb = set.json as SettleResponse | undefined;
    const failedClosed = (set.status === 200 && sb?.success === false) || (set.status >= 400 && set.status < 500);
    r.expect("F05", "POST /settle fails closed on an unverifiable payload", failedClosed,
      `HTTP ${set.status} success=${sb?.success} errorReason=${sb?.errorReason ?? "(none)"}`,
      set.status >= 500 ? `HTTP ${set.status}: facilitator crashed on client input` : `HTTP ${set.status} success=${sb?.success}`);
    if (set.status === 200 && sb) {
      r.expect("F05b", "Failed settle has empty transaction and a network", sb.transaction === "" && typeof sb.network === "string",
        "ok", `transaction="${sb.transaction}" network=${sb.network}`, "spec: /settle error response");
    }
  }

  // F06: unknown scheme -> rejected, not 5xx
  const unk = await http(`${base}/verify`, { method: "POST", timeoutMs, headers, body: JSON.stringify({ x402Version: version, paymentPayload: { ...payload, scheme: "nope", accepted: { ...(payload as { accepted?: unknown }).accepted as object, scheme: "nope" } }, paymentRequirements: { ...requirements, scheme: "nope" } }) });
  const ub = unk.json as VerifyResponse | undefined;
  r.expect("F06", "Unknown scheme is rejected without a 5xx", unk.status < 500 && !(unk.status === 200 && ub?.isValid === true),
    `HTTP ${unk.status} isValid=${ub?.isValid}`, `HTTP ${unk.status} isValid=${ub?.isValid}`);

  // F07: latency of /supported
  const times = [sup.ms];
  for (let i = 0; i < 4; i++) { const s = await http(`${base}/supported`, { timeoutMs, headers }); if (!s.error) times.push(s.ms); }
  const p95 = percentile(times, 95);
  r.expect("F07", "/supported latency", p95 < 1500, `p50=${percentile(times, 50).toFixed(0)}ms p95=${p95.toFixed(0)}ms`, `p95=${p95.toFixed(0)}ms`, undefined, "warn");

  return r.report(startedAt, version);
}

function truncate(s: string, n = 160): string { return s.length > n ? s.slice(0, n) + "…" : s; }
