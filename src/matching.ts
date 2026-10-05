// Pure matching logic — no Temporal, no I/O — so it can be unit-tested and
// safely imported from Workflow code, Activities and the API alike.
import {
  DAYS,
  PARTS_OF_DAY,
  type AvailabilityTags,
  type Day,
  type PartOfDay,
  type StylistRule,
  type Stylist,
  type Suggestion,
  type WaitlistClient,
  type Service,
} from "./types";

const WEEKDAYS: Day[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const WEEKEND: Day[] = ["Sat", "Sun"];

const DAY_PATTERNS: Array<[Day, string]> = [
  ["Sun", "sun(?:day)?s?"],
  ["Mon", "mon(?:day)?s?"],
  ["Tue", "tue(?:s|sday)?s?"],
  ["Wed", "wed(?:s|nesday)?s?"],
  ["Thu", "thu(?:r|rs|rsday)?s?"],
  ["Fri", "fri(?:day)?s?"],
  ["Sat", "sat(?:urday)?s?"],
];
const ANY_DAY_WORD = DAY_PATTERNS.map(([, p]) => p).join("|");

/** morning < 12:00, afternoon 12:00–16:59, evening >= 17:00 */
export function partOfDay(hour: number): PartOfDay {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

const PART_RANGES: Record<PartOfDay, [number, number]> = {
  morning: [0, 12],
  afternoon: [12, 17],
  evening: [17, 24],
};

function dayFromWord(word: string): Day | undefined {
  for (const [day, pattern] of DAY_PATTERNS) {
    if (new RegExp(`^(?:${pattern})$`).test(word)) return day;
  }
  return undefined;
}

/** "5" -> 17, "5pm" -> 17, "10" -> 10, "10am" -> 10, "noon" -> 12. Bare 1–7 are read as pm (salon hours). */
function toHour(raw: string, suffix?: string): number {
  if (raw === "noon") return 12;
  let h = Number(raw);
  if (suffix === "pm" && h < 12) h += 12;
  else if (suffix === "am" && h === 12) h = 0;
  else if (!suffix && h >= 1 && h <= 7) h += 12;
  return h;
}

/**
 * Turn a free-text availability note into rough day / part-of-day tags.
 * The note itself is always kept and shown to staff; these tags are only a hint.
 */
export function parseAvailability(note: string): AvailabilityTags {
  let text = ` ${note.toLowerCase().replace(/[.,;:()!]/g, " ")} `;
  const days = new Set<Day>();
  const excluded = new Set<Day>();
  const parts = new Set<PartOfDay>();

  // Negations first ("no Mondays", "not Fri/Sat", "except weekends", "no weekends"), then
  // remove them from the text so the positive rules below don't re-add those days.
  const negRe = new RegExp(
    `\\b(?:no|not|except|never)\\s+(?:on\\s+)?(?:the\\s+)?((?:weekends?|weekdays?|${ANY_DAY_WORD})` +
      `(?:\\s*(?:/|&|or|and|nor)\\s*(?:${ANY_DAY_WORD}))*)\\b`,
    "g",
  );
  text = text.replace(negRe, (_all, list: string) => {
    if (/weekends?/.test(list)) WEEKEND.forEach((d) => excluded.add(d));
    if (/weekdays?/.test(list)) WEEKDAYS.forEach((d) => excluded.add(d));
    for (const w of list.split(/[^a-z]+/)) {
      const d = dayFromWord(w);
      if (d) excluded.add(d);
    }
    return " ";
  });

  // "any time" / "anytime" / "flexible" are about the TIME of day; they only mean
  // "any day" too when no specific day was named (handled below).
  const anyTime = /\b(any ?time|anytime|flexible|whenever(?: works)?)\b/.test(text);
  const anyDay = /\b(any ?day|every ?day|any day of the week|7 days)\b/.test(text);

  if (/\bweekdays?\b/.test(text)) WEEKDAYS.forEach((d) => days.add(d));
  if (/\bweekends?\b/.test(text)) WEEKEND.forEach((d) => days.add(d));

  // Ranges like "Mon-Wed" or "Tue through Thu".
  const rangeRe = new RegExp(`\\b(${ANY_DAY_WORD})\\s*(?:-|–|to|through|thru)\\s*(${ANY_DAY_WORD})\\b`, "g");
  for (const m of text.matchAll(rangeRe)) {
    const a = dayFromWord(m[1]);
    const b = dayFromWord(m[2]);
    if (!a || !b) continue;
    let i = DAYS.indexOf(a);
    for (let guard = 0; guard < 7; guard++) {
      days.add(DAYS[i]);
      if (DAYS[i] === b) break;
      i = (i + 1) % 7;
    }
  }

  // Individual day words (including "Tue/Thu").
  const dayRe = new RegExp(`(?:^|[^a-z])(${ANY_DAY_WORD})(?=[^a-z]|$)`, "g");
  for (const m of text.matchAll(dayRe)) {
    const d = dayFromWord(m[1]);
    if (d) days.add(d);
  }

  if (anyTime) PARTS_OF_DAY.forEach((p) => parts.add(p));
  if (anyDay || (anyTime && days.size === 0 && excluded.size === 0)) DAYS.forEach((d) => days.add(d));

  if (/\bmornings?\b|\bbefore noon\b/.test(text)) parts.add("morning");
  if (/\bafternoons?\b|\blunch(?:time)?\b|\bmidday\b/.test(text)) parts.add("afternoon");
  if (/\bevenings?\b|\bnights?\b|\bafter work\b/.test(text)) parts.add("evening");

  for (const m of text.matchAll(/\bafter\s+(noon|\d{1,2})(?::\d{2})?\s*(am|pm)?\b/g)) {
    const h = toHour(m[1], m[2]);
    for (const p of PARTS_OF_DAY) if (PART_RANGES[p][1] > h) parts.add(p);
  }
  for (const m of text.matchAll(/\bbefore\s+(noon|\d{1,2})(?::\d{2})?\s*(am|pm)?\b/g)) {
    const h = toHour(m[1], m[2]);
    for (const p of PARTS_OF_DAY) if (PART_RANGES[p][0] < h) parts.add(p);
  }

  // Only negations ("anything but Mondays", "no weekends") => every other day.
  if (days.size === 0 && excluded.size > 0) DAYS.forEach((d) => !excluded.has(d) && days.add(d));
  excluded.forEach((d) => days.delete(d));

  return {
    days: DAYS.filter((d) => days.has(d)),
    parts: PARTS_OF_DAY.filter((p) => parts.has(p)),
  };
}

/** Day of week and part of day for a salon-local "YYYY-MM-DDTHH:mm" string. */
export function describeSlot(startsAt: string): { day: Day; part: PartOfDay; hour: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAt);
  if (!m) throw new Error(`Invalid opening time: ${startsAt}`);
  const [, y, mo, d, h] = m;
  const dow = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
  const hour = Number(h);
  return { day: DAYS[dow], part: partOfDay(hour), hour };
}

export type AvailabilityFit = "fits" | "check-note" | "no";

export function availabilityFit(tags: AvailabilityTags, day: Day, part: PartOfDay): AvailabilityFit {
  if (tags.days.length === 0 && tags.parts.length === 0) return "check-note";
  if (tags.days.length > 0 && !tags.days.includes(day)) return "no";
  if (tags.parts.length > 0 && !tags.parts.includes(part)) return "no";
  return "fits";
}

export function stylistRuleSatisfied(rule: StylistRule, stylist: Stylist): boolean {
  return rule.kind === "any" || rule.stylist === stylist;
}

export function describeStylistRule(rule: StylistRule): string {
  if (rule.kind === "required") return `Only ${rule.stylist}`;
  return rule.preferred ? `Any stylist (prefers ${rule.preferred})` : "Any stylist";
}

export function byJoinOrder(a: { joinedAt: string; id?: string; clientId?: string }, b: typeof a): number {
  if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt ? -1 : 1;
  const ai = a.id ?? a.clientId ?? "";
  const bi = b.id ?? b.clientId ?? "";
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

export type MatchOpening = { service: Service; stylist: Stylist; startsAt: string };

/**
 * Suggested matches for an opening: same service, stylist rule satisfied,
 * availability roughly fits (or the note needs a human read), still waiting,
 * not opted out, not excluded and not holding a live offer elsewhere — earliest joiner first.
 */
export function computeSuggestions(
  clients: WaitlistClient[],
  opening: MatchOpening,
  options: { excludeClientIds?: Iterable<string>; busyClientIds?: Iterable<string> } = {},
): Suggestion[] {
  const exclude = new Set(options.excludeClientIds ?? []);
  const busy = new Set(options.busyClientIds ?? []);
  const { day, part } = describeSlot(opening.startsAt);
  return clients
    .filter((c) => c.status === "waiting")
    .filter((c) => !c.optedOut) // opted out of texts => never contacted
    .filter((c) => !exclude.has(c.id) && !busy.has(c.id))
    .filter((c) => c.service === opening.service)
    .filter((c) => stylistRuleSatisfied(c.stylistRule, opening.stylist))
    .map((c) => ({ c, fit: availabilityFit(c.availabilityTags, day, part) }))
    .filter(({ fit }) => fit !== "no")
    .sort((x, y) => byJoinOrder(x.c, y.c))
    .map(({ c, fit }) => ({
      clientId: c.id,
      name: c.name,
      mobile: c.mobile,
      joinedAt: c.joinedAt,
      availabilityNote: c.availabilityNote,
      availabilityTags: c.availabilityTags,
      stylistRule: c.stylistRule,
      checkNote: fit === "check-note",
      prefersThisStylist: c.stylistRule.kind === "any" && c.stylistRule.preferred === opening.stylist,
    }));
}
