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
