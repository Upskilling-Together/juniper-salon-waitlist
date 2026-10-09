// Locale-independent formatting for salon-local "YYYY-MM-DDTHH:mm" times.
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatSlot(startsAt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAt);
  if (!m) return startsAt;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${DAY[dow]} ${MONTH[mo - 1]} ${d}, ${hour12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export function formatWindowSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const min = Math.round(seconds / 60);
  if (min >= 60 && min % 60 === 0) return `${min / 60} hour${min === 60 ? "" : "s"}`;
  return `${min} min`;
}

/** "Lena", "Lena and Carla", "Lena, Carla and Sam". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "45 min", "1 hour", "1 hour 30 min", "2 hours" (for settings like Stop offering). */
export function minutesText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}`;
}
