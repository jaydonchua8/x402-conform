#!/usr/bin/env node
/**
 * x402-conform CLI
 *
 *   x402-conform server <url>        [--v1|--v2] [--method POST] [--samples 5] [--json|--md] [--timeout 10000]
 *   x402-conform facilitator <url>   [--auth "Bearer …"] [--json|--md]
 *   x402-conform crawl <file.json>   [--concurrency 8] [--md]        (Bazaar/list of resource URLs)
 *
 * Exit code: 0 when no FAIL results, 1 otherwise, 2 on usage error.
 */
import { readFileSync } from "node:fs";
import { checkFacilitator } from "./checks/facilitator.js";
import { checkServer } from "./checks/server.js";
import { renderMarkdown, renderText, score } from "./report.js";
import type { Report } from "./types.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const target = argv[1];

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (name: string) => argv.includes(`--${name}`);

function usage(code = 2): never {
  console.error(`usage:
  x402-conform server <url> [--v1|--v2] [--method GET] [--samples 5] [--timeout ms] [--json|--md]
  x402-conform facilitator <url> [--auth "Bearer <token>"] [--timeout ms] [--json|--md]
  x402-conform crawl <urls.json|urls.txt> [--concurrency 8] [--json|--md]`);
  process.exit(code);
}

function emit(rep: Report) {
  if (has("json")) console.log(JSON.stringify(rep, null, 2));
  else if (has("md")) console.log(renderMarkdown(rep));
  else console.log(renderText(rep));
}

async function main() {
  if (!cmd || !target || has("help")) usage(cmd ? 2 : 0);
  const timeoutMs = flag("timeout") ? Number(flag("timeout")) : undefined;

  if (cmd === "server") {
    const rep = await checkServer({
      url: target, version: has("v1") ? 1 : has("v2") ? 2 : undefined,
      method: flag("method"), samples: flag("samples") ? Number(flag("samples")) : undefined, timeoutMs,
    });
    emit(rep);
    process.exit(rep.summary.fail ? 1 : 0);
  }

  if (cmd === "facilitator") {
    const rep = await checkFacilitator({ url: target, authorization: flag("auth"), timeoutMs });
    emit(rep);
    process.exit(rep.summary.fail ? 1 : 0);
  }

  if (cmd === "crawl") {
    const urls = loadUrls(target);
    const conc = Number(flag("concurrency") ?? 8);
    const reports: Report[] = [];
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(conc, urls.length) }, async () => {
      while (i < urls.length) {
        const u = urls[i++];
        reports.push(await checkServer({ url: u, samples: 1, timeoutMs: timeoutMs ?? 8000 }));
      }
    }));
    reports.sort((a, b) => score(b) - score(a));
    if (has("json")) { console.log(JSON.stringify(reports, null, 2)); }
    else {
      const rows = reports.map(r => {
        const s01 = r.results.find(x => x.id === "S01");
        const fails = r.results.filter(x => x.status === "fail").map(x => x.id).join(",");
        return `| ${score(r)} | ${s01?.status === "pass" ? "up" : "DOWN"} | v${r.x402Version ?? "?"} | \`${r.target}\` | ${fails || "—"} |`;
      });
      const dead = reports.filter(r => r.results.find(x => x.id === "S01")?.status !== "pass").length;
      console.log(`## x402-conform crawl — ${reports.length} endpoints, ${dead} not returning 402 (${((dead / reports.length) * 100).toFixed(0)}%)\n`);
      console.log("| Score | Reach | Ver | Endpoint | Failing checks |\n|---|---|---|---|---|");
      console.log(rows.join("\n"));
    }
    process.exit(reports.some(r => r.summary.fail) ? 1 : 0);
  }

  usage();
}

/** Accepts: a newline list of URLs, a JSON array of strings, or a Bazaar-style discovery document. */
function loadUrls(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j.map(x => (typeof x === "string" ? x : x?.resource ?? x?.url)).filter(Boolean);
    const items = j.items ?? j.resources ?? j.data ?? [];
    return items.map((x: { resource?: string; url?: string }) => x.resource ?? x.url).filter(Boolean);
  } catch {
    return raw.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  }
}

main().catch(e => { console.error(e); process.exit(2); });
