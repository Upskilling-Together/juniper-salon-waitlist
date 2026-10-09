// FICTIONAL sample data standing in for the salon's Google Sheet waitlist.
// Names are made up and every number uses the reserved 555-01xx range.
// There is no real Google Sheets integration in this prototype.
import { parseAvailability } from "./matching";
import type { Service, StylistRule, TextingConsent, WaitlistClient } from "./types";

export const SAMPLE_SOURCE = "Sample data — imported from the salon's Google Sheet";

type Row = [id: string, name: string, service: Service, rule: StylistRule, note: string, joined: string];

// Services: Haircut, Color, Blowout (old "Highlights" rows are now Color, old "Trim" rows are Haircut).
// "Only <stylist>" rules are spread across all five stylists (Sam, Jules and Nico are sample names).
const rows: Row[] = [
  ["c01", "Maya Thompson", "Haircut", { kind: "any", preferred: "Carla" }, "weekday afternoons", "2026-08-04T10:15"],
  ["c02", "Jordan Patel", "Haircut", { kind: "required", stylist: "Lena" }, "after 5", "2026-08-06T16:40"],
  ["c03", "Priya Nair", "Haircut", { kind: "any" }, "Tue/Thu mornings", "2026-08-09T09:05"],
  ["c04", "Ellis Moreno", "Haircut", { kind: "any", preferred: "Sam" }, "anytime — just text", "2026-08-12T13:30"],
  ["c05", "Hannah Okafor", "Haircut", { kind: "required", stylist: "Carla" }, "Mon, Wed, Fri afternoons", "2026-08-15T11:00"],
  ["c06", "Theo Brooks", "Haircut", { kind: "any", preferred: "Jules" }, "weekdays after 2", "2026-08-20T15:20"],
  ["c07", "Rosa Delgado", "Haircut", { kind: "any", preferred: "Carla" }, "depends on her shift — text first", "2026-08-25T12:45"],
  ["c08", "Nadia Fischer", "Haircut", { kind: "required", stylist: "Sam" }, "Saturdays", "2026-09-02T10:10"],
  ["c09", "Owen Gallagher", "Haircut", { kind: "any" }, "weekday evenings", "2026-09-10T18:05"],
  ["c10", "Imani Clarke", "Color", { kind: "required", stylist: "Lena" }, "Tue/Thu mornings", "2026-08-05T09:30"],
  ["c11", "Lucas Byrne", "Color", { kind: "any" }, "weekends", "2026-08-11T14:00"],
  ["c12", "Zoe Kim", "Color", { kind: "required", stylist: "Jules" }, "after 5", "2026-08-18T17:25"],
  ["c13", "Aisha Rahman", "Color", { kind: "any", preferred: "Lena" }, "Mondays and Wednesdays, any time", "2026-08-27T10:50"],
  ["c14", "Grace Liu", "Color", { kind: "any" }, "can make it work if it's before 3", "2026-09-05T13:15"],
  ["c15", "Mateo Silva", "Color", { kind: "required", stylist: "Carla" }, "weekday afternoons", "2026-08-07T12:00"],
  ["c16", "Chloe Martin", "Color", { kind: "any" }, "Saturdays", "2026-08-14T09:45"],
  ["c17", "Ruby Adams", "Color", { kind: "required", stylist: "Nico" }, "Fri only", "2026-08-29T16:10"],
  ["c18", "Isaac Cohen", "Color", { kind: "any" }, "lunchtime on weekdays", "2026-09-12T11:35"],
  ["c19", "Freya Lindqvist", "Blowout", { kind: "any" }, "after 5", "2026-08-08T19:00"],
  ["c20", "Daniel Osei", "Blowout", { kind: "any", preferred: "Nico" }, "weekend mornings", "2026-08-22T08:55"],
  ["c21", "Leah Novak", "Blowout", { kind: "required", stylist: "Sam" }, "ask — new baby, schedule all over the place", "2026-09-15T14:25"],
  ["c22", "Kenji Watanabe", "Haircut", { kind: "any" }, "weekday mornings", "2026-08-10T08:20"],
  ["c23", "Bella Rossi", "Haircut", { kind: "required", stylist: "Jules" }, "not Mondays", "2026-08-30T15:00"],
  ["c24", "Marcus Hill", "Haircut", { kind: "required", stylist: "Nico" }, "Thursday evenings", "2026-09-19T17:40"],
];

/**
 * Texting consent column in the sheet. Most said yes when they joined; two asked not to be texted;
 * three were never asked (staff can record their answer from the waitlist).
 */
const CONSENT: Record<string, TextingConsent> = {
  c11: "opted_out",
  c18: "opted_out",
  c09: "not_asked",
  c16: "not_asked",
  c21: "not_asked",
};

export function sampleWaitlist(): WaitlistClient[] {
  return rows.map(([id, name, service, stylistRule, note, joined], i) => {
    const textingConsent = CONSENT[id] ?? "opted_in";
    const joinedAt = `${joined}:00.000Z`;
    return {
      id,
      name,
      mobile: `(555) 010-${String(101 + i).padStart(4, "0")}`,
      service,
      stylistRule,
      availabilityNote: note,
      availabilityTags: parseAvailability(note),
      joinedAt,
      status: "waiting" as const,
      textingConsent,
      ...(textingConsent === "not_asked" ? {} : { consentRecordedAt: joinedAt, consentSource: "Asked when they joined" }),
    };
  });
}
