import { parseCronExpression, validateCronExpression, type ParsedCronSchedule } from './fleet';

export { parseCronExpression, validateCronExpression, type ParsedCronSchedule };

function matchesParsedCron(parsed: ParsedCronSchedule, dateUtc: Date): boolean {
  const minute = dateUtc.getUTCMinutes();
  const hour = dateUtc.getUTCHours();
  const dom = dateUtc.getUTCDate();
  const month = dateUtc.getUTCMonth() + 1;
  const dow = dateUtc.getUTCDay();

  if (!parsed.minutes.has(minute)) return false;
  if (!parsed.hours.has(hour)) return false;
  if (!parsed.months.has(month)) return false;

  const domMatch = parsed.daysOfMonth.has(dom);
  const dowMatch = parsed.daysOfWeek.has(dow);
  if (!parsed.domWildcard && !parsed.dowWildcard) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

export function matchesCronExpression(rawExpr: string, dateUtc: Date): boolean {
  try {
    const parsed = parseCronExpression(rawExpr);
    return matchesParsedCron(parsed, dateUtc);
  } catch {
    return false;
  }
}

export function computeNextCronRunUtc(rawExpr: string, fromDate: Date = new Date()): string | null {
  let parsed: ParsedCronSchedule;
  try {
    parsed = parseCronExpression(rawExpr);
  } catch {
    return null;
  }

  const cursor = new Date(
    Date.UTC(
      fromDate.getUTCFullYear(),
      fromDate.getUTCMonth(),
      fromDate.getUTCDate(),
      fromDate.getUTCHours(),
      fromDate.getUTCMinutes() + 1,
      0,
      0
    )
  );
  const maxTimeMs = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;

  while (cursor.getTime() <= maxTimeMs) {
    if (!parsed.months.has(cursor.getUTCMonth() + 1)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    const domMatch = parsed.daysOfMonth.has(cursor.getUTCDate());
    const dowMatch = parsed.daysOfWeek.has(cursor.getUTCDay());
    const dayValid = !parsed.domWildcard && !parsed.dowWildcard ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayValid) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }

    if (!parsed.hours.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }

    if (!parsed.minutes.has(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }

    return cursor.toISOString();
  }
  return null;
}

export function formatCronSlotKey(envName: string, service: string, jobName: string, dateUtc: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${dateUtc.getUTCFullYear()}-${pad(dateUtc.getUTCMonth() + 1)}-${pad(dateUtc.getUTCDate())}T${pad(dateUtc.getUTCHours())}:${pad(dateUtc.getUTCMinutes())}`;
  return `${envName.trim().toLowerCase()}:${service.trim().toLowerCase()}:${jobName.trim().toLowerCase()}:${stamp}`;
}
