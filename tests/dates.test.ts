import { describe, expect, it, vi } from 'vitest';
import { createTemporalResolver } from '../src/dates.js';

const resolve = (expression: string, referenceInstant = '2026-11-17T12:00:00Z', timezone = 'Asia/Kolkata') =>
  createTemporalResolver({ referenceInstant, timezone }).resolve(expression, 'conversation');
const day = (expression: string, reference: string, timezone: string) => {
  const value = resolve(expression, reference, timezone);
  expect(value.status).toBe('resolved');
  if (value.status !== 'resolved') throw new Error('Fixture was not resolved');
  return value;
};

describe('deterministic temporal resolver (frozen instants, no providers)', () => {
  it('last Tuesday is strictly earlier, including when today is Tuesday locally', () => {
    expect(resolve('last Tuesday')).toMatchObject({ status: 'resolved', localStart: '2026-11-10',
      startUtc: '2026-11-09T18:30:00.000Z', endUtcExclusive: '2026-11-10T18:30:00.000Z' });
    expect(resolve('last Tuesday', '2026-11-16T20:00:00Z')).toMatchObject({ localStart: '2026-11-10' });
    expect(resolve('last Tuesday', '2026-11-18T12:00:00Z')).toMatchObject({ localStart: '2026-11-17' });
  });
  it.each([
    ['2026-01-01T06:00:00Z', '2025-12-31'],
    ['2026-03-01T06:00:00Z', '2026-02-28'],
    ['2024-03-01T06:00:00Z', '2024-02-29'],
  ])('yesterday crosses month/year/leap boundaries: %s', (instant, expected) => {
    expect(resolve('yesterday', instant)).toMatchObject({ status: 'resolved', localStart: expected });
  });
  it('today uses the reference local day rather than the UTC day', () => {
    expect(resolve('today', '2026-01-01T00:30:00Z', 'America/Los_Angeles')).toMatchObject({
      localStart: '2025-12-31', localEndExclusive: '2026-01-01', startUtc: '2025-12-31T08:00:00.000Z' });
    expect(resolve('today', '2025-12-31T23:30:00Z', 'Asia/Kolkata')).toMatchObject({ localStart: '2026-01-01' });
  });
  it.each([
    ['2026-11-15T12:00:00Z', '2026-11-03'],
    ['2026-11-01T12:00:00Z', '2025-11-03'],
    ['2026-11-03T12:00:00Z', '2026-11-03'],
    ['2026-01-01T12:00:00Z', '2025-11-03'],
  ])('3 November uses the most recent calendar occurrence: %s', (instant, expected) => {
    expect(resolve('3 November', instant)).toMatchObject({ status: 'resolved', localStart: expected });
  });
  it('honors explicit years and both supported named-date forms', () => {
    for (const expression of ['3 November 2024', 'November 3, 2024', '2024-11-03']) {
      expect(resolve(expression)).toMatchObject({ status: 'resolved', localStart: '2024-11-03' });
    }
  });
  it('finds the latest actual leap day without rolling into March', () => {
    expect(resolve('29 February', '2025-03-01T12:00:00Z')).toMatchObject({ localStart: '2024-02-29' });
    expect(resolve('29 February', '2024-02-01T12:00:00Z')).toMatchObject({ localStart: '2020-02-29' });
    expect(resolve('29 February 2000')).toMatchObject({ localStart: '2000-02-29' });
    for (const date of ['2025-02-29', '29 February 2025', '1900-02-29', '31 November 2024']) {
      expect(resolve(date)).toMatchObject({ status: 'unsupported', reason: 'invalid_date' });
    }
  });
  it('last week means the completed Monday-through-Sunday calendar week', () => {
    const v = day('last week', '2026-01-01T12:00:00Z', 'UTC');
    expect(v).toMatchObject({ localStart: '2025-12-22', localEndExclusive: '2025-12-29' });
    expect(resolve('last week', '2026-11-16T00:00:00Z', 'UTC')).toMatchObject({ localStart: '2026-11-09', localEndExclusive: '2026-11-16' });
  });
  it('N days ago subtracts calendar dates, including zero and a DST crossing', () => {
    expect(resolve('2 days ago', '2026-01-01T10:00:00Z')).toMatchObject({ localStart: '2025-12-30' });
    expect(resolve('0 days ago')).toMatchObject({ localStart: '2026-11-17' });
    expect(resolve('1 day ago', '2024-03-11T04:15:00Z', 'America/New_York')).toMatchObject({ localStart: '2024-03-10' });
  });
  it.each([
    ['America/New_York', '2024-03-10', '2024-03-10T05:00:00.000Z', '2024-03-11T04:00:00.000Z', 23],
    ['America/New_York', '2024-11-03', '2024-11-03T04:00:00.000Z', '2024-11-04T05:00:00.000Z', 25],
    ['Europe/Berlin', '2024-03-31', '2024-03-30T23:00:00.000Z', '2024-03-31T22:00:00.000Z', 23],
    ['Australia/Lord_Howe', '2024-10-06', '2024-10-05T13:30:00.000Z', '2024-10-06T13:00:00.000Z', 23.5],
    ['America/Sao_Paulo', '2018-11-04', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z', 23],
  ])('maps actual calendar boundaries across DST: %s %s', (zone, date, start, end, hours) => {
    const v = day(date, '2026-11-15T12:00:00Z', zone);
    expect(v.startUtc).toBe(start); expect(v.endUtcExclusive).toBe(end);
    expect((Date.parse(end) - Date.parse(start)) / 3_600_000).toBe(hours);
  });
  it('does not invent a date skipped by a date-line change', () => {
    expect(resolve('2011-12-30', '2026-11-15T12:00:00Z', 'Pacific/Apia')).toEqual({ status: 'unsupported', reason: 'nonexistent_local_date' });
    const previous = day('2011-12-29', '2026-11-15T12:00:00Z', 'Pacific/Apia');
    expect(previous.endUtcExclusive).toBe('2011-12-30T10:00:00.000Z');
  });
  it('rejects a historical midnight rollback that splits a local date into disjoint intervals', () => {
    expect(resolve('1987-10-25', '2026-11-15T12:00:00Z', 'America/Goose_Bay')).toEqual({
      status: 'unsupported', reason: 'non_contiguous_local_date' });
  });
  it.each(['Invalid/Zone', '', '+05:30'])('rejects an invalid/non-IANA timezone: %s', (timezone) => {
    expect(resolve('today', '2026-11-15T12:00:00Z', timezone)).toEqual({ status: 'invalid', reason: 'timezone' });
  });
  it.each(['11/03/2025', '03/11/2025', '11/03', '2025/11/03', '03-11-2025'])('does not guess numeric ordering: %s', (text) => {
    expect(resolve(text)).toEqual({ status: 'ambiguous', reason: 'numeric_date' });
  });
  it('captures the injected clock once and preserves the original reference for retries', () => {
    let instant = new Date('2024-03-01T00:15:00Z');
    const clock = vi.fn(() => instant);
    const r = createTemporalResolver({ clock, timezone: 'UTC' });
    const first = r.resolve('yesterday', 'conversation');
    instant = new Date('2026-11-15T12:00:00Z');
    expect(r.resolve('yesterday', 'conversation')).toEqual(first);
    expect(clock).toHaveBeenCalledTimes(1); expect(Object.isFrozen(r.reference)).toBe(true);
    expect(first).toMatchObject({ localStart: '2024-02-29', reference: { instant: '2024-03-01T00:15:00.000Z' } });
  });
  it('anchors historical text to its original timestamp instead of current request time', () => {
    const history = createTemporalResolver({ referenceInstant: '2024-03-01T00:15:00Z', timezone: 'UTC' });
    const current = createTemporalResolver({ referenceInstant: '2026-11-15T00:15:00Z', timezone: 'UTC' });
    expect(history.resolve('yesterday', 'conversation')).toMatchObject({ localStart: '2024-02-29' });
    expect(current.resolve('yesterday', 'conversation')).toMatchObject({ localStart: '2026-11-14' });
  });
  it('keeps external event dates separate and never extracts a recall anchor from a factual sentence', () => {
    const r = createTemporalResolver({ referenceInstant: '2026-11-15T12:00:00Z', timezone: 'UTC' });
    expect(r.resolve('3 November 2025', 'external_event')).toMatchObject({ status: 'resolved', scope: 'external_event', localStart: '2025-11-03' });
    expect(r.resolve('The Nobel Prize was announced on 3 November 2025', 'conversation')).toMatchObject({ status: 'unsupported' });
    expect(r.resolve('2025 Nobel Prize', 'external_event')).toMatchObject({ status: 'unsupported' });
  });
  it.each(['last month', 'Tuesday', 'next week', 'today at 01:30', '03 November CST', '', 'x'.repeat(257), '2026-13-01'])('reports unsupported/invalid expressions rather than using parser guesses: %s', (text) => {
    expect(resolve(text).status).not.toBe('resolved');
  });
  it.each(['not-an-instant', '2026-11-15', '2025-02-29T00:00:00Z'])('rejects invalid references: %s', (reference) => {
    expect(resolve('today', reference)).toEqual({ status: 'invalid', reason: 'reference' });
  });
  it('enforces explicit range limits without reading the ambient clock', () => {
    expect(resolve('999999 days ago')).toEqual({ status: 'unsupported', reason: 'range' });
    expect(resolve('1899-01-01')).toEqual({ status: 'unsupported', reason: 'range' });
    expect(resolve('2101-01-01')).toEqual({ status: 'unsupported', reason: 'range' });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('No ambient clock'); });
    try { expect(resolve('today').status).toBe('resolved'); } finally { now.mockRestore(); }
  });
});
