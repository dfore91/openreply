// One-off (2026-10-02): re-send the DMs that Carolina's viral reel skipped on
// the hourly warm-up cap. ~8.8k commenters got the public reply but no DM, and
// the reconciler never goes back for SKIPPED_RATE_LIMIT rows. Instagram allows a
// private reply only within 7 days of the comment, so this drips OLDEST first
// (earliest deadline first), one row per person, paced evenly under the warm-up
// cap with a few slots per hour left for live comments. Bursts are what got the
// account blocked on 09-29/30, so nothing is sent in batches.
//
// Stops on its own when the last 20 minutes show a failure spike, when the pool
// is empty, or when a file named /tmp/resend.stop exists.
import { existsSync } from "node:fs";
import { prisma } from "@/lib/db/client";
import { getDMQueue, getRedisConnection } from "@/lib/queue/client";
import { hourlyCapFor } from "@/lib/utils/rate-limiter";

const ACC = "cmunbkbua001q0kltjbmi3ocj";
const IG = "17841401912988095";
const POST = "18117120322987787";
const TICK_MS = 120_000;
const LIVE_RESERVE = Number(process.env.RESEND_LIVE_RESERVE ?? 5); // slots/hour left for live comments
const WINDOW_MARGIN_MS = 60 * 60 * 1000; // don't attempt comments within 1 h of their 7-day limit
const FAIL_MIN = 5;
const FAIL_RATE = 0.05;

type Row = { commentId: string; commentText: string; commenterId: string; commenterName: string | null };

const recentlyAdded = new Map<string, number>();
let credit = 0;

async function failureCheck(): Promise<{ sent: number; failed: number }> {
  const since = new Date(Date.now() - 20 * 60 * 1000);
  const [sent, failed] = await Promise.all([
    prisma.dmLog.count({ where: { instagramAccountId: ACC, status: "SENT", dmSentAt: { gte: since } } }),
    prisma.dmLog.count({ where: { instagramAccountId: ACC, status: "FAILED", updatedAt: { gte: since } } }),
  ]);
  return { sent, failed };
}

async function pick(limit: number): Promise<Row[]> {
  const oldest = new Date(Date.now() - 7 * 86_400_000 + WINDOW_MARGIN_MS);
  const exclude = [...recentlyAdded.keys()];
  return prisma.$queryRaw<Row[]>`
    select "commentId", "commentText", "commenterId", "commenterName" from (
      select distinct on (d."commenterId") d."commentId", d."commentText", d."commenterId", d."commenterName", d."createdAt"
      from openreply."DmLog" d
      where d."instagramAccountId" = ${ACC}
        and d.status = 'SKIPPED_RATE_LIMIT'
        and d."dmDeliveryUnconfirmed" = false
        and d."createdAt" > ${oldest}
        and not (d."commentId" = any(${exclude}::text[]))
        and not exists (
          select 1 from openreply."DmLog" s
          where s."instagramAccountId" = d."instagramAccountId" and s."commenterId" = d."commenterId" and s.status = 'SENT')
      order by d."commenterId", d."createdAt" asc
    ) t order by "createdAt" asc limit ${limit}`;
}

async function tick(): Promise<boolean> {
  if (existsSync("/tmp/resend.stop")) {
    console.log(`${new Date().toISOString()} stop file found, exiting`);
    return false;
  }
  const { sent, failed } = await failureCheck();
  if (failed >= FAIL_MIN && failed / Math.max(1, sent + failed) > FAIL_RATE) {
    console.log(`${new Date().toISOString()} KILL: ${failed} failed vs ${sent} sent in 20 min`);
    return false;
  }

  const now = Date.now();
  for (const [id, t] of recentlyAdded) if (now - t > 60 * 60 * 1000) recentlyAdded.delete(id);

  const cap = hourlyCapFor(IG);
  const used = Number((await getRedisConnection().get(`rate:dm:${IG}`)) ?? 0);
  credit = Math.min(credit + ((cap - LIVE_RESERVE) * TICK_MS) / 3_600_000, 3);
  const room = Math.max(0, cap - LIVE_RESERVE - used);
  const n = Math.min(Math.floor(credit), room);
  if (n <= 0) {
    console.log(`${new Date().toISOString()} cap=${cap} used=${used} wait`);
    return true;
  }

  const rows = await pick(n);
  if (rows.length === 0) {
    console.log(`${new Date().toISOString()} pool empty, exiting`);
    return false;
  }
  const q = getDMQueue();
  const gap = TICK_MS / rows.length;
  for (const [i, r] of rows.entries()) {
    await q.add(
      "process-comment",
      {
        accountConnectionId: ACC,
        instagramAccountId: IG,
        commentId: r.commentId,
        commentText: r.commentText,
        commenterId: r.commenterId,
        commenterName: r.commenterName ?? undefined,
        mediaId: POST,
        source: "POLLING",
        // At the cap the worker marks it skipped again instead of queueing
        // 30-minute retries; the next tick picks it back up.
        requeueAttempt: 3,
      },
      { delay: Math.round(i * gap), jobId: `resend_${r.commentId}_${now}` }
    );
    recentlyAdded.set(r.commentId, now);
  }
  credit -= rows.length;
  console.log(`${new Date().toISOString()} cap=${cap} used=${used} queued=${rows.length} last20m sent=${sent} failed=${failed}`);
  return true;
}

async function main() {
  console.log(`${new Date().toISOString()} resend drip start, cap=${hourlyCapFor(IG)}`);
  for (;;) {
    let keepGoing = true;
    try {
      keepGoing = await tick();
    } catch (e) {
      console.error(`${new Date().toISOString()} tick error`, e);
    }
    if (!keepGoing) break;
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
  await getDMQueue().close();
  await prisma.$disconnect();
  process.exit(0);
}
main();
