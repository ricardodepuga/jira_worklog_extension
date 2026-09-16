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
