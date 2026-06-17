// Runner — orchestrates N agents against a target URL and produces run.json.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

import type { Run, Event, Issue, Delight, RouteHeat, PersonaSet, FeatureFrequency, SegmentMetric } from "./types.js";
import { allocateSlots } from "./personas.js";
import { runAgent, type AgentResult } from "./agent.js";
import { simKeyCount } from "./llm.js";
import {
  readLocalSandboxOptionsFromEnv,
  sandboxTargetUrl,
  startLocalSandbox,
  type LocalSandboxInstance,
  type LocalSandboxOptions,
} from "./sandbox.js";

export type RunOptions = {
  targetUrl: string;
  personaSet: PersonaSet;       // pre-generated (preset / beta / mixed)
  agents?: number;               // total slots to fill; defaults to sim key count
  maxSteps: number;              // safety cap per agent (default 30 from CLI)
  maxMinutes: number;            // wall-clock safety cap per agent (default 10)
  outDir: string;
  headless: boolean;
  viewport?: { w: number; h: number };
  concurrency?: number;
  sandbox?: LocalSandboxOptions | false;
  log?: (line: string) => void;
};

export async function executeRun(opts: RunOptions): Promise<{ run: Run; runDir: string }> {
  const viewport = opts.viewport ?? { w: 1280, h: 800 };
  const log = opts.log ?? (() => {});
  const sandboxOptions = opts.sandbox === false ? null : opts.sandbox ?? readLocalSandboxOptionsFromEnv();

  await mkdir(opts.outDir, { recursive: true });
  const runId = await nextRunId(opts.outDir);
  const runDir = join(opts.outDir, runId);
  await mkdir(runDir, { recursive: true });

  // Hard cap: personas (distinct archetypes) must not exceed sim key count.
  // Slots fill the sim pool — fewer personas means weight-based replication.
  let simKeys = 1;
  try {
    simKeys = simKeyCount();
  } catch {
    // Mock or anthropic-single-key — fall back to a generous default so the
    // mock pipeline isn't capped to 1 slot.
    simKeys = process.env.PP_MOCK_LLM === "1" ? 6 : 1;
  }
  if (opts.personaSet.personas.length > simKeys) {
    throw new Error(
      `persona set has ${opts.personaSet.personas.length} archetypes but only ${simKeys} simulation keys are configured. ` +
      `Persona count must not exceed sim key count. Either drop personas or add keys to the keychain entry.`
    );
  }
  const requested = opts.agents ?? simKeys;
  const slotCount = Math.max(1, Math.min(requested, simKeys));
  const personas = allocateSlots(opts.personaSet, slotCount);
  log(`run ${runId}: ${personas.length} agent slots from ${opts.personaSet.personas.length} archetypes · ` +
      `safety cap ${opts.maxSteps} steps / ${opts.maxMinutes} min per agent`);

  const browser = await chromium.launch({ headless: opts.headless });
  const t0 = new Date().toISOString();

  let targetTitle = opts.targetUrl;
  if (sandboxOptions) {
    log(`  mode: local sandbox-runtime isolation · headless=${opts.headless}`);
    try {
      const probeSandbox = await startLocalSandbox(sandboxOptions, {
        agentId: "probe",
        runDir,
        port: sandboxOptions.portBase,
        log,
      });
      try {
        const probe = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h } });
        const p = await probe.newPage();
        await p.goto(sandboxTargetUrl(opts.targetUrl, probeSandbox.host, probeSandbox.port), {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        targetTitle = (await p.title()) || opts.targetUrl;
        await probe.close();
      } finally {
        await probeSandbox.stop().catch(() => {});
      }
    } catch (e) {
      log(`probe failed: ${(e as Error).message}`);
    }
  } else {
    try {
      const probe = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h } });
      const p = await probe.newPage();
      await p.goto(opts.targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      targetTitle = (await p.title()) || opts.targetUrl;
      await probe.close();
    } catch (e) {
      log(`probe failed: ${(e as Error).message}`);
    }
  }

  // Default to running all agents in parallel — sim pool is sized by sim
  // key count and each agent gets one Playwright context. User can throttle
  // via --concurrency if RAM is tight (each Chromium context ≈ 150 MB).
  // When sandbox-runtime mode is enabled, each agent also gets a unique local
  // sandbox process and port, so app state / filesystem writes are isolated.
  const concurrency = Math.max(1, opts.concurrency ?? personas.length);
  log(`  concurrency=${concurrency} (${opts.concurrency != null ? "user-set" : "default = all agents"})`);
  const results: AgentResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, personas.length) }, async () => {
    while (cursor < personas.length) {
      const i = cursor++;
      const persona = personas[i];
      let sandbox: LocalSandboxInstance | null = null;
      let targetUrl = opts.targetUrl;
      log(`  [${persona.id}] ${persona.name} starting`);
      try {
        if (sandboxOptions) {
          sandbox = await startLocalSandbox(sandboxOptions, {
            agentId: persona.id,
            runDir,
            port: sandboxOptions.portBase + i + 1,
            log,
          });
          targetUrl = sandboxTargetUrl(opts.targetUrl, sandbox.host, sandbox.port);
        }

        const r = await runAgent({
          persona,
          browser,
          targetUrl,
          maxSteps: opts.maxSteps,
          maxMinutes: opts.maxMinutes,
          runDir,
          viewport,
          lang: opts.personaSet.lang ?? "en",
        });
        log(`  [${persona.id}] done (${r.exitReason}) · ${r.events.length} events · ${r.durationSec.toFixed(0)}s · $${r.cost.usd.toFixed(3)}`);
        results.push(r);
      } catch (e) {
        log(`  [${persona.id}] CRASH: ${(e as Error).message}`);
        results.push({
          persona,
          events: [],
          finished: false,
          truncated: true,
          exitReason: "crashed",
          accomplished: false,
          summary: `Crashed: ${(e as Error).message}`,
          issues: [],
          delights: [],
          features: [],
          durationSec: 0,
          cost: { tokensIn: 0, tokensOut: 0, usd: 0 },
        });
      } finally {
        if (sandbox) {
          await sandbox.stop().catch((e) => log(`  [${persona.id}] sandbox stop failed: ${(e as Error).message}`));
        }
      }
    }
  });
  await Promise.all(workers);
  await browser.close().catch(() => {});

  const finishedAt = new Date().toISOString();
  const run = aggregate({
    runId,
    targetUrl: opts.targetUrl,
    targetTitle,
    viewport,
    personaSetId: opts.personaSet.id,
    startedAt: t0,
    finishedAt,
    results,
    routeHostnames: sandboxOptions ? [sandboxOptions.host] : [],
  });

  const runJsonPath = join(runDir, "run.json");
  await writeFile(runJsonPath, JSON.stringify(run, null, 2));
  log(`run ${runId}: wrote ${runJsonPath}`);

  return { run, runDir };
}

// ── Aggregation ─────────────────────────────────────────────────────────────

// Classify one session as promoter / passive / detractor for NPS. Combines the
// session outcome (exitReason / accomplished) with how it actually FELT — the
// mean of that agent's non-neutral event sentiment, which now includes the
// behaviour-grounded dead-click / rage events emitted by the agent loop.
export function classifySession(r: AgentResult): "promoter" | "passive" | "detractor" {
  const felt = r.events.filter((e) => e.sentiment !== 0);
  const mean = felt.length ? felt.reduce((s, e) => s + e.sentiment, 0) / felt.length : 0;
  if (r.exitReason === "frustrated" || r.exitReason === "crashed" || mean <= -0.5) return "detractor";
  if (r.accomplished && mean >= 1) return "promoter";
  return "passive";
}

function aggregate(args: {
  runId: string;
  targetUrl: string;
  targetTitle: string;
  viewport: { w: number; h: number };
  personaSetId: string;
  startedAt: string;
  finishedAt: string;
  results: AgentResult[];
  routeHostnames?: string[];
}): Run {
  const { runId, targetUrl, targetTitle, viewport, personaSetId, startedAt, finishedAt, results } = args;

  // Flatten events sorted by t (lexicographic on "mm:ss:cs" is fine).
  const activity: Event[] = results
    .flatMap((r) => r.events)
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  // Dedupe issues by lower-cased title across agents. Keep every hitting agent's
  // own severity vote + quote so we can show the DISTRIBUTION and pick a
  // representative (median) quote — not the single angriest one.
  const issueMap = new Map<
    string,
    { hits: number; severities: ("high" | "med" | "low")[]; entries: { iss: AgentResult["issues"][number]; agentId: string }[]; evidence: number }
  >();
  for (const r of results) {
    for (const iss of r.issues) {
      const k = normalizeTitle(iss.title);
      const cur = issueMap.get(k);
      if (cur) {
        cur.hits++;
        cur.severities.push(iss.severity);
        cur.evidence += iss.evidence || 1;
        cur.entries.push({ iss, agentId: r.persona.id });
      } else {
        issueMap.set(k, { hits: 1, severities: [iss.severity], entries: [{ iss, agentId: r.persona.id }], evidence: iss.evidence || 1 });
      }
    }
  }

  const issues: Issue[] = Array.from(issueMap.entries())
    .map(([_, v], i) => {
      // Representative severity = MEDIAN of the agents' own votes. Neither the
      // angriest agent (overstates) nor a frequency bump (conflates "common"
      // with "severe"). The full spread stays in severityVotes, so a high-
      // severity minority remains visible; confidence flags low agreement.
      const sev = medianSeverity(v.severities);
      const rep = v.entries.find((e) => e.iss.severity === sev) ?? v.entries[0];
      const confidence = v.severities.length
        ? v.severities.filter((s) => s === sev).length / v.severities.length
        : 1;
      return {
        id: `i${String(i + 1).padStart(2, "0")}`,
        title: rep.iss.title,
        severity: sev,
        agents: v.hits,
        category: rep.iss.category || "Other",
        quote: rep.iss.quote,
        agentRef: rep.agentId,
        evidence: v.evidence,
        journey: rep.iss.journey || "whole session",
        severityVotes: v.severities.slice(),
        confidence,
      };
    })
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.agents - a.agents);

  // Delights — dedupe similarly.
  const delightMap = new Map<string, { hits: number; sample: AgentResult["delights"][number]; agent: string }>();
  for (const r of results) {
    for (const d of r.delights) {
      const k = normalizeTitle(d.title);
      const cur = delightMap.get(k);
      if (cur) cur.hits++;
      else delightMap.set(k, { hits: 1, sample: d, agent: r.persona.id });
    }
  }
  const delights: Delight[] = Array.from(delightMap.values())
    .map((d) => ({ title: d.sample.title, count: d.hits, quote: d.sample.quote, agent: d.agent }))
    .sort((a, b) => b.count - a.count);

  // Routes — collect any URL that was visited and bucket dwell.
  const routesHeat = buildRoutesHeat(results, targetUrl, args.routeHostnames ?? []);

  // Sentiment curve — sample at percent-of-elapsed buckets.
  const sentimentCurve = buildSentimentCurve(activity);

  // Metrics.
  const totalAgents = results.length;
  const accomplished = results.filter((r) => r.accomplished).length;
  const rageClicks = activity.filter((e) => e.kind === "rage").length;
  const delightCount = activity.filter((e) => e.sentiment >= 2).length;
  // Predicted NPS — the real NPS definition (% promoters − % detractors),
  // classified PER SESSION from outcome + how that session actually felt.
  // (Replaces the old `avgSentiment * 33`, which pooled every event — including
  // neutral navigation — into one mean × a magic constant, diluting signal
  // toward 0 and ignoring per-session structure.) Sessions are weight-balanced
  // because allocateSlots already replicates archetypes by weight.
  const promoters = results.filter((r) => classifySession(r) === "promoter").length;
  const detractors = results.filter((r) => classifySession(r) === "detractor").length;
  const predictedNps = totalAgents ? Math.round(((promoters - detractors) / totalAgents) * 100) : 0;
  const achievableNps = clamp(predictedNps + issues.filter((i) => i.severity === "high").length * 14, -100, 100);
  const taskSuccess = totalAgents ? accomplished / totalAgents : 0;
  // Sample-size confidence — a 3-agent run must not read as authoritatively as
  // a 24-agent one.
  const confidence: "low" | "medium" | "high" = totalAgents >= 12 ? "high" : totalAgents >= 6 ? "medium" : "low";
  // Per-cohort breakdown (by tech band), so a bimodal audience isn't hidden.
  const segments = segmentMetrics(results);

  // Time-to-value — earliest +2 sentiment event.
  const firstDelight = activity.find((e) => e.sentiment >= 2);
  const timeToValueSec = firstDelight ? tToSec(firstDelight.t) : null;

  // Total cost.
  const cost = results.reduce(
    (acc, r) => ({
      tokensIn: acc.tokensIn + r.cost.tokensIn,
      tokensOut: acc.tokensOut + r.cost.tokensOut,
      usd: acc.usd + r.cost.usd,
    }),
    { tokensIn: 0, tokensOut: 0, usd: 0 }
  );

  return {
    id: runId,
    startedAt,
    finishedAt,
    target: { url: targetUrl, title: targetTitle, viewport },
    personaSetId,
    agents: results.map((r) => ({
      ...r.persona,
      crashed: r.exitReason === "crashed" || (r.events.length === 0 && !r.finished),
      truncated: r.truncated,
      exitReason: r.exitReason,
      durationSec: r.durationSec,
    })),
    activity,
    issues,
    delights,
    features: aggregateFeatures(results),
    segments,
    routesHeat,
    sentimentCurve,
    metrics: {
      predictedNps,
      achievableNps,
      taskSuccess,
      timeToValueSec,
      rageClicks,
      delightCount,
      sampleSize: totalAgents,
      confidence,
    },
    cost,
  };
}

// Per-tech-band cohort metrics. Replicated clones (id `a01-1`, `a01-2`) collapse
// to one archetype for the lowN guard, so a bucket of clones isn't mistaken for
// a diverse cohort.
function segmentMetrics(results: AgentResult[]): SegmentMetric[] {
  const band = (tech: number) =>
    tech <= 2 ? { key: "tech-low", label: "novice (tech 1–2)" }
    : tech === 3 ? { key: "tech-mid", label: "mid (tech 3)" }
    : { key: "tech-high", label: "power (tech 4–5)" };
  const buckets = new Map<string, { label: string; rs: AgentResult[] }>();
  for (const r of results) {
    const b = band(r.persona.tech);
    const cur = buckets.get(b.key) ?? { label: b.label, rs: [] };
    cur.rs.push(r);
    buckets.set(b.key, cur);
  }
  const baseId = (id: string) => id.replace(/-\d+$/, "");
  return ["tech-low", "tech-mid", "tech-high"]
    .filter((k) => buckets.has(k))
    .map((key) => {
      const { label, rs } = buckets.get(key)!;
      const archetypes = new Set(rs.map((r) => baseId(r.persona.id))).size;
      const promoters = rs.filter((r) => classifySession(r) === "promoter").length;
      const detractors = rs.filter((r) => classifySession(r) === "detractor").length;
      const nps = rs.length ? Math.round(((promoters - detractors) / rs.length) * 100) : 0;
      const taskSuccess = rs.length ? rs.filter((r) => r.accomplished).length / rs.length : 0;
      const titleHits = new Map<string, number>();
      for (const r of rs) for (const iss of r.issues) titleHits.set(iss.title, (titleHits.get(iss.title) ?? 0) + 1);
      let topIssue: string | null = null;
      let best = 0;
      for (const [t, n] of titleHits) if (n > best) { best = n; topIssue = t; }
      return { key, label, archetypes, agents: rs.length, nps, taskSuccess, topIssue, lowN: archetypes < 2 };
    });
}

// Feature aggregation — cross-agent rollup of per-agent featuresUsed lists.
// We canonicalize feature names case-insensitively but keep the most
// frequently-used original casing for display.
function aggregateFeatures(results: AgentResult[]): FeatureFrequency[] {
  const map = new Map<
    string,
    { name: string; hits: number; completes: number; attempts: number; sentSum: number; sentN: number }
  >();
  for (const r of results) {
    for (const f of r.features) {
      const key = f.name.trim().toLowerCase();
      if (!key) continue;
      const cur = map.get(key) || { name: f.name.trim(), hits: 0, completes: 0, attempts: 0, sentSum: 0, sentN: 0 };
      cur.hits++;
      cur.attempts += f.attempts;
      if (f.completed) cur.completes++;
      cur.sentSum += f.sentiment;
      cur.sentN++;
      map.set(key, cur);
    }
  }
  const total = Math.max(1, results.length);
  return Array.from(map.values())
    .map((v) => ({
      name: v.name,
      hitCount: v.hits,
      hitRate: v.hits / total,
      completionRate: v.hits > 0 ? v.completes / v.hits : 0,
      avgSentiment: v.sentN > 0 ? v.sentSum / v.sentN : 0,
      totalAttempts: v.attempts,
    }))
    .sort((a, b) => b.hitRate - a.hitRate || b.totalAttempts - a.totalAttempts);
}

function buildRoutesHeat(results: AgentResult[], targetUrl: string, routeHostnames: string[]): RouteHeat[] {
  const base = new URL(targetUrl);
  const sandboxMode = routeHostnames.length > 0;
  const allowedHostnames = allowedRouteHostnames(base.hostname, routeHostnames);
  const map = new Map<string, { visits: number; dwell: number; drops: number }>();
  for (const r of results) {
    const visited: { path: string; tSec: number }[] = [];
    for (const e of r.events) {
      if (!e.url) continue;
      try {
        const u = new URL(e.url);
        if (sandboxMode) {
          if (!allowedHostnames.has(normalizeRouteHostname(u.hostname))) continue;
        } else if (u.origin !== base.origin) {
          continue;
        }
        const path = u.pathname || "/";
        visited.push({ path, tSec: tToSec(e.t) });
      } catch {
        // skip
      }
    }
    for (let i = 0; i < visited.length; i++) {
      const cur = visited[i];
      const next = visited[i + 1];
      const dwell = next ? next.tSec - cur.tSec : 5;
      const slot = map.get(cur.path) || { visits: 0, dwell: 0, drops: 0 };
      slot.visits++;
      slot.dwell += Math.max(0, Math.min(120, dwell));
      if (!next && !r.accomplished) slot.drops++;
      map.set(cur.path, slot);
    }
  }
  return Array.from(map.entries())
    .map(([path, v]) => ({
      path,
      visits: v.visits,
      dwell: Math.round(v.dwell / Math.max(1, v.visits)),
      drop: v.visits ? v.drops / v.visits : 0,
    }))
    .sort((a, b) => b.visits - a.visits)
    .slice(0, 8);
}

function allowedRouteHostnames(targetHostname: string, routeHostnames: string[]): Set<string> {
  const allowed = new Set([normalizeRouteHostname(targetHostname)]);
  for (const hostname of routeHostnames) allowed.add(normalizeRouteHostname(hostname));
  return allowed;
}

function normalizeRouteHostname(hostname: string): string {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "::1" ? "localhost" : h;
}

function buildSentimentCurve(events: Event[]): { t: number; v: number }[] {
  if (events.length === 0) return [];
  const maxT = Math.max(1, tToSec(events[events.length - 1].t));
  // 20 buckets, rolling average sentiment normalized 0..1.
  const buckets: number[][] = Array.from({ length: 21 }, () => []);
  for (const e of events) {
    const t = tToSec(e.t);
    const idx = Math.min(20, Math.floor((t / maxT) * 20));
    buckets[idx].push(e.sentiment);
  }
  let lastV = 0.5;
  return buckets.map((arr, i) => {
    if (arr.length) {
      const avg = arr.reduce((s, x) => s + x, 0) / arr.length;
      lastV = (avg + 3) / 6;     // −3..+3 → 0..1
    }
    return { t: i * 5, v: clamp(lastV, 0, 1) };
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function sevRank(s: "high" | "med" | "low"): number {
  return s === "high" ? 3 : s === "med" ? 2 : 1;
}
function medianSeverity(arr: ("high" | "med" | "low")[]): "high" | "med" | "low" {
  if (arr.length === 0) return "low";
  const ranks = arr.map(sevRank).sort((a, b) => a - b);
  const mid = ranks[Math.floor((ranks.length - 1) / 2)]; // lower median for even counts
  return mid === 3 ? "high" : mid === 2 ? "med" : "low";
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
function tToSec(t: string): number {
  const [m, s, cs] = t.split(":").map(Number);
  return m * 60 + s + (cs || 0) / 100;
}

async function nextRunId(outDir: string): Promise<string> {
  if (!existsSync(outDir)) return "run-001";
  const names = await readdir(outDir);
  let max = 0;
  for (const n of names) {
    const m = n.match(/^run-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `run-${String(max + 1).padStart(3, "0")}`;
}
