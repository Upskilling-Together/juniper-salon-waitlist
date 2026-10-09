// Texting-hours arithmetic in SALON LOCAL time. Used by the textingWindow Activity (never by
// Workflow code, which must stay deterministic). The Workflow passes in its own clock (nowMs).
import { formatSlot } from "./format";
import { TEXTING_HOURS } from "./rules";
import type { TextingWindow } from "./types";

export type LocalParts = { y: number; mo: number; d: number; h: number; mi: number };

/** Converts between epoch ms and the salon's wall clock. */
export type LocalClock = {
  parts(ms: number): LocalParts;
  toMs(p: LocalParts): number;
};

/** The process's own timezone — the API and Worker run in the salon's timezone (same as the API's date parsing). */
export const systemClock: LocalClock = {
  parts(ms) {
    const d = new Date(ms);
    return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes() };
  },
  toMs: ({ y, mo, d, h, mi }) => new Date(y, mo - 1, d, h, mi).getTime(),
};

/** A clock with a fixed offset from UTC (tests use it to put "now" at a chosen salon-local time). */
export function fixedOffsetClock(offsetMs: number): LocalClock {
  return {
    parts(ms) {
      const d = new Date(ms + offsetMs);
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
    },
    toMs: ({ y, mo, d, h, mi }) => Date.UTC(y, mo - 1, d, h, mi) - offsetMs,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (s: string) => s.split(":").map(Number) as [number, number];
const dateKey = (p: Pick<LocalParts, "y" | "mo" | "d">) => `${p.y}-${pad(p.mo)}-${pad(p.d)}`;

function time12(h: number, mi: number): string {
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(mi)} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Can an offer text go out now?
 * - Fast demo: always (labelled "Fast demo ignores texting hours").
 * - Same-day opening (its date is today, salon time): always.
 * - Otherwise only inside TEXTING_HOURS; if not, `nextAllowedAt` is the next texting-hours start.
 *   We deliberately wake at the next 9:00 AM rather than at midnight (when a next-day opening
 *   technically becomes same-day), so a wait never ends in a midnight text.
 */
export function computeTextingWindow(
  input: { nowMs: number; startsAt: string; fastDemo: boolean; cutoffAt?: number },
  clock: LocalClock = systemClock,
): TextingWindow {
  const now = clock.parts(input.nowMs);
  const cutoffLabel = input.cutoffAt !== undefined ? dayTimeLabel(input.cutoffAt, input.nowMs, clock) : undefined;
  const nowLocal = `${dateKey(now)}T${pad(now.h)}:${pad(now.mi)}`;
  const sameDay = input.startsAt.slice(0, 10) === dateKey(now);
  const [sh, sm] = hm(TEXTING_HOURS.start);
  const [eh, em] = hm(TEXTING_HOURS.end);
  const minutes = now.h * 60 + now.mi;
  const withinHours = minutes >= sh * 60 + sm && minutes < eh * 60 + em;
  const bypass = input.fastDemo ? "fast_demo" : sameDay ? "same_day" : null;
  const base = { nowLocal, sameDay, withinHours, bypass, ...(cutoffLabel ? { cutoffLabel } : {}) } as const;
  if (bypass) return { ...base, canSendNow: true };
  if (withinHours) return { ...base, canSendNow: true, hoursEndAt: clock.toMs({ ...now, h: eh, mi: em }) };

  const beforeStart = minutes < sh * 60 + sm;
  // Next texting-hours start: later today (early morning) or tomorrow. Date math via the clock keeps DST right.
  let next = clock.toMs({ ...now, h: sh, mi: sm });
  let tomorrow = false;
  if (!beforeStart) {
    const noonTomorrow = clock.parts(clock.toMs({ ...now, h: 12, mi: 0 }) + 24 * 3600 * 1000);
    next = clock.toMs({ ...noonTomorrow, h: sh, mi: sm });
    tomorrow = true;
  }
  return {
    ...base,
    canSendNow: false,
    nextAllowedAt: next,
    nextAllowedLabel: `${time12(sh, sm)}${tomorrow ? " tomorrow" : ""}`,
  };
}

/**
 * "8:30 AM" when `ms` is on the same salon-local day as `nowMs`, "8:30 AM tomorrow" for the next day,
 * otherwise "Sat Oct 17, 8:30 AM" — so a later-week cutoff never reads like today.
 */
export function dayTimeLabel(ms: number, nowMs: number, clock: LocalClock = systemClock): string {
  const p = clock.parts(ms);
  const time = time12(p.h, p.mi);
  const today = clock.parts(nowMs);
  if (dateKey(p) === dateKey(today)) return time;
  const tomorrow = clock.parts(clock.toMs({ ...today, h: 12, mi: 0 }) + 24 * 3600 * 1000);
  if (dateKey(p) === dateKey(tomorrow)) return `${time} tomorrow`;
  return formatSlot(`${dateKey(p)}T${pad(p.h)}:${pad(p.mi)}`);
}

/** "8:30 AM" style label for an epoch time in salon local time (used in history lines). */
export function localTimeLabel(ms: number, clock: LocalClock = systemClock): string {
  const p = clock.parts(ms);
  return time12(p.h, p.mi);
}
