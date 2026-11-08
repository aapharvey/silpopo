/** Поточна дата 'YYYY-MM-DD' у заданому часовому поясі. */
export function todayIn(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Поточна година (0–23) у заданому часовому поясі. */
export function hourIn(tz: string, now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now);
  return Number(h);
}

export function daysAgo(day: string, n: number): string {
  const t = Date.parse(day + "T00:00:00Z") - n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}
