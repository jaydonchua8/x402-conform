import type { Report } from "./types.js";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", gray: "\x1b[90m",
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c: string, s: string) => (useColor ? c + s + C.reset : s);

const ICON = { pass: paint(C.green, "PASS"), fail: paint(C.red, "FAIL"), warn: paint(C.yellow, "WARN"), skip: paint(C.gray, "SKIP") };

export function renderText(rep: Report): string {
  const lines: string[] = [];
  lines.push(paint(C.bold, `x402-conform · ${rep.kind} · ${rep.target}`) + (rep.x402Version ? paint(C.dim, `  (protocol v${rep.x402Version})`) : ""));
  lines.push("");
  for (const r of rep.results) {
    lines.push(`${ICON[r.status]}  ${paint(C.bold, r.id.padEnd(4))} ${r.title}`);
    lines.push(`      ${paint(C.dim, r.detail)}${r.ref ? paint(C.gray, `  [${r.ref}]`) : ""}`);
  }
  lines.push("");
  const s = rep.summary;
  lines.push(`${paint(C.bold, "Summary")}: ${paint(C.green, `${s.pass} pass`)}, ${paint(C.red, `${s.fail} fail`)}, ${paint(C.yellow, `${s.warn} warn`)}, ${paint(C.gray, `${s.skip} skip`)}`);
  lines.push(paint(C.dim, `Score: ${score(rep)}/100`));
  return lines.join("\n");
}

export function renderMarkdown(rep: Report): string {
  const s = rep.summary;
  const out: string[] = [];
  out.push(`## x402-conform report — ${rep.kind}: \`${rep.target}\``);
  out.push("");
  out.push(`Protocol: v${rep.x402Version ?? "?"} · ${s.pass} pass / ${s.fail} fail / ${s.warn} warn / ${s.skip} skip · **Score ${score(rep)}/100** · ${rep.finishedAt}`);
  out.push("");
  out.push("| Status | ID | Check | Detail |");
  out.push("|---|---|---|---|");
  for (const r of rep.results) out.push(`| ${r.status.toUpperCase()} | ${r.id} | ${r.title} | ${r.detail.replace(/\|/g, "\\|")} |`);
  return out.join("\n");
}

/** 100 minus 10 per fail and 3 per warn, floored at 0. */
export function score(rep: Report): number {
  return Math.max(0, 100 - rep.summary.fail * 10 - rep.summary.warn * 3);
}
