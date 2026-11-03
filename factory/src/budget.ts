// ---------------------------------------------------- budget coordination
//
// Cross-run per-book budget, held in a Durable Object (one instance per
// book slug). Built 2026-11-01 from the merged factory-scale plan: the
// per-run spend cap (spendCapHit in bookbuild.ts) resets every time a
// new run starts, so a book's TOTAL spend across runs was unbounded.
// This counter survives runs: it is only cleared by an explicit reset
// through the budget route.
//
// Protocol (the DO serializes every call, so check-and-record is
// atomic):
//   gate(est)   before a paid roll: reserve the estimate when
//               spent + reserved + est fits the book's budget, else
//               deny and the caller holds the page (budget_capped).
//   settle(actual)
//               after the roll's real cost is known (logGenAttempt is
//               the single choke point every paid roll reports
//               through): release the OLDEST reservation, add the
//               actual. Reservations older than 15 minutes expire on
//               the next gate, so a crashed step or a gateway error
//               can never wedge a book's budget forever.
// Rolls that never pass a gate (covers via index routes, legacy paths)
// still settle, so their spend lands in the same counter.
//
// Everything here is fail-open by design: a missing binding or a DO
// error must never brick generation. The per-run cap still applies
// underneath, and every denial is archived as a budget_capped attempt.

import { DurableObject } from "cloudflare:workers";

export const ROLL_EST_USD = 0.07; // observed rolls: $0.039-$0.065
export const DEFAULT_BOOK_BUDGET_USD = 10;
const RESERVATION_TTL_S = 900;

interface BudgetLogEntry {
  ts: number;
  type: string;
  amount: number;
  spent: number;
}

interface BudgetState {
  budgetUsd: number | null;
  spentUsd: number;
  open: { ts: number; est: number }[];
  periodStartedAt: number;
  log: BudgetLogEntry[];
}

const freshState = (): BudgetState => ({
  budgetUsd: null,
  spentUsd: 0,
  open: [],
  periodStartedAt: Math.floor(Date.now() / 1000),
  log: [],
});

const reservedOf = (s: BudgetState): number => s.open.reduce((a, r) => a + r.est, 0);

export class BudgetCoordinator extends DurableObject {
  private async load(): Promise<BudgetState> {
    return (await this.ctx.storage.get<BudgetState>("state")) ?? freshState();
  }

  private async save(s: BudgetState, type: string, amount: number): Promise<void> {
    s.log.push({ ts: Math.floor(Date.now() / 1000), type, amount, spent: s.spentUsd });
    if (s.log.length > 30) s.log = s.log.slice(-30);
    await this.ctx.storage.put("state", s);
  }

  private purgeStale(s: BudgetState): void {
    const cutoff = Math.floor(Date.now() / 1000) - RESERVATION_TTL_S;
    s.open = s.open.filter((r) => r.ts >= cutoff);
  }

  private view(s: BudgetState) {
    const reserved = reservedOf(s);
    return {
      budgetUsd: s.budgetUsd,
      spentUsd: Math.round(s.spentUsd * 1e6) / 1e6,
      reservedUsd: Math.round(reserved * 1e6) / 1e6,
      remainingUsd:
        s.budgetUsd == null
          ? null
          : Math.round((s.budgetUsd - s.spentUsd - reserved) * 1e6) / 1e6,
      openReservations: s.open.length,
      periodStartedAt: s.periodStartedAt,
      log: s.log.slice(-10),
    };
  }

  async gate(estUsd: number, defaultBudgetUsd: number) {
    const s = await this.load();
    this.purgeStale(s);
    if (s.budgetUsd == null) s.budgetUsd = defaultBudgetUsd;
    if (s.spentUsd + reservedOf(s) + estUsd > s.budgetUsd) {
      await this.save(s, "gate_denied", estUsd);
      return { ok: false, ...this.view(s) };
    }
    s.open.push({ ts: Math.floor(Date.now() / 1000), est: estUsd });
    await this.save(s, "reserve", estUsd);
    return { ok: true, ...this.view(s) };
  }

  async settle(actualUsd: number) {
    const s = await this.load();
    if (s.open.length) s.open.shift();
    s.spentUsd += actualUsd;
    await this.save(s, "settle", actualUsd);
    return this.view(s);
  }

  async status(defaultBudgetUsd?: number) {
    const s = await this.load();
    this.purgeStale(s);
    if (s.budgetUsd == null && typeof defaultBudgetUsd === "number") {
      // display with the effective budget; the gate persists it on first use
      return this.view({ ...s, budgetUsd: defaultBudgetUsd });
    }
    return this.view(s);
  }

  async setBudget(usd: number | null) {
    const s = await this.load();
    s.budgetUsd = usd;
    await this.save(s, "set_budget", usd ?? 0);
    return this.view(s);
  }

  async reset() {
    const s = await this.load();
    s.spentUsd = 0;
    s.open = [];
    s.periodStartedAt = Math.floor(Date.now() / 1000);
    await this.save(s, "reset", 0);
    return this.view(s);
  }

  // One reserve+settle of $0.01 against this instance: proves the
  // counter end to end without touching a model. Adds one cent of
  // TEST spend to this instance's ledger; only ever fired on demand.
  async testCycle(defaultBudgetUsd: number) {
    const g: any = await this.gate(0.01, defaultBudgetUsd);
    if (!g.ok) return { cycled: false, ...g };
    const v: any = await this.settle(0.01);
    return { cycled: true, ...v };
  }
}

// ------------------------------------------------------- worker-side API

export interface BudgetEnvLike {
  BUDGET?: DurableObjectNamespace;
  DB: D1Database;
}

function stub(env: BudgetEnvLike, slug: string): any {
  const ns = env.BUDGET as any;
  return ns.get(ns.idFromName(slug));
}

async function defaultBudgetFor(env: BudgetEnvLike, slug: string): Promise<number> {
  try {
    const row: any = await env.DB.prepare(
      "SELECT spend_cap_usd FROM books WHERE slug=?"
    )
      .bind(slug)
      .first();
    return typeof row?.spend_cap_usd === "number" && row.spend_cap_usd > 0
      ? row.spend_cap_usd
      : DEFAULT_BOOK_BUDGET_USD;
  } catch {
    return DEFAULT_BOOK_BUDGET_USD;
  }
}

// The budget in force when the next roll must hold, else null (same
// contract as spendCapHit). Fail-open: any error returns null.
export async function budgetGate(env: BudgetEnvLike, slug: string): Promise<number | null> {
  if (!env.BUDGET) return null;
  try {
    const def = await defaultBudgetFor(env, slug);
    const r: any = await stub(env, slug).gate(ROLL_EST_USD, def);
    return r?.ok ? null : (r?.budgetUsd ?? def);
  } catch (e) {
    console.log(`budget gate error for ${slug} (failing open): ${String((e as any)?.message ?? e)}`);
    return null;
  }
}

// Record a paid roll's real cost against the book's counter. Silent on
// error: D1 gen_attempts remains the durable record.
export async function budgetSettle(env: BudgetEnvLike, slug: string, actualUsd: number): Promise<void> {
  if (!env.BUDGET) return;
  try {
    await stub(env, slug).settle(actualUsd);
  } catch {
    // best-effort, like all factory metering
  }
}

export async function budgetAdmin(
  env: BudgetEnvLike,
  slug: string,
  action: string,
  value?: number | null
): Promise<any> {
  if (!env.BUDGET) return { error: "BUDGET binding not configured" };
  const s = stub(env, slug);
  const def = await defaultBudgetFor(env, slug);
  switch (action) {
    case "status":
      return await s.status(def);
    case "set_budget":
      return await s.setBudget(typeof value === "number" && value > 0 ? value : null);
    case "reset":
      return await s.reset();
    case "test_cycle":
      return await s.testCycle(def);
    default:
      return { error: `unknown budget action: ${action}` };
  }
}
