// Lulu print-on-demand API client (Print Job API).
//
// The store stays the seller of record: the customer pays us through
// Stripe, and Lulu charges our card per print job. This module is the
// thin client the fulfillment lane (lib/print-fulfillment) drives:
// OAuth2 client-credentials auth, print job create / read / status /
// cancel, and the cost-calculation endpoint checkout will price from.
//
// Configuration is env-only, mirroring the Shippo presence gate:
//   FULFILLMENT_PROVIDER  the lane is active only when this is "lulu"
//   LULU_ENV              "sandbox" (default) or "production"
//   LULU_SANDBOX_CLIENT_ID / LULU_SANDBOX_CLIENT_SECRET
//   LULU_CLIENT_ID / LULU_CLIENT_SECRET          (production pair)
// With the provider unset or the selected pair missing, every entry
// point here is inert and home (Shippo) fulfillment keeps the road.

export type LuluEnvName = "sandbox" | "production";

const LULU_BASES: Record<LuluEnvName, string> = {
  sandbox: "https://api.sandbox.lulu.com",
  production: "https://api.lulu.com",
};

/** Which Lulu environment this worker talks to (default sandbox). */
export function luluEnvName(e: any): LuluEnvName {
  return String(e?.LULU_ENV || "").trim().toLowerCase() === "production"
    ? "production"
    : "sandbox";
}

function luluCreds(e: any): { clientId: string; clientSecret: string } | null {
  const name = luluEnvName(e);
  const clientId = String(
    (name === "production" ? e?.LULU_CLIENT_ID : e?.LULU_SANDBOX_CLIENT_ID) || ""
  ).trim();
  const clientSecret = String(
    (name === "production" ? e?.LULU_CLIENT_SECRET : e?.LULU_SANDBOX_CLIENT_SECRET) || ""
  ).trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * The lane gate (shippoConfigured's shape): the fulfillment provider
 * flag must say "lulu" AND the selected environment's credential
 * pair must be present. Anything less and the lane is off.
 */
export function luluConfigured(e: any): boolean {
  return String(e?.FULFILLMENT_PROVIDER || "").trim().toLowerCase() === "lulu" && !!luluCreds(e);
}

/** Just the credential-pair half of the gate (admin setup displays). */
export function luluCredsPresent(e: any): boolean {
  return !!luluCreds(e);
}

export class LuluError extends Error {
  status: number;
  bodyExcerpt: string;
  constructor(status: number, message: string, bodyExcerpt = "") {
    super(message);
    this.name = "LuluError";
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

// Access-token cache: one entry per (environment, client id), kept
// in module memory with its expiry. Tokens live about an hour; we
// refresh a minute early so a long cron pass never rides a dead one.
const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

export function __clearLuluTokenCacheForTests(): void {
  tokenCache.clear();
}

async function luluToken(e: any): Promise<string> {
  const creds = luluCreds(e);
  if (!creds) throw new LuluError(0, "Lulu credentials are not configured for this environment.");
  const name = luluEnvName(e);
  const cacheKey = `${name}|${creds.clientId}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAtMs > Date.now() + 60_000) return hit.token;
  const base = LULU_BASES[name];
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  let res: Response;
  try {
    res = await fetch(`${base}/auth/realms/glasstree/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err: any) {
    throw new LuluError(0, `Lulu token request failed: ${err?.message || err}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new LuluError(res.status, `Lulu token request returned ${res.status}`, text.slice(0, 400));
  }
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* handled below */ }
  const token = String(parsed?.access_token || "");
  if (!token) throw new LuluError(res.status, "Lulu token response carried no access_token", text.slice(0, 400));
  const ttlSec = Number(parsed?.expires_in || 3600);
  tokenCache.set(cacheKey, { token, expiresAtMs: Date.now() + Math.max(60, ttlSec) * 1000 });
  return token;
}

/** One authenticated API call. Returns the parsed JSON body. */
export async function luluApi(e: any, method: string, path: string, body?: any): Promise<any> {
  const base = LULU_BASES[luluEnvName(e)];
  const token = await luluToken(e);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err: any) {
    throw new LuluError(0, `Lulu ${method} ${path} failed: ${err?.message || err}`);
  }
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  if (!res.ok) {
    throw new LuluError(
      res.status,
      `Lulu ${method} ${path} returned ${res.status}`,
      text.slice(0, 600)
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Address handling. Lulu's limits: name 35 chars, street lines and
// city 30, phone 20. We hard-truncate to the limit (Lulu rejects
// longer values outright) and report what was cut so the caller can
// note it on the job row.

export interface LuluAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state_code: string;
  postcode: string;
  country_code: string;
  phone_number?: string;
}

const LULU_LIMITS = { name: 35, street: 30, city: 30, phone: 20 } as const;

export function normalizeLuluAddress(input: {
  name?: string | null;
  line1?: string | null;
  street1?: string | null;
  line2?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  state_code?: string | null;
  postal_code?: string | null;
  postcode?: string | null;
  zip?: string | null;
  country?: string | null;
  country_code?: string | null;
  phone?: string | null;
  phone_number?: string | null;
}): { address: LuluAddress; warnings: string[] } {
  const warnings: string[] = [];
  const cut = (label: string, value: string, limit: number): string => {
    const v = String(value || "").trim();
    if (v.length > limit) {
      warnings.push(`${label} was shortened to fit Lulu's ${limit}-character limit`);
      return v.slice(0, limit);
    }
    return v;
  };
  const address: LuluAddress = {
    name: cut("Recipient name", String(input.name || ""), LULU_LIMITS.name),
    street1: cut("Street address", String(input.line1 || input.street1 || ""), LULU_LIMITS.street),
    city: cut("City", String(input.city || ""), LULU_LIMITS.city),
    state_code: String(input.state_code || input.state || "").trim().toUpperCase(),
    postcode: String(input.postcode || input.postal_code || input.zip || "").trim(),
    country_code: String(input.country_code || input.country || "US").trim().toUpperCase() || "US",
  };
  const line2 = cut("Street address line 2", String(input.line2 || input.street2 || ""), LULU_LIMITS.street);
  if (line2) address.street2 = line2;
  const phone = cut("Phone", String(input.phone_number || input.phone || ""), LULU_LIMITS.phone);
  if (phone) address.phone_number = phone;
  return { address, warnings };
}

// ---------------------------------------------------------------------------
// Print jobs

export interface LuluLineItemInput {
  externalId: string;
  title: string;
  podPackageId: string;
  interiorUrl: string;
  coverUrl: string;
  quantity?: number;
}

export interface LuluCreateJobInput {
  contactEmail: string;
  externalId: string;
  lineItems: LuluLineItemInput[];
  shippingAddress: LuluAddress;
  shippingLevel?: string;
  productionDelay?: number;
}

/** The exact POST /print-jobs/ body for a create input. */
export function buildCreateJobBody(input: LuluCreateJobInput): any {
  return {
    contact_email: input.contactEmail,
    external_id: input.externalId,
    line_items: input.lineItems.map((li) => ({
      external_id: li.externalId,
      printable_normalization: {
        cover: { source_url: li.coverUrl },
        interior: { source_url: li.interiorUrl },
        pod_package_id: li.podPackageId,
      },
      quantity: li.quantity ?? 1,
      title: li.title,
    })),
    production_delay: input.productionDelay ?? 120,
    shipping_address: input.shippingAddress,
    shipping_level: input.shippingLevel || "MAIL",
  };
}

export async function createPrintJob(e: any, input: LuluCreateJobInput): Promise<any> {
  return luluApi(e, "POST", "/print-jobs/", buildCreateJobBody(input));
}

export async function getPrintJob(e: any, jobId: string | number): Promise<any> {
  return luluApi(e, "GET", `/print-jobs/${encodeURIComponent(String(jobId))}/`);
}

export async function getPrintJobStatus(e: any, jobId: string | number): Promise<any> {
  return luluApi(e, "GET", `/print-jobs/${encodeURIComponent(String(jobId))}/status/`);
}

/** Cancel works while the job is UNPAID or inside its production delay. */
export async function cancelPrintJob(e: any, jobId: string | number): Promise<any> {
  return luluApi(e, "PUT", `/print-jobs/${encodeURIComponent(String(jobId))}/status/`, {
    name: "CANCELED",
  });
}

// ---------------------------------------------------------------------------
// Cost calculations (checkout pricing lands in slice 2; the client
// method ships now so the shape is pinned by tests).

export interface LuluCostLineItem {
  pageCount: number;
  podPackageId: string;
  quantity?: number;
}

export interface LuluCostBreakdown {
  currency: string | null;
  fulfillmentCost: string | null;
  shippingCost: string | null;
  totalCostExclTax: string | null;
  totalTax: string | null;
  totalCostInclTax: string | null;
  lineItemCosts: any[];
  raw: any;
}

/** Parse a cost-calculation response into named string-decimal fields. */
export function parseCostCalculation(raw: any): LuluCostBreakdown {
  const costs = raw?.costs || raw || {};
  const str = (v: any): string | null => (v === null || v === undefined ? null : String(v));
  return {
    currency: str(costs.currency),
    fulfillmentCost: str(costs.fulfillment_cost?.total_cost_incl_tax ?? costs.fulfillment_cost),
    shippingCost: str(costs.shipping_cost?.total_cost_incl_tax ?? costs.shipping_cost),
    totalCostExclTax: str(costs.total_cost_excl_tax),
    totalTax: str(costs.total_tax),
    totalCostInclTax: str(costs.total_cost_incl_tax),
    lineItemCosts: Array.isArray(costs.line_item_costs) ? costs.line_item_costs : [],
    raw,
  };
}

export async function costCalculation(
  e: any,
  args: {
    lineItems: LuluCostLineItem[];
    shippingAddress: LuluAddress;
    shippingOption?: string;
  }
): Promise<LuluCostBreakdown> {
  const raw = await luluApi(e, "POST", "/print-job-cost-calculations/", {
    line_items: args.lineItems.map((li) => ({
      page_count: li.pageCount,
      pod_package_id: li.podPackageId,
      quantity: li.quantity ?? 1,
    })),
    shipping_address: args.shippingAddress,
    shipping_option: args.shippingOption || "MAIL",
  });
  return parseCostCalculation(raw);
}

/** Job-level Lulu statuses after which nothing further will change. */
export const LULU_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "DELIVERED",
  "REJECTED",
  "ERROR",
  "CANCELED",
]);

export function luluStatusName(status: any): string {
  if (!status) return "";
  if (typeof status === "string") return status.toUpperCase();
  return String(status.name || "").toUpperCase();
}
