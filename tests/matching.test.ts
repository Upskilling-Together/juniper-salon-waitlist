import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { availabilityFit, computeSuggestions, describeSlot, notTextableReason, parseAvailability } from "../src/matching";
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
    assert.ok(ids.includes("c06"), "any stylist, weekdays after 2");
    assert.ok(!ids.includes("c09"), "weekday evenings fits, but never asked about texts");
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

  test("only clients who OPTED IN to texts are suggested (opted out and not asked yet are not)", () => {
    const consent = (id: string) => waitlist.find((c) => c.id === id)?.textingConsent;
    assert.equal(consent("c11"), "opted_out");
    assert.equal(consent("c16"), "not_asked");
    const opening = { service: "Color", stylist: "Sam", startsAt: "2026-10-10T11:00" } as const;
    const sat = computeSuggestions(waitlist, opening);
    assert.ok(!sat.some((m) => m.clientId === "c11"), "c11 (weekends, opted out) is excluded");
    assert.ok(!sat.some((m) => m.clientId === "c16"), "c16 (Saturdays, not asked yet) is excluded");
    const optedIn = computeSuggestions(
      waitlist.map((c) => (c.id === "c11" || c.id === "c16" ? { ...c, textingConsent: "opted_in" as const } : c)),
      opening,
    );
    assert.deepEqual(
      optedIn.filter((m) => m.clientId === "c11" || m.clientId === "c16").map((m) => m.clientId),
      ["c11", "c16"],
      "the same clients match once they opt in",
    );
  });

  test("services are Haircut, Color and Blowout; old Highlights/Trim clients are Color/Haircut", () => {
    assert.deepEqual([...new Set(waitlist.map((c) => c.service))].sort(), ["Blowout", "Color", "Haircut"]);
    assert.equal(waitlist.find((c) => c.id === "c15")?.service, "Color", "was Highlights");
    assert.equal(waitlist.find((c) => c.id === "c22")?.service, "Haircut", "was Trim");
    assert.equal(waitlist.length, 24);
    assert.ok(waitlist.every((c) => /^\(555\) 010-01\d\d$/.test(c.mobile)), "fictional 555 numbers");
  });

  test("'Only <stylist>' rules are spread across all five stylists", () => {
    const only = new Map<string, number>();
    for (const c of waitlist) if (c.stylistRule.kind === "required") only.set(c.stylistRule.stylist, (only.get(c.stylistRule.stylist) ?? 0) + 1);
    assert.deepEqual([...only.keys()].sort(), ["Carla", "Jules", "Lena", "Nico", "Sam"]);
    const stylists = new Set(["Lena", "Carla", "Sam", "Jules", "Nico"]);
    for (const c of waitlist) assert.ok(!stylists.has(c.name.split(" ")[0]), `${c.name} doesn't share a stylist's name`);
  });

  test("matching with the new stylists: Jules and Nico", () => {
    // Thu 6 PM Haircut with Nico: Marcus (Only Nico, Thursday evenings) + any-stylist evening clients.
    const nico = computeSuggestions(waitlist, { service: "Haircut", stylist: "Nico", startsAt: "2026-10-08T18:00" });
    assert.deepEqual(nico.map((m) => m.clientId), ["c04", "c06", "c07", "c24"]);
    // Tue 10 AM Haircut with Jules: Bella (Only Jules, not Mondays) + morning people; Theo prefers Jules but wants afternoons.
    const jules = computeSuggestions(waitlist, { service: "Haircut", stylist: "Jules", startsAt: "2026-10-06T10:00" });
    assert.deepEqual(jules.map((m) => m.clientId), ["c03", "c22", "c04", "c07", "c23"]);
    // Fri 3 PM Color with Nico: Ruby (Only Nico, Fri only) and Grace (any stylist, before 3 => afternoon).
    const color = computeSuggestions(waitlist, { service: "Color", stylist: "Nico", startsAt: "2026-10-09T15:00" });
    assert.deepEqual(color.map((m) => m.clientId), ["c17", "c14"]);
    // Daniel prefers Nico (any stylist) => flagged when Nico has a weekend-morning Blowout.
    const blow = computeSuggestions(waitlist, { service: "Blowout", stylist: "Nico", startsAt: "2026-10-10T09:00" });
    assert.equal(blow.find((m) => m.clientId === "c20")?.prefersThisStylist, true);
  });

  let nextNumber = 300;
  const mk = (
      id: string,
      joinedAt: string,
      status: WaitlistClient["status"] = "waiting",
      textingConsent: WaitlistClient["textingConsent"] = "opted_in",
      mobile = `(555) 010-0${nextNumber++}`,
    ): WaitlistClient => ({
      id,
      name: id,
      mobile,
      service: "Haircut",
      stylistRule: { kind: "any" },
      availabilityNote: "anytime",
      availabilityTags: parseAvailability("anytime"),
      joinedAt,
      status,
      textingConsent,
    });

  test("excludes booked, removed, not-opted-in, excluded and busy clients; orders by joinedAt", () => {
    const clients = [
      mk("late", "2026-09-03T00:00:00.000Z"),
      mk("early", "2026-08-01T00:00:00.000Z"),
      mk("booked", "2026-07-01T00:00:00.000Z", "booked"),
      mk("declined", "2026-07-02T00:00:00.000Z"),
      mk("busy", "2026-07-03T00:00:00.000Z"),
      mk("middle", "2026-08-15T00:00:00.000Z"),
      mk("removed", "2026-07-04T00:00:00.000Z", "removed"),
      mk("optedOut", "2026-07-05T00:00:00.000Z", "waiting", "opted_out"),
      mk("notAsked", "2026-07-06T00:00:00.000Z", "waiting", "not_asked"),
    ];
    const s = computeSuggestions(
      clients,
      { service: "Haircut", stylist: "Sam", startsAt: "2026-10-06T09:00" },
      { excludeClientIds: ["declined"], busyClientIds: ["busy"] },
    );
    assert.deepEqual(
      s.map((m) => m.clientId),
      ["early", "middle", "late"],
    );
  });

  test("consent belongs to the number: an opted-out entry blocks every entry with the same mobile", () => {
    const clients = [
      mk("haircut", "2026-08-01T00:00:00.000Z", "waiting", "opted_in", "(555) 010-0777"),
      mk("blowout", "2026-08-02T00:00:00.000Z", "waiting", "opted_out", "555-010-0777"),
      mk("other", "2026-08-03T00:00:00.000Z"),
    ];
    const s = computeSuggestions(clients, { service: "Haircut", stylist: "Sam", startsAt: "2026-10-06T09:00" });
    assert.deepEqual(s.map((m) => m.clientId), ["other"]);
    assert.match(notTextableReason(clients, "haircut") ?? "", /same number/);
    assert.equal(notTextableReason(clients, "other"), undefined);
  });

  test("Keep trying: people already texted with no reply go to the end, marked", () => {
    const clients = [mk("a", "2026-08-01T00:00:00.000Z"), mk("b", "2026-08-02T00:00:00.000Z"), mk("c", "2026-08-03T00:00:00.000Z")];
    const s = computeSuggestions(clients, { service: "Haircut", stylist: "Sam", startsAt: "2026-10-06T09:00" }, { textedBeforeIds: ["a"] });
    assert.deepEqual(s.map((m) => [m.clientId, Boolean(m.textedBefore)]), [["b", false], ["c", false], ["a", true]]);
  });
});
