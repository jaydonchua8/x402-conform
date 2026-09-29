# x402-conform

**Conformance test suite for [x402](https://github.com/coinbase/x402) resource servers and facilitators.**
Zero runtime dependencies. Supports protocol v1 and v2. Ships with a spec-faithful reference server and fault injection so every check is proven to catch the bug it claims to catch.

```
npx x402-conform server https://api.example.com/paid
npx x402-conform facilitator https://x402.org/facilitator
npx x402-conform crawl bazaar-listings.json --md
```

## Why

x402 has one spec and (as of Sept 2026) at least seven facilitators and hundreds of paid endpoints. They don't agree:

- Coinbase's facilitator changed `/verify` failures from `200` to `400` in Jan 2026; others still return `200`.
- Discovery indexes list endpoints that no longer return `402`, or that return a `402` an agent can't parse.
- Servers ship `amount: "0.01"` (must be atomic units), `network: "base"` in a v2 response (must be CAIP-2), or a USDC label pointing at the wrong contract.
- The worst case is silent: a server that *accepts a forged signature* and serves paid content for free. Nothing in the protocol will tell you.

Stripe has a test-mode and a webhook CLI; x402 sellers have `curl`. This is the missing lint step.

## Install / run

```bash
git clone https://github.com/jaydonchua8/x402-conform && cd x402-conform
npm install        # dev deps only (typescript, @types/node)
npm run build
node dist/src/cli.js --help
```

Requires Node ≥ 20 (uses built-in `fetch` and `node:test`).

## Checks

### Resource server (`x402-conform server <url>`)

| ID | Check | Sev |
|---|---|---|
| S01 | Unpaid request returns `402` | error |
| S02 | `PaymentRequired` is discoverable — v2 `PAYMENT-REQUIRED` header (base64 JSON) or v1 JSON body | error |
| S03 | `x402Version` matches the transport actually used | error |
| S04 | `accepts` is a non-empty array | error |
| S05 | Every `PaymentRequirements` entry has the spec's required fields with correct types | error |
| S06 | Amounts (`amount` / `maxAmountRequired`) are positive decimal-integer strings in atomic units | error |
| S07 | Network IDs are CAIP-2 (v2) or known slugs (v1) | error |
| S08 | `payTo` is a valid address for its network (hex-20 for EVM, base58 for SVM) | error |
| S09 | `asset` is a valid token address | error |
| S09b | If `extra.name` says USDC, `asset` is the canonical USDC contract for that network | warn |
| S10 | `maxTimeoutSeconds` is a positive integer | error |
| S10b | `maxTimeoutSeconds` ≤ 1h (long windows widen replay exposure) | warn |
| S11 | `resource` / `resource.url` matches the URL that was requested | warn |
| S12 | Garbage payment header → `4xx`, never `5xx` | error |
| S13 | Unsupported `x402Version` in payload → `4xx` | error |
| **S14** | **Forged signature never unlocks the resource** | **error** |
| S14b | Rejected payment re-issues `402` with requirements (so a client can retry) instead of a bare `400` | warn |
| S15 | Challenge latency p95 < 2s | warn |
| S16 | `402` carries `application/json` | warn |
| S17 | `exact`/EVM options include `extra.name` + `extra.version` (EIP-712 domain) | error |

### Facilitator (`x402-conform facilitator <url>`)

| ID | Check | Sev |
|---|---|---|
| F01 | `GET /supported` → `200` with non-empty `kinds[]` | error |
| F02 | Each kind declares `x402Version`, `scheme`, `network` (CAIP-2 for v2) | error |
| F03 | `POST /verify` with malformed JSON → `4xx` | error |
| F03b | `POST /verify` with schema-invalid body → `4xx` | error |
| **F04** | **`POST /verify` with a forged signature → `200 { isValid: false }`** | **error** |
| F04b | Rejection includes `invalidReason` | warn |
| F05 | `POST /settle` on an unverifiable payload fails closed (`success:false` or `4xx`, never `5xx`) | error |
| F05b | Failed settle has `transaction: ""` and a `network` | error |
| F06 | Unknown scheme is rejected without a `5xx` | error |
| F07 | `/supported` latency p95 < 1.5s | warn |

Facilitators that require auth (CDP's does): pass `--auth "Bearer <jwt>"`. Without it F04/F05 are skipped, not failed.

**What this suite deliberately does not do:** sign a real payment. Positive-path settlement needs a funded key and testnet USDC; that belongs in an integration test, not a lint. Every probe here uses a syntactically valid, cryptographically invalid payload, so it is safe to run against production.

## Reference server + fault injection

`src/fixtures/reference-server.ts` is a spec-faithful v1/v2 resource server and facilitator. Pass `--break` to inject specific violations:

```bash
node dist/src/fixtures/reference-server.js --port 4020 --break leak,huge-timeout
node dist/src/cli.js server http://127.0.0.1:4020/paid
```

```
FAIL  S14  Never serve protected content without payment
      HTTP 200: resource served for a payload with a forged signature — payment is not being verified
WARN  S10b maxTimeoutSeconds is reasonably bounded
      accepts[0]: maxTimeoutSeconds=86400 (>1h) widens the replay/expiry window
Summary: 17 pass, 1 fail, 1 warn, 0 skip   Score: 87/100
```

Available breaks: `no-402 leak no-header bad-base64 wrong-version empty-accepts missing-fields float-amount zero-amount bad-network bad-payto wrong-usdc huge-timeout no-extra crash-on-garbage text-content-type wrong-resource reject-400 fac-verify-200-on-garbage fac-verify-accepts-forged fac-settle-500 fac-settle-txhash-on-fail fac-no-invalid-reason fac-bad-kinds`.

## Tests

```bash
npm test     # 44 tests
```

The suite asserts two things for each protocol version: the clean reference server produces **zero** failures, and each of the 24 injected faults is caught by the specific check that claims to catch it. If you add a check, add the fault that trips it.

## Crawl mode

```bash
x402-conform crawl endpoints.txt --concurrency 8 --md > report.md
```

Accepts a newline list of URLs, a JSON array, or a Bazaar-style `{ items: [{ resource }] }` document. Produces a ranked table: score, reachability, protocol version, failing checks. Use it to answer "how much of the index is actually alive and spec-compliant?"

## Output formats

`--json` for CI, `--md` for issues and PR descriptions, default is a colored terminal report. Exit code `1` when any check fails, so it drops into a GitHub Action as-is.

## Design notes

- **Zero deps** because a lint tool that pulls 200 packages to check a 402 header is part of the problem.
- **Shape-based version detection**: the protocol version is inferred from the response's shape (header present, `resource` object, `amount` vs `maxAmountRequired`), then compared with the declared `x402Version`. Trusting the declared version would hide S03.
- **Errors vs warnings**: a check is an error only when the spec says MUST or when a compliant client would break. Things the spec leaves open (timeout bounds, content-type, re-issuing 402) are warnings.
- **Safe against prod**: every payload sent is unsigned or has a garbage signature; a correct server rejects all of them.

## Roadmap

- `--key` for a real testnet payment (positive-path settle, `PAYMENT-RESPONSE` header validation)
- `upto` scheme checks once its spec lands
- SVM `exact` payload probes
- GitHub Action wrapper

## License

MIT
