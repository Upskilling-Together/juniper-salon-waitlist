import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { TEXTING_HOURS } from "../src/rules";
import { computeTextingWindow, fixedOffsetClock } from "../src/textingHours";

// A salon clock 7 hours behind UTC; `at("2026-10-05T21:00")` is that salon-local time as epoch ms.
const clock = fixedOffsetClock(-7 * 3600_000);
const at = (local: string) => {
  const [y, mo, d, h, mi] = local.split(/[-T:]/).map(Number);
  return clock.toMs({ y, mo, d, h, mi });
};
const check = (local: string, startsAt: string, fastDemo = false) =>
  computeTextingWindow({ nowMs: at(local), startsAt, fastDemo, cutoffAt: at("2026-10-06T08:30") }, clock);

describe("texting hours (salon local time)", () => {
  test("hours are 9:00 AM–8:00 PM (Lena: \"sounds about right\")", () => {
    assert.deepEqual({ ...TEXTING_HOURS }, { start: "09:00", end: "20:00", label: "9:00 AM–8:00 PM" });
  });

  test("inside hours: send now", () => {
    const w = check("2026-10-05T09:00", "2026-10-07T14:00");
    assert.equal(w.canSendNow, true);
    assert.equal(w.withinHours, true);
    assert.equal(w.nowLocal, "2026-10-05T09:00");
    assert.equal(check("2026-10-05T19:59", "2026-10-07T14:00").canSendNow, true);
    assert.equal(w.hoursEndAt, at("2026-10-05T20:00"), "a send must be out before texting hours end");
    assert.equal(check("2026-10-05T22:30", "2026-10-05T23:30").hoursEndAt, undefined, "same-day: no end");
  });

  test("8:00 PM or later: wait until 9:00 AM tomorrow", () => {
    const w = check("2026-10-05T20:00", "2026-10-07T14:00");
    assert.equal(w.canSendNow, false);
    assert.equal(w.nextAllowedAt, at("2026-10-06T09:00"));
    assert.equal(w.nextAllowedLabel, "9:00 AM tomorrow");
    assert.equal(w.cutoffLabel, "8:30 AM tomorrow");
    assert.equal(check("2026-10-06T07:00", "2026-10-07T14:00").cutoffLabel, "8:30 AM");
    assert.equal(check("2026-10-03T12:00", "2026-10-07T14:00").cutoffLabel, "Tue Oct 6, 8:30 AM");
  });

  test("early morning: wait until 9:00 AM today", () => {
    const w = check("2026-10-05T06:30", "2026-10-07T14:00");
    assert.equal(w.nextAllowedAt, at("2026-10-05T09:00"));
    assert.equal(w.nextAllowedLabel, "9:00 AM");
  });

  test("same-day openings and Fast demo ignore texting hours", () => {
    const same = check("2026-10-05T22:30", "2026-10-05T23:30");
    assert.deepEqual([same.canSendNow, same.sameDay, same.bypass], [true, true, "same_day"]);
    const demo = check("2026-10-05T23:00", "2026-10-07T14:00", true);
    assert.deepEqual([demo.canSendNow, demo.bypass], [true, "fast_demo"]);
  });

  test("a next-day opening waits for 9:00 AM, not midnight", () => {
    const w = check("2026-10-05T21:00", "2026-10-06T10:00");
    assert.equal(w.sameDay, false);
    assert.equal(w.nextAllowedAt, at("2026-10-06T09:00"));
  });
});
