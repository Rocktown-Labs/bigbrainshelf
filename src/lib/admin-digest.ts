// Daily admin urgency digest (CG, 2026-11-02): the dashboard can
// only warn someone who opens it. Once a day, when the urgency
// queries find something, this queues one plain summary email to
// each admin address through the normal outbox. The dedupe key
// (one per recipient per Chicago day) makes the once-a-day rule
// hold at the database level even though the scheduler runs every
// 15 minutes. Quiet days send nothing.
import { ADMIN_EMAILS } from "./admins";
import { chicagoDayStartSec } from "./admin-dashboard";
import { enqueueEmail } from "./orders";
import { AGED_ORDER_DAYS, getUrgency } from "./urgency";

export async function runAdminDigest(
  db: any,
  now: Date = new Date()
): Promise<{ queued: number; urgentTotal: number }> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const dayStart = chicagoDayStartSec(nowSec);
  const todayIso = new Date(dayStart * 1000).toISOString().slice(0, 10);
  const u = await getUrgency(db, nowSec, todayIso);
  if (u.total === 0) return { queued: 0, urgentTotal: 0 };

  const lines: string[] = ["Here is what needs attention at Big Brain Shelf today:", ""];
  if (u.overdueBoxCount > 0) {
    lines.push(
      `- ${u.overdueBoxCount} club ${u.overdueBoxCount === 1 ? "box" : "boxes"} past the ship date.` +
        (u.overdueBoxes[0]
          ? ` The oldest was due ${u.overdueBoxes[0].shipDate}, ${u.overdueBoxes[0].daysOverdue} days overdue.`
          : "")
    );
  }
  if (u.agedOrderCount > 0) {
    lines.push(
      `- ${u.agedOrderCount} printed ${u.agedOrderCount === 1 ? "order" : "orders"} waiting ${AGED_ORDER_DAYS}+ days to ship.` +
        (u.agedOrders[0] ? ` The oldest has waited ${u.agedOrders[0].ageDays} days.` : "")
    );
  }
  if (u.boxesDueSoon > 0) {
    lines.push(
      `- ${u.boxesDueSoon} club ${u.boxesDueSoon === 1 ? "box ships" : "boxes ship"} within 2 days and ${u.boxesDueSoon === 1 ? "is" : "are"} not being prepared yet.`
    );
  }
  if (u.failedChanges > 0) {
    lines.push(
      `- ${u.failedChanges} page ${u.failedChanges === 1 ? "fix" : "fixes"} failed. Those pages kept their old art.`
    );
  }
  lines.push("", "Details are on the admin dashboard: https://bigbrainshelf.com/admin");

  const subject = `Big Brain Shelf: ${u.total} urgent ${u.total === 1 ? "item" : "items"} need attention`;
  let queued = 0;
  for (const to of ADMIN_EMAILS) {
    await enqueueEmail(db, {
      orderId: null,
      kind: "admin_digest",
      to,
      subject,
      text: lines.join("\n"),
      dedupeKey: `admin_digest:${todayIso}:${to}`,
    });
    queued += 1;
  }
  return { queued, urgentTotal: u.total };
}
