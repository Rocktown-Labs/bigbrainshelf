// Minimal Sentry reporter: posts error events straight to the Sentry
// ingest endpoint using the envelope protocol, with no SDK dependency,
// so the worker bundle stays lean. Used by the middleware for worker
// errors; the browser side lives in components/Tracking.astro and uses
// parseSentryDsn from here at render time. Everything no-ops when no
// DSN is configured.

export interface SentryDsn {
  host: string;
  projectId: string;
  publicKey: string;
  raw: string;
}

export function parseSentryDsn(dsn: string | undefined | null): SentryDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(String(dsn).trim());
    const projectId = u.pathname.replace(/\//g, "");
    if (!u.hostname || !projectId || !u.username) return null;
    return { host: u.host, projectId, publicKey: u.username, raw: String(dsn).trim() };
  } catch {
    return null;
  }
}

function envelopeUrl(d: SentryDsn): string {
  return (
    `https://${d.host}/api/${d.projectId}/envelope/` +
    `?sentry_key=${d.publicKey}&sentry_version=7&sentry_client=bbs-sentry-lite/1.0`
  );
}

export function buildEnvelope(d: SentryDsn, event: Record<string, unknown>): string {
  const payload = JSON.stringify(event);
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    dsn: d.raw,
  });
  const item = JSON.stringify({ type: "event", length: payload.length });
  return `${header}\n${item}\n${payload}`;
}

export async function reportErrorToSentry(
  dsn: string | undefined | null,
  err: unknown,
  extra?: Record<string, unknown>
): Promise<void> {
  const d = parseSentryDsn(dsn);
  if (!d) return;
  const e = err as any;
  const event: Record<string, unknown> = {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: "production",
    exception: {
      values: [
        {
          type: e?.name || "Error",
          value: String(e?.message || e || "Unknown error").slice(0, 500),
        },
      ],
    },
    extra: {
      ...(extra || {}),
      stack: e?.stack ? String(e.stack).slice(0, 4000) : undefined,
    },
  };
  try {
    await fetch(envelopeUrl(d), {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: buildEnvelope(d, event),
    });
  } catch {
    // Error reporting must never throw into request handling.
  }
}
