// Customer-facing date formats (CG, 2026-11-05): never show a raw
// ISO date to a family. Birthdays and other stored YYYY-MM-DD values
// render as MM/DD/YYYY on cards, or Month Day, Year written out in
// prose and emails.

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parts(iso: string | null | undefined): { y: number; m: number; d: number } | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso).trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return { y, m, d };
}

/** "2021-03-25" -> "03/25/2021". Unparseable input passes through. */
export function formatDateUS(iso: string | null | undefined): string {
  const p = parts(iso);
  if (!p) return iso ? String(iso) : "";
  const mm = String(p.m).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
  return `${mm}/${dd}/${p.y}`;
}

/** "2021-03-25" -> "March 25, 2021". Unparseable input passes through. */
export function formatDateLong(iso: string | null | undefined): string {
  const p = parts(iso);
  if (!p) return iso ? String(iso) : "";
  return `${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}

/** A Date (an order timestamp, a ship date) written out long. */
export function formatDateLongFromDate(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}
