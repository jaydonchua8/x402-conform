/**
 * HTTP + check-runner utilities.
 */
import type { CheckResult, Report, Severity, Status } from "./types.js";

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  json: unknown | undefined;
  ms: number;
  error?: string;
}

export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<HttpResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 10_000);
  const start = performance.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: "manual" });
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, headers: res.headers, text, json, ms: performance.now() - start };
  } catch (e) {
    return { status: 0, headers: new Headers(), text: "", json: undefined, ms: performance.now() - start, error: (e as Error).message };
  } finally {
    clearTimeout(t);
  }
}

export class Runner {
  results: CheckResult[] = [];
  constructor(public readonly target: string, public readonly kind: Report["kind"]) {}

  add(id: string, title: string, severity: Severity, status: Status, detail: string, ref?: string, durationMs?: number): CheckResult {
    const r: CheckResult = { id, title, status, severity, detail, ref, durationMs };
    this.results.push(r);
    return r;
  }

  pass(id: string, title: string, detail: string, ref?: string) { return this.add(id, title, "info", "pass", detail, ref); }
  fail(id: string, title: string, detail: string, ref?: string) { return this.add(id, title, "error", "fail", detail, ref); }
  warn(id: string, title: string, detail: string, ref?: string) { return this.add(id, title, "warn", "warn", detail, ref); }
  skip(id: string, title: string, detail: string) { return this.add(id, title, "info", "skip", detail); }

  /** pass if cond, otherwise fail (or warn when severity is "warn"). */
  expect(id: string, title: string, cond: boolean, okDetail: string, badDetail: string, ref?: string, severity: Severity = "error") {
    if (cond) return this.pass(id, title, okDetail, ref);
    return severity === "warn" ? this.warn(id, title, badDetail, ref) : this.fail(id, title, badDetail, ref);
  }

  report(startedAt: string, x402Version?: 1 | 2): Report {
    const summary = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const r of this.results) summary[r.status]++;
    return { target: this.target, kind: this.kind, startedAt, finishedAt: new Date().toISOString(), x402Version, results: this.results, summary };
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
