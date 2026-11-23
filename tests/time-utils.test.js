const test = require('node:test');
const assert = require('node:assert/strict');
const time = require('../src/shared/time-utils.js');

test('uses the correct Lisbon offset across daylight saving time', () => {
  assert.equal(time.formatOffset(time.offsetAtZonedDateTime('2026-01-15', '09:00', 'Europe/Lisbon')), '+0000');
  assert.equal(time.formatOffset(time.offsetAtZonedDateTime('2026-09-15', '09:00', 'Europe/Lisbon')), '+0100');
});

test('converts Jira changelog timestamps into the configured time zone', () => {
  assert.deepEqual(time.dateAndMinutesInTimeZone('2026-09-15T09:30:00.000Z', 'Europe/Lisbon'), { date: '2026-09-15', minutes: 630 });
});

test('caps a reviewed task at its review transition and starts the next task there', () => {
  const plan = time.planAutoWorklogs([
    { key: 'APP-1', reviewMinute: 10 * 60 },
    { key: 'APP-2', reviewMinute: null },
  ], 8, '09:00');
  assert.deepEqual(plan, [
    { issueKey: 'APP-1', time: '09:00', seconds: 3600 },
    { issueKey: 'APP-2', time: '10:00', seconds: 25200 },
  ]);
});

test('honours a configured morning start and splits remaining work in half-hour units', () => {
  const plan = time.planAutoWorklogs([
    { key: 'APP-1', reviewMinute: null },
    { key: 'APP-2', reviewMinute: null },
  ], 7, '08:30');
  assert.deepEqual(plan, [
    { issueKey: 'APP-1', time: '08:30', seconds: 12600 },
    { issueKey: 'APP-2', time: '12:00', seconds: 12600 },
  ]);
});

test('excludes tasks that were already in review before the auto-log date', () => {
  const plan = time.planAutoWorklogs([
    { key: 'APP-OLD-REVIEW', isReview: true, reviewMinute: null },
    { key: 'APP-ACTIVE', isReview: false, reviewMinute: null },
  ], 7, '09:00');

  assert.deepEqual(plan, [
    { issueKey: 'APP-ACTIVE', time: '09:00', seconds: 25200 },
  ]);
});

test('uses assignment history for both today and past dates', () => {
  assert.equal(time.shouldUseAssignmentHistory('2026-09-23', '2026-09-23'), true);
  assert.equal(time.shouldUseAssignmentHistory('2026-09-22', '2026-09-23'), true);
  assert.equal(time.shouldUseAssignmentHistory('2026-09-24', '2026-09-23'), false);
});

test('keeps a dated in-progress task after it was reassigned to QA', () => {
  assert.equal(time.isDatedIssueEligible({
    statusId: '3',
    allowedStatusIds: ['3', '10020'],
    wasAssignedOnDate: true,
    assigneeAtEndOfDay: 'qa-account',
    requestedAccountId: 'developer-account',
  }), true);

  assert.equal(time.isDatedIssueEligible({
    statusId: '5',
    allowedStatusIds: ['3', '10020'],
    wasAssignedOnDate: true,
    assigneeAtEndOfDay: 'qa-account',
    requestedAccountId: 'developer-account',
  }), false);
});

test('schedules auto-log at 18:00 with late-start recovery', () => {
  const before = new Date(2026, 8, 24, 17, 30, 0);
  const scheduledToday = new Date(time.nextDailyRunTime(before, 18));
  assert.equal(scheduledToday.getDate(), 24);
  assert.equal(scheduledToday.getHours(), 18);
  assert.equal(scheduledToday.getMinutes(), 0);

  const after = new Date(2026, 8, 24, 18, 33, 0);
  assert.equal(time.nextDailyRunTime(after, 18, true), after.getTime() + 1000);
  const scheduledTomorrow = new Date(time.nextDailyRunTime(after, 18, false));
  assert.equal(scheduledTomorrow.getDate(), 25);
  assert.equal(scheduledTomorrow.getHours(), 18);
});

test('parses, formats and merges full-day and half-day absence entries', () => {
  assert.deepEqual(time.parseAbsenceEntry('2026-10-12'), { date: '2026-10-12', period: 'full', days: 1 });
  assert.deepEqual(time.parseAbsenceEntry('2026-10-13:am'), { date: '2026-10-13', period: 'am', days: 0.5 });
  assert.deepEqual(time.parseAbsenceEntry('2026-10-14:pm'), { date: '2026-10-14', period: 'pm', days: 0.5 });
  assert.equal(time.parseAbsenceEntry('invalid'), null);

  assert.equal(time.formatAbsenceEntry('2026-10-12', 'full'), '2026-10-12');
  assert.equal(time.formatAbsenceEntry('2026-10-13', 'am'), '2026-10-13:am');
  assert.equal(time.formatAbsenceEntry('2026-10-14', 'pm'), '2026-10-14:pm');

  const map = time.absenceMapFromList(['2026-10-12', '2026-10-13:am', '2026-10-14:am', '2026-10-14:pm']);
  assert.equal(map.get('2026-10-12'), 'full');
  assert.equal(map.get('2026-10-13'), 'am');
  assert.equal(map.get('2026-10-14'), 'full');

  const merged = time.mergeAbsenceLists(['2026-10-12', '2026-10-13:am'], ['2026-10-12:pm', '2026-10-15:am']);
  assert.deepEqual(merged, ['2026-10-12:pm', '2026-10-13:am', '2026-10-15:am']);
  assert.equal(time.absencePeriodForDate(merged, '2026-10-12'), 'pm');
});

test('computes expected hours and work start times for half-day absences', () => {
  assert.equal(time.expectedHoursForDay(7, null), 7);
  assert.equal(time.expectedHoursForDay(7, 'full'), 0);
  assert.equal(time.expectedHoursForDay(7, 'am'), 3.5);
  assert.equal(time.expectedHoursForDay(8, 'pm'), 4);

  assert.equal(time.workStartForDay('09:00', '14:00', null), '09:00');
  assert.equal(time.workStartForDay('09:00', '14:00', 'pm'), '09:00');
  assert.equal(time.workStartForDay('09:00', '14:00', 'am'), '14:00');

  const afternoonPlan = time.planAutoWorklogs(
    [{ key: 'APP-1', isReview: false, reviewMinute: null }],
    time.expectedHoursForDay(7, 'am'),
    time.workStartForDay('09:00', '14:00', 'am'),
  );
  assert.deepEqual(afternoonPlan, [{ issueKey: 'APP-1', time: '14:00', seconds: 12600 }]);
});

test('supports split half-day OOF + half-day Vacation on the same day', () => {
  assert.deepEqual(time.periodsFromDayHalves('oof', 'vacation'), { oofPeriod: 'am', vacationPeriod: 'pm' });
  assert.deepEqual(time.periodsFromDayHalves('vacation', 'oof'), { oofPeriod: 'pm', vacationPeriod: 'am' });
  assert.deepEqual(time.periodsFromDayHalves('oof', 'oof'), { oofPeriod: 'full', vacationPeriod: null });
  assert.deepEqual(time.periodsFromDayHalves('vacation', 'vacation'), { oofPeriod: null, vacationPeriod: 'full' });
  assert.deepEqual(time.periodsFromDayHalves('none', 'oof'), { oofPeriod: 'pm', vacationPeriod: null });
  assert.deepEqual(time.periodsFromDayHalves('vacation', 'none'), { oofPeriod: null, vacationPeriod: 'am' });
  assert.deepEqual(time.periodsFromDayHalves(null, 'invalid'), { oofPeriod: null, vacationPeriod: null });

  const split = time.combinedDayAbsence('am', 'pm');
  assert.equal(split.am, 'oof');
  assert.equal(split.pm, 'vacation');
  assert.equal(split.oof, 'am');
  assert.equal(split.vacation, 'pm');
  assert.equal(split.oofPeriod, 'am');
  assert.equal(split.vacationPeriod, 'pm');
  assert.equal(split.hasAbsence, true);
  assert.equal(split.isSplit, true);
  assert.equal(split.isFull, true);
  assert.equal(split.isHalf, false);
  assert.equal(split.occupiedPeriod, 'full');
  assert.equal(split.primaryType, 'split');
  assert.equal(split.oofDays, 0.5);
  assert.equal(split.vacationDays, 0.5);
  assert.equal(split.totalDays, 1);
  assert.equal(time.expectedHoursForDay(7, split.occupiedPeriod), 0);

  const reverseSplit = time.combinedDayAbsence('pm', 'am');
  assert.equal(reverseSplit.am, 'vacation');
  assert.equal(reverseSplit.pm, 'oof');
  assert.equal(reverseSplit.oofPeriod, 'pm');
  assert.equal(reverseSplit.vacationPeriod, 'am');
  assert.equal(reverseSplit.isSplit, true);
  assert.equal(reverseSplit.isFull, true);

  const fullOof = time.combinedDayAbsence('full', null);
  assert.equal(fullOof.oofPeriod, 'full');
  assert.equal(fullOof.vacationPeriod, null);
  assert.equal(fullOof.primaryType, 'oof');
  assert.equal(fullOof.isFull, true);
  assert.equal(fullOof.isSplit, false);

  const fullVac = time.combinedDayAbsence('none', 'full');
  assert.equal(fullVac.oofPeriod, null);
  assert.equal(fullVac.vacationPeriod, 'full');
  assert.equal(fullVac.primaryType, 'vacation');
  assert.equal(fullVac.isFull, true);

  const pmVac = time.combinedDayAbsence(null, 'pm');
  assert.equal(pmVac.oofPeriod, null);
  assert.equal(pmVac.vacationPeriod, 'pm');
  assert.equal(pmVac.occupiedPeriod, 'pm');
  assert.equal(pmVac.isHalf, true);
  assert.equal(pmVac.primaryType, 'vacation');

  const none = time.combinedDayAbsence(null, null);
  assert.equal(none.hasAbsence, false);
  assert.equal(none.occupiedPeriod, null);
  assert.equal(none.primaryType, null);
  assert.equal(none.totalDays, 0);
});

test('handles timezone fallbacks, time helpers, and object-based absence entries', () => {
  const fallbackTz = time.effectiveTimeZone('Invalid/Time_Zone_Name');
  assert.equal(typeof fallbackTz, 'string');
  assert.ok(fallbackTz.length > 0);

  assert.equal(time.formatOffset(-150), '-0230');
  assert.equal(time.timeToMinutes('invalid'), 540);
  assert.equal(time.timeToMinutes(''), 540);
  assert.equal(time.minutesToTime(-10), '00:00');
  assert.equal(time.minutesToTime(2000), '23:59');
  assert.equal(time.roundToHalfHour(), 0);
  assert.equal(time.roundToHalfHour(3.26), 3.5);

  assert.equal(time.normalizeAbsencePeriod('morning'), 'am');
  assert.equal(time.normalizeAbsencePeriod('afternoon'), 'pm');
  assert.equal(time.normalizeAbsencePeriod(''), 'full');
  assert.equal(time.normalizeAbsencePeriod(null), 'full');
  assert.equal(time.normalizeAbsencePeriod('invalid'), null);

  assert.equal(time.absenceDaysForPeriod(null), 0);
  assert.equal(time.absenceDaysForPeriod('none'), 0);
  assert.equal(time.absenceDaysForPeriod('invalid'), 0);
  assert.equal(time.absenceDaysForPeriod('full'), 1);
  assert.equal(time.absenceDaysForPeriod('am'), 0.5);
  assert.equal(time.absenceDaysForPeriod('pm'), 0.5);

  assert.equal(time.parseAbsenceEntry(null), null);
  assert.equal(time.parseAbsenceEntry(['2026-10-12']), null);
  assert.deepEqual(time.parseAbsenceEntry({ date: '2026-10-12', period: 'morning' }), {
    date: '2026-10-12',
    period: 'am',
    days: 0.5,
  });
  assert.equal(time.parseAbsenceEntry({ date: 'bad-date', period: 'am' }), null);
  assert.equal(time.parseAbsenceEntry({ date: '2026-10-12', period: 'bad' }), null);
  assert.equal(time.parseAbsenceEntry({ period: 'am' }), null);

  assert.equal(time.formatAbsenceEntry('2026-10-12'), '2026-10-12');
  assert.equal(time.formatAbsenceEntry('2026-10-12', 'invalid'), '2026-10-12');

  const map = time.absenceMapFromList(['2026-10-15:pm', '2026-10-15:am', 'bad']);
  assert.equal(map.get('2026-10-15'), 'full');
  assert.equal(time.absenceMapFromList(null).size, 0);
  assert.deepEqual(time.mergeAbsenceLists(null, null), []);
  assert.equal(time.absencePeriodForDate(null, '2026-10-15'), null);
  assert.equal(time.absencePeriodForDate(map, '2026-10-15'), 'full');
  assert.equal(time.absencePeriodForDate(map, '2026-10-99'), null);
  assert.equal(time.absencePeriodForDate(['2026-10-15:am'], '2026-10-99'), null);

  assert.equal(time.expectedHoursForDay(0, null), 7);
  assert.equal(time.expectedHoursForDay('invalid', 'am'), 3.5);
  assert.equal(time.expectedHoursForDay(7, 'none'), 7);
  assert.equal(time.expectedHoursForDay(7, 'invalid'), 7);

  assert.equal(time.workStartForDay('', '', 'am'), '14:00');
  assert.equal(time.workStartForDay('bad', 'bad', 'none'), '09:00');
  assert.equal(time.shouldUseAssignmentHistory(null, '2026-09-23'), false);

  assert.deepEqual(time.planAutoWorklogs([], 7, '09:00'), []);
  assert.deepEqual(time.planAutoWorklogs([{ key: 'APP-1', reviewMinute: 8 * 60 }], 7, '09:00'), []);
  assert.deepEqual(time.planAutoWorklogs([
    { key: 'APP-1', reviewMinute: 9 * 60 + 30 },
    { key: 'APP-2', reviewMinute: 11 * 60 },
  ], 0.5, '09:00'), [
    { issueKey: 'APP-1', time: '09:00', seconds: 1800 },
  ]);
});
