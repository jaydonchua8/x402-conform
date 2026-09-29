/**
 * Reference x402 resource server + facilitator, with fault injection.
 *
 * Spec-faithful by default. Pass `breaks` to inject specific violations so the
 * conformance suite can prove it catches each one.
 *
 *   node dist/src/fixtures/reference-server.js --port 4020 --v1 --break leak,no-header
 *
 * Routes:
 *   GET  /paid                  protected resource (402 until paid)
 *   GET  /facilitator/supported
 *   POST /facilitator/verify
 *   POST /facilitator/settle
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HEADERS, b64decode, b64encode } from "../protocol.js";
import type { PaymentPayloadV1, PaymentPayloadV2, PaymentRequiredV1, PaymentRequiredV2, SettleResponse, VerifyResponse } from "../types.js";

export type Break =
  | "no-402"          // return 200 to unpaid requests
  | "leak"            // accept any payload without verifying (serves content)
  | "no-header"       // v2: omit PAYMENT-REQUIRED header, body only
  | "bad-base64"      // v2: header is not base64 JSON
  | "wrong-version"   // x402Version mismatched
  | "empty-accepts"
  | "missing-fields"  // drop payTo + maxTimeoutSeconds
  | "float-amount"    // amount "0.01"
  | "zero-amount"
  | "bad-network"     // v2: "base" instead of CAIP-2; v1: "eip155:8453"
  | "bad-payto"
  | "wrong-usdc"      // asset is not canonical USDC while extra.name=USDC
  | "huge-timeout"    // 86400s
  | "no-extra"        // exact/EVM without extra.name/version
  | "crash-on-garbage"// 500 on malformed payment header
  | "text-content-type"
  | "wrong-resource"
  | "reject-400"      // reject invalid payment with bare 400 instead of 402
  | "fac-verify-200-on-garbage" // facilitator returns 200 for malformed body
  | "fac-verify-accepts-forged" // isValid:true for anything
  | "fac-settle-500"
  | "fac-settle-txhash-on-fail"
  | "fac-no-invalid-reason"
  | "fac-bad-kinds";

export interface RefServerOptions {
  port?: number;
  version?: 1 | 2;
  breaks?: Break[];
  host?: string;
}

const PAY_TO = "0x1111111111111111111111111111111111111111";

export function startReferenceServer(opts: RefServerOptions = {}): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const version = opts.version ?? 2;
  const breaks = new Set(opts.breaks ?? []);
  const host = opts.host ?? "127.0.0.1";
  const has = (b: Break) => breaks.has(b);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (url.pathname === "/paid") return handlePaid(req, res, url);
      if (url.pathname === "/facilitator/supported") return json(res, 200, has("fac-bad-kinds")
        ? { kinds: [{ scheme: "exact" }] }
        : { kinds: [{ x402Version: version, scheme: "exact", network: version === 2 ? "eip155:84532" : "base-sepolia" }], extensions: [], signers: {} });
      if (url.pathname === "/facilitator/verify" && req.method === "POST") return handleVerify(req, res);
      if (url.pathname === "/facilitator/settle" && req.method === "POST") return handleSettle(req, res);
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  function requirements(resourceUrl: string): PaymentRequiredV1 | PaymentRequiredV2 {
    const amount = has("float-amount") ? "0.01" : has("zero-amount") ? "0" : "10000";
    const network = version === 2 ? (has("bad-network") ? "base-sepolia" : "eip155:84532") : (has("bad-network") ? "eip155:84532" : "base-sepolia");
    const asset = has("wrong-usdc") ? "0x4200000000000000000000000000000000000006" : "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const payTo = has("bad-payto") ? "0xnotanaddress" : PAY_TO;
    const maxTimeoutSeconds = has("huge-timeout") ? 86400 : 60;
    const extra = has("no-extra") ? undefined : { name: "USDC", version: "2" };
    const resource = has("wrong-resource") ? "https://other.example/paid" : resourceUrl;
    const x402Version = has("wrong-version") ? (version === 2 ? 1 : 2) : version;

    if (version === 2) {
      const req: Record<string, unknown> = { scheme: "exact", network, amount, asset, payTo, maxTimeoutSeconds, extra };
      if (has("missing-fields")) { delete req.payTo; delete req.maxTimeoutSeconds; }
      return { x402Version: x402Version as 2, error: "Payment required", resource: { url: resource, description: "Reference paid resource", mimeType: "application/json" }, accepts: has("empty-accepts") ? [] : [req as never] };
    }
    const req: Record<string, unknown> = { scheme: "exact", network, maxAmountRequired: amount, asset, payTo, resource, description: "Reference paid resource", mimeType: "application/json", maxTimeoutSeconds, extra };
    if (has("missing-fields")) { delete req.payTo; delete req.maxTimeoutSeconds; }
    return { x402Version: x402Version as 1, error: "Payment required", accepts: has("empty-accepts") ? [] : [req as never] };
  }

  function send402(res: ServerResponse, resourceUrl: string) {
    const body = requirements(resourceUrl);
    const headers: Record<string, string> = { "content-type": has("text-content-type") ? "text/plain" : "application/json" };
    if (version === 2 && !has("no-header")) headers[HEADERS.v2.required] = has("bad-base64") ? "%%%not-base64%%%" : b64encode(body);
    res.writeHead(402, headers);
    res.end(JSON.stringify(body));
  }

  function handlePaid(req: IncomingMessage, res: ServerResponse, url: URL) {
    const resourceUrl = `http://${req.headers.host}${url.pathname}`;
    const payHeader = req.headers[version === 2 ? HEADERS.v2.signature : HEADERS.v1.payment];
    if (!payHeader) {
      if (has("no-402")) return json(res, 200, { data: "free lunch" });
      return send402(res, resourceUrl);
    }
    const dec = b64decode<PaymentPayloadV1 | PaymentPayloadV2>(String(payHeader));
    if (!dec.ok) {
      if (has("crash-on-garbage")) throw new Error("boom");
      return has("reject-400") ? json(res, 400, { error: dec.error }) : send402(res, resourceUrl);
    }
    const p = dec.value;
    if (p.x402Version !== version) return has("reject-400") ? json(res, 400, { error: "unsupported x402Version" }) : send402(res, resourceUrl);
    // Verify with the local facilitator logic (a forged signature is never valid).
    const ok = has("leak") || isGenuine(p);
    if (!ok) return has("reject-400") ? json(res, 400, { error: "invalid payment" }) : send402(res, resourceUrl);
    res.writeHead(200, { "content-type": "application/json", [version === 2 ? HEADERS.v2.response : HEADERS.v1.response]: b64encode({ success: true, transaction: "0x" + "ab".repeat(32), network: version === 2 ? "eip155:84532" : "base-sepolia", payer: PAY_TO }) });
    res.end(JSON.stringify({ data: "paid content" }));
  }

  async function handleVerify(req: IncomingMessage, res: ServerResponse) {
    const parsed = await readJson(req);
    if (!parsed.ok || !isWellFormedRequest(parsed.value)) {
      if (has("fac-verify-200-on-garbage")) return json(res, 200, { isValid: false, invalidReason: "malformed" });
      return json(res, 400, { error: "invalid request body" });
    }
    const { paymentPayload } = parsed.value as { paymentPayload: PaymentPayloadV1 | PaymentPayloadV2 };
    const scheme = "scheme" in paymentPayload ? paymentPayload.scheme : (paymentPayload as PaymentPayloadV2).accepted?.scheme;
    if (scheme !== "exact") return json(res, 200, { isValid: false, invalidReason: "unsupported_scheme" } satisfies VerifyResponse);
    const valid = has("fac-verify-accepts-forged") || isGenuine(paymentPayload);
    const out: VerifyResponse = valid ? { isValid: true, payer: PAY_TO } : { isValid: false, payer: PAY_TO };
    if (!valid && !has("fac-no-invalid-reason")) out.invalidReason = "invalid_exact_evm_payload_signature";
    json(res, 200, out);
  }

  async function handleSettle(req: IncomingMessage, res: ServerResponse) {
    const parsed = await readJson(req);
    if (!parsed.ok || !isWellFormedRequest(parsed.value)) return json(res, 400, { error: "invalid request body" });
    const { paymentPayload } = parsed.value as { paymentPayload: PaymentPayloadV1 | PaymentPayloadV2 };
    const network = version === 2 ? "eip155:84532" : "base-sepolia";
    if (!isGenuine(paymentPayload)) {
      if (has("fac-settle-500")) return json(res, 500, { error: "unexpected" });
      const out: SettleResponse = { success: false, errorReason: "invalid_exact_evm_payload_signature", transaction: has("fac-settle-txhash-on-fail") ? "0x" + "cd".repeat(32) : "", network, payer: PAY_TO };
      return json(res, 200, out);
    }
    json(res, 200, { success: true, transaction: "0x" + "ab".repeat(32), network, payer: PAY_TO } satisfies SettleResponse);
  }

  return new Promise(resolve => {
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({ server, url: `http://${host}:${port}`, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

/** The reference server has no real keys: only a payload whose signature is the magic
 *  test value is treated as genuine. Anything else is a forgery. */
function isGenuine(p: PaymentPayloadV1 | PaymentPayloadV2): boolean {
  const sig = (p.payload as { signature?: string } | undefined)?.signature;
  return sig === "0x" + "ff".repeat(65);
}

function isWellFormedRequest(v: unknown): v is { x402Version: number; paymentPayload: object; paymentRequirements: object } {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const pp = o.paymentPayload as Record<string, unknown> | undefined;
  const pr = o.paymentRequirements as Record<string, unknown> | undefined;
  return typeof o.x402Version === "number" && !!pp && typeof pp === "object" && !!pr && typeof pr === "object"
    && typeof pp.x402Version === "number" && typeof pr.scheme === "string" && typeof pr.network === "string";
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  return new Promise(resolve => {
    let data = "";
    req.on("data", c => (data += c));
    req.on("end", () => { try { resolve({ ok: true, value: JSON.parse(data) }); } catch { resolve({ ok: false }); } });
    req.on("error", () => resolve({ ok: false }));
  });
}

// CLI entry: node dist/src/fixtures/reference-server.js --port 4020 [--v1] [--break a,b,c]
if (process.argv[1] && /reference-server\.js$/.test(process.argv[1])) {
  const a = process.argv.slice(2);
  const port = Number(a[a.indexOf("--port") + 1] || 4020);
  const version: 1 | 2 = a.includes("--v1") ? 1 : 2;
  const bi = a.indexOf("--break");
  const breaks = bi >= 0 ? (a[bi + 1].split(",") as Break[]) : [];
  startReferenceServer({ port, version, breaks }).then(s => console.log(`reference x402 server v${version} on ${s.url}  breaks=[${breaks.join(",")}]\n  resource:    ${s.url}/paid\n  facilitator: ${s.url}/facilitator`));
}
