import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { availabilityFit, computeSuggestions, describeSlot, parseAvailability } from "../src/matching";
import { sampleWaitlist } from "../src/sampleWaitlist";
import type { WaitlistClient } from "../src/types";

describe("parseAvailability (rough tags from free-text notes)", () => {
  const cases: Array<[string, string[], string[]]> = [
    ["weekday afternoons", ["Mon", "Tue", "Wed", "Thu", "Fri"], ["afternoon"]],
    ["after 5", [], ["evening"]],
    ["Tue/Thu mornings", ["Tue", "Thu"], ["morning"]],
    ["Saturdays", ["Sat"], []],
    ["weekdays after 2", ["Mon", "Tue", "Wed", "Thu", "Fri"], ["afternoon", "evening"]],
    ["Mon, Wed, Fri afternoons", ["Mon", "Wed", "Fri"], ["afternoon"]],
    ["not Mondays", ["Sun", "Tue", "Wed", "Thu", "Fri", "Sat"], []],
    ["weekend mornings", ["Sun", "Sat"], ["morning"]],
    ["can make it work if it's before 3", [], ["morning", "afternoon"]],
    ["Mon-Wed evenings", ["Mon", "Tue", "Wed"], ["evening"]],
    ["depends on her shift — text first", [], []],
    // "any time" is about the time of day: named days still limit the days.
    ["Mondays and Wednesdays, any time", ["Mon", "Wed"], ["morning", "afternoon", "evening"]],
    ["Tue anytime", ["Tue"], ["morning", "afternoon", "evening"]],
    ["Saturdays, flexible on time", ["Sat"], ["morning", "afternoon", "evening"]],
    ["anytime", ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], ["morning", "afternoon", "evening"]],
    ["no weekends", ["Mon", "Tue", "Wed", "Thu", "Fri"], []],
    ["except weekends, after 5", ["Mon", "Tue", "Wed", "Thu", "Fri"], ["evening"]],
  ];
  for (const [note, days, parts] of cases) {
    test(`"${note}"`, () => {
      assert.deepEqual(parseAvailability(note), { days, parts });
    });
  }
});

test("describeSlot uses morning<12, afternoon 12–17, evening>=17", () => {
  assert.deepEqual(describeSlot("2026-10-05T11:59"), { day: "Mon", part: "morning", hour: 11 });
  assert.deepEqual(describeSlot("2026-10-05T12:00"), { day: "Mon", part: "afternoon", hour: 12 });
  assert.deepEqual(describeSlot("2026-10-10T17:00"), { day: "Sat", part: "evening", hour: 17 });
});

test("availabilityFit: no tags means 'check-note', not a silent miss", () => {
  assert.equal(availabilityFit({ days: [], parts: [] }, "Mon", "morning"), "check-note");
  assert.equal(availabilityFit({ days: ["Tue"], parts: [] }, "Mon", "morning"), "no");
  assert.equal(availabilityFit({ days: [], parts: ["evening"] }, "Mon", "evening"), "fits");
});

describe("computeSuggestions", () => {
  const waitlist = sampleWaitlist();

  test("same service + stylist rule + rough availability, earliest joiner first", () => {
    const s = computeSuggestions(waitlist, { service: "Haircut", stylist: "Carla", startsAt: "2026-10-05T14:00" });
    assert.deepEqual(
      s.map((m) => m.clientId),
      ["c01", "c04", "c05", "c06", "c07"],
    );
    assert.equal(s.find((m) => m.clientId === "c07")?.checkNote, true, "unparsable note is flagged");
    assert.equal(s.find((m) => m.clientId === "c01")?.prefersThisStylist, true);
    assert.equal(s.find((m) => m.clientId === "c01")?.availabilityNote, "weekday afternoons", "note kept verbatim");
  });

  test("REQUIRED stylist only matches that stylist; ANY stylist matches everyone", () => {
    const lenaEvening = computeSuggestions(waitlist, { service: "Haircut", stylist: "Lena", startsAt: "2026-10-05T18:00" });
    const ids = lenaEvening.map((m) => m.clientId);
    assert.ok(ids.includes("c02"), "requires Lena, after 5");
    assert.ok(!ids.includes("c05"), "requires Carla");
    assert.ok(ids.includes("c09"), "any stylist, weekday evenings");
    const samSaturday = computeSuggestions(waitlist, { service: "Haircut", stylist: "Sam", startsAt: "2026-10-10T10:00" });
    assert.deepEqual(
      samSaturday.map((m) => m.clientId),
      ["c04", "c07", "c08"],
    );
  });

  test("Aisha (Mondays and Wednesdays, any time) is not suggested for a Tuesday or Saturday", () => {
    const tue = computeSuggestions(waitlist, { service: "Color", stylist: "Lena", startsAt: "2026-10-06T10:00" });
    assert.ok(!tue.some((m) => m.clientId === "c13"));
    const mon = computeSuggestions(waitlist, { service: "Color", stylist: "Lena", startsAt: "2026-10-05T16:00" });
    assert.ok(mon.some((m) => m.clientId === "c13"));
  });

  test("opted-out clients are never suggested", () => {
    const c11 = waitlist.find((c) => c.id === "c11");
    assert.equal(c11?.optedOut, true);
    const sat = computeSuggestions(waitlist, { service: "Color", stylist: "Sam", startsAt: "2026-10-10T11:00" });
    assert.ok(!sat.some((m) => m.clientId === "c11"), "c11 (weekends, opted out) is excluded");
    const optedIn = computeSuggestions(
      waitlist.map((c) => (c.id === "c11" ? { ...c, optedOut: false } : c)),
      { service: "Color", stylist: "Sam", startsAt: "2026-10-10T11:00" },
    );
    assert.ok(optedIn.some((m) => m.clientId === "c11"), "same client would match if not opted out");
  });

  test("excludes booked, excluded and busy clients; orders by joinedAt", () => {
    const mk = (id: string, joinedAt: string, status: WaitlistClient["status"] = "waiting"): WaitlistClient => ({
      id,
      name: id,
      mobile: "(555) 010-0000",
      service: "Trim",
      stylistRule: { kind: "any" },
      availabilityNote: "anytime",
      availabilityTags: parseAvailability("anytime"),
      joinedAt,
      status,
    });
    const clients = [
      mk("late", "2026-09-03T00:00:00.000Z"),
      mk("early", "2026-08-01T00:00:00.000Z"),
      mk("booked", "2026-07-01T00:00:00.000Z", "booked"),
      mk("declined", "2026-07-02T00:00:00.000Z"),
      mk("busy", "2026-07-03T00:00:00.000Z"),
      mk("middle", "2026-08-15T00:00:00.000Z"),
    ];
    const s = computeSuggestions(
      clients,
      { service: "Trim", stylist: "Sam", startsAt: "2026-10-06T09:00" },
      { excludeClientIds: ["declined"], busyClientIds: ["busy"] },
    );
    assert.deepEqual(
      s.map((m) => m.clientId),
      ["early", "middle", "late"],
    );
  });
});
