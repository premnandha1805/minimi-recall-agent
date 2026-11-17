import { en } from 'chrono-node';
import { z } from 'zod';
import { isValidTimeZone } from './contracts.js';

/** Calendar arithmetic only: this constant is never subtracted from a real instant. */
const CALENDAR_DAY = 86_400_000;
export const DATE_LIMITS = Object.freeze({ expressionChars: 256, minYear: 1900, maxYear: 2100, daysAgo: 36_600 });
export type DateScope = 'conversation' | 'external_event';
export interface TemporalReference { instant: string; timezone: string }
export type TemporalResult =
  | { status: 'resolved'; scope: DateScope; reference: Readonly<TemporalReference>;
      localStart: string; localEndExclusive: string; startUtc: string; endUtcExclusive: string }
  | { status: 'ambiguous'; reason: 'numeric_date' }
  | { status: 'unsupported'; reason: 'expression' | 'invalid_date' | 'range' | 'nonexistent_local_date' | 'non_contiguous_local_date' }
  | { status: 'invalid'; reason: 'reference' | 'timezone' | 'input' };

const months = 'January|February|March|April|May|June|July|August|September|October|November|December';
const namedDate = new RegExp(`^(?:\\d{1,2} (?:${months})(?: \\d{4})?|(?:${months}) \\d{1,2}(?:,? \\d{4})?)$`, 'i');
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const stamp = z.iso.datetime({ offset: true });
type Day = { year: number; month: number; day: number };
const ordinal = (d: Day) => Date.UTC(d.year, d.month - 1, d.day) / CALENDAR_DAY;
const calendarDay = (n: number): Day => {
  const date = new Date(n * CALENDAR_DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};
const label = (d: Day) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
const validDay = (d: Day) => label(calendarDay(ordinal(d))) === label(d);
const inRange = (d: Day) => d.year >= DATE_LIMITS.minYear && d.year <= DATE_LIMITS.maxYear;

/**
 * Capture one explicit reference; no ambient clock or process timezone is consulted.
 * For historical text pass its original timestamp. For retries reuse this resolver
 * (or the saved reference), never the retry's wall-clock time.
 * Whole English expressions only; callers identify their meaning with scope.
 * A resolved external event date is NOT a conversation-history selection instruction.
 * "last week" is the completed ISO calendar week, Monday through Sunday.
 */
export function createTemporalResolver(options: { timezone: string } &
  ({ referenceInstant: string; clock?: never } | { clock: () => Date; referenceInstant?: never })) {
  let invalid: TemporalResult | undefined;
  let instant: string | undefined;
  try {
    const supplied = options.referenceInstant ?? options.clock?.().toISOString();
    if (!stamp.safeParse(supplied).success || !Number.isFinite(Date.parse(supplied!))) invalid = { status: 'invalid', reason: 'reference' };
    else instant = new Date(supplied!).toISOString();
  } catch { invalid = { status: 'invalid', reason: 'reference' }; }
  if (typeof options.timezone !== 'string' || options.timezone.length > 64 ||
      /^[+-]/.test(options.timezone) || !isValidTimeZone(options.timezone)) invalid = { status: 'invalid', reason: 'timezone' };
  const reference = Object.freeze({ instant: instant ?? '', timezone: options.timezone });
  const formatter = invalid ? undefined : new Intl.DateTimeFormat('en-US', {
    timeZone: reference.timezone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const localDay = (ms: number): Day => {
    const parts = formatter!.formatToParts(ms);
    const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return { year: part('year'), month: part('month'), day: part('day') };
  };
  /** First instant on/after a local calendar date, including midnight gaps and
   * repeated midnights. Search date labels rather than guessing an IANA offset.
   * The bounded window spans even whole-day date-line changes. */
  const offset = (ms: number) => {
    const parts = formatter!.formatToParts(ms);
    const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(ms / 1000) * 1000;
  };
  const boundary = (day: Day) => {
    const target = ordinal(day);
    let low = target * CALENDAR_DAY - 2 * CALENDAR_DAY;
    let high = target * CALENDAR_DAY + 2 * CALENDAR_DAY;
    const offsets = new Set<number>();
    const transitions: number[] = [];
    // IANA transitions in this supported range are separated by more than six hours.
    // Locate offset changes so a brief midnight rollback cannot fool date bisection.
    let previous = low;
    let previousOffset = offset(previous); offsets.add(previousOffset);
    for (let sample = low + CALENDAR_DAY / 4; sample <= high; sample += CALENDAR_DAY / 4) {
      const currentOffset = offset(sample); offsets.add(currentOffset);
      if (currentOffset !== previousOffset) {
        let a = previous / 1000; let b = sample / 1000;
        while (a + 1 < b) {
          const middle = Math.floor((a + b) / 2);
          if (offset(middle * 1000) === previousOffset) a = middle; else b = middle;
        }
        transitions.push(b * 1000);
      }
      previous = sample; previousOffset = currentOffset;
    }
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (ordinal(localDay(middle)) < target) low = middle + 1;
      else high = middle;
    }
    // There may be two real midnights; choose the first, then reject disjoint days below.
    for (const value of offsets) {
      const candidate = target * CALENDAR_DAY - value;
      if (candidate < low && ordinal(localDay(candidate)) === target) low = candidate;
    }
    return { instant: low, transitions };
  };

  const resolve = (expression: string, scope: DateScope): TemporalResult => {
    if (invalid) return { ...invalid };
    if (typeof expression !== 'string' || expression.length > DATE_LIMITS.expressionChars ||
        !['conversation', 'external_event'].includes(scope)) return { status: 'invalid', reason: 'input' };
    const text = expression.trim().replace(/\s+/g, ' ');
    if (!text) return { status: 'unsupported', reason: 'expression' };
    // No locale-order guessing, including numeric dates that happen to look unambiguous.
    if (/^\d{1,4}[/.\-]\d{1,2}(?:[/.\-]\d{1,4})?$/.test(text) && !isoDate.test(text)) {
      return { status: 'ambiguous', reason: 'numeric_date' };
    }
    const today = localDay(Date.parse(reference.instant));
    if (!inRange(today)) return { status: 'unsupported', reason: 'range' };
    let start = today;
    let days = 1;
    const lower = text.toLowerCase();
    const ago = lower.match(/^(\d{1,6}) days? ago$/);
    if (lower === 'today') { /* current local calendar day, including the unelapsed portion */ }
    else if (lower === 'yesterday') start = calendarDay(ordinal(today) - 1);
    else if (/^(?:last )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.test(lower)) {
      const weekday = new Date(ordinal(today) * CALENDAR_DAY).getUTCDay();
      const wanted = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(lower.replace(/^last /, ''));
      const distance = (weekday - wanted + 7) % 7;
      start = calendarDay(ordinal(today) - (distance || (lower.startsWith('last ') ? 7 : 0)));
    } else if (lower === 'last week') {
      const weekday = new Date(ordinal(today) * CALENDAR_DAY).getUTCDay();
      start = calendarDay(ordinal(today) - ((weekday + 6) % 7) - 7); days = 7;
    } else if (/^(?:last|this|next) (?:month|year|week)$/.test(lower)) {
      const [direction, unit] = lower.split(' ');
      const shift = direction === 'last' ? -1 : direction === 'next' ? 1 : 0;
      if (unit === 'week') {
        const weekday = new Date(ordinal(today) * CALENDAR_DAY).getUTCDay();
        start = calendarDay(ordinal(today) - ((weekday + 6) % 7) + shift * 7); days = 7;
      } else {
        const month = unit === 'year' ? 0 : today.month - 1 + shift;
        const year = today.year + (unit === 'year' ? shift : 0);
        start = calendarDay(Date.UTC(year, month, 1) / CALENDAR_DAY);
        days = Date.UTC(year + (unit === 'year' ? 1 : 0), month + (unit === 'month' ? 1 : 0), 1) / CALENDAR_DAY - ordinal(start);
      }
    } else if (ago) {
      if (Number(ago[1]) > DATE_LIMITS.daysAgo) return { status: 'unsupported', reason: 'range' };
      start = calendarDay(ordinal(today) - Number(ago[1]));
    } else if (isoDate.test(text)) {
      const [year, month, day] = text.split('-').map(Number); start = { year, month, day };
      if (!validDay(start)) return { status: 'unsupported', reason: 'invalid_date' };
    } else if (namedDate.test(text)) {
      // Leap-year synthetic reference, explicit zero offset: Chrono only supplies
      // calendar components. Its implicit year and Date conversion are not used.
      const parsed = en.strict.parse(text, { instant: new Date('2000-01-01T12:00:00Z'), timezone: 0 });
      const match = parsed[0];
      if (parsed.length !== 1 || match.index !== 0 || match.text.length !== text.length || match.end) {
        return { status: 'unsupported', reason: 'invalid_date' };
      }
      start = { year: match.start.isCertain('year') ? match.start.get('year')! : today.year,
        month: match.start.get('month')!, day: match.start.get('day')! };
      if (!match.start.isCertain('year')) {
        // Find the latest real occurrence (including Feb 29); never roll it to March.
        while (start.year >= DATE_LIMITS.minYear && (!validDay(start) || ordinal(start) > ordinal(today))) start.year--;
      } else if (!validDay(start)) return { status: 'unsupported', reason: 'invalid_date' };
    } else return { status: 'unsupported', reason: 'expression' };
    if (!inRange(start)) return { status: 'unsupported', reason: 'range' };
    const end = calendarDay(ordinal(start) + days);
    const first = boundary(start); const last = boundary(end);
    const from = first.instant; const until = last.instant;
    if (label(localDay(from)) !== label(start) || until <= from) return { status: 'unsupported', reason: 'nonexistent_local_date' };
    const inside = (ms: number) => ordinal(localDay(ms)) >= ordinal(start) && ordinal(localDay(ms)) < ordinal(end);
    if ([...first.transitions, ...last.transitions].some((ms) =>
      (ms >= from && ms < until && !inside(ms)) || (ms > from && ms <= until && !inside(ms - 1)))) {
      return { status: 'unsupported', reason: 'non_contiguous_local_date' };
    }
    return { status: 'resolved', scope, reference, localStart: label(start), localEndExclusive: label(end),
      startUtc: new Date(from).toISOString(), endUtcExclusive: new Date(until).toISOString() };
  };
  return Object.freeze({ reference, resolve });
}
