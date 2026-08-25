/**
 * 5 段 cron 解析与下次执行时间计算（迁自 daemon-feishu DaemonService，行为不变）。
 * 支持 * / , - 与日/周联合语义（两者都受限时取并集，与标准 cron 一致）。
 */

export function computeNextRun(cron: string): number | null {
  const next = nextCronTime(cron);
  return next ? next.getTime() / 1000 : null;
}

export function isValidCronExpression(cron: string): boolean {
  return nextCronTime(cron) !== null;
}

function nextCronTime(cron: string, after = new Date()): Date | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  let date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date = new Date(date.getTime() + 60_000);
  const limit = new Date(date.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (date < limit) {
    if (matchesCron(cron, date)) return date;
    date = new Date(date.getTime() + 60_000);
  }
  return null;
}

function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return false;
  if (!parseCronField(minute, 0, 59).has(date.getMinutes())) return false;
  if (!parseCronField(hour, 0, 23).has(date.getHours())) return false;
  if (!parseCronField(month, 1, 12).has(date.getMonth() + 1)) return false;
  const dayOfMonthRestricted = dayOfMonth !== "*";
  const dayOfWeekRestricted = dayOfWeek !== "*";
  if (dayOfMonthRestricted && dayOfWeekRestricted) return parseCronField(dayOfMonth, 1, 31).has(date.getDate()) || parseCronField(dayOfWeek, 0, 6).has(date.getDay());
  return parseCronField(dayOfMonth, 1, 31).has(date.getDate()) && parseCronField(dayOfWeek, 0, 6).has(date.getDay());
}

function parseCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") addRange(values, min, max, 1);
    else if (part.includes("/")) {
      const [base, rawStep] = part.split("/");
      const step = Math.max(1, Number(rawStep) || 1);
      const start = base === "*" ? min : Number(base);
      addRange(values, Number.isFinite(start) ? start : min, max, step);
    } else if (part.includes("-")) {
      const [start, end] = part.split("-");
      addRange(values, Number(start), Number(end), 1);
    } else {
      const value = Number(part);
      if (Number.isInteger(value) && value >= min && value <= max) values.add(value);
    }
  }
  return values;
}

function addRange(values: Set<number>, start: number, end: number, step: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return;
  for (let value = Math.max(start, 0); value <= end; value += step) values.add(value);
}
