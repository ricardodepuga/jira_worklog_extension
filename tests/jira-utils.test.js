const test = require('node:test');
const assert = require('node:assert/strict');
const { findStoryPointsFieldIds, isRetryableJiraStatus, shouldTryAlternateJiraEndpoint, activeWorkflowStatuses, effectiveStatusIds, relevantWorkflowStatuses, isLegacyBroadStatusSelection, manualIssueKeys } = require('../src/shared/jira-utils.js');

test('finds all Jira Story Points fields and prioritizes standard names', () => {
  assert.deepEqual(findStoryPointsFieldIds([
    { id: 'summary', name: 'Summary' },
    { id: 'customfield_10030', name: 'Team Story Points' },
    { id: 'customfield_10016', name: 'Story point estimate' },
    { id: 'customfield_10020', name: 'Story Points' },
  ]), ['customfield_10016', 'customfield_10020', 'customfield_10030']);
});

test('ignores non-custom fields and unrelated estimates', () => {
  assert.deepEqual(findStoryPointsFieldIds([
    { id: 'timeestimate', name: 'Remaining Estimate' },
    { id: 'storypoints', name: 'Story Points' },
    { id: 'customfield_10042', name: 'Effort' },
  ]), []);
});

test('retries only transient Jira response statuses', () => {
  assert.equal(isRetryableJiraStatus(429), true);
  assert.equal(isRetryableJiraStatus(503), true);
  assert.equal(isRetryableJiraStatus(401), false);
  assert.equal(isRetryableJiraStatus(404), false);
});

test('tries the alternate Jira endpoint when authentication discovery is ambiguous', () => {
  assert.equal(shouldTryAlternateJiraEndpoint(401, '/issue/APP-1', true), true);
  assert.equal(shouldTryAlternateJiraEndpoint(403, '/issue/APP-1', false), true);
  assert.equal(shouldTryAlternateJiraEndpoint(403, '/issue/APP-1', true), false);
  assert.equal(shouldTryAlternateJiraEndpoint(404, '/myself', true), true);
  assert.equal(shouldTryAlternateJiraEndpoint(404, '/issue/APP-1', false), false);
});

test('builds direct Jira keys from a full key or a numeric task reference', () => {
  assert.deepEqual(manualIssueKeys('app-123'), ['APP-123']);
  assert.deepEqual(manualIssueKeys('123', ['APP', 'WEB', 'APP', 'invalid-key']), ['APP-123', 'WEB-123']);
  assert.deepEqual(manualIssueKeys('login problem', ['APP']), []);
});

test('builds separate default status filters for auto-log and task lists', () => {
  const statuses = [
    { id: '1', name: 'To Do', statusCategory: { name: 'To Do' } },
    { id: '3', name: 'In Progress', statusCategory: { name: 'In Progress' } },
    { id: '4', name: 'Review', statusCategory: { name: 'In Progress' } },
    { id: '5', name: 'Verified', statusCategory: { name: 'In Progress' } },
    { id: '6', name: 'Done', statusCategory: { name: 'Done' } },
    { id: '7', name: 'Sprint 44 -Done', statusCategory: { name: 'In Progress' } },
    { id: '8', name: 'Sprint 44 - In Progress', statusCategory: { name: 'In Progress' } },
  ];
  assert.deepEqual(activeWorkflowStatuses(statuses), [
    { id: '3', ids: ['3', '8'], name: 'In Progress' },
    { id: '4', ids: ['4'], name: 'Review' },
    { id: '5', ids: ['5'], name: 'Verified' },
  ]);
  assert.deepEqual(effectiveStatusIds(null, statuses, 'autoLog'), ['3', '8', '4']);
  assert.deepEqual(effectiveStatusIds(null, statuses, 'taskList'), ['3', '8', '4']);
  assert.deepEqual(effectiveStatusIds(['5', 'missing', '5'], statuses, 'autoLog'), ['5']);
  assert.deepEqual(effectiveStatusIds([], statuses, 'taskList'), []);
  assert.deepEqual(relevantWorkflowStatuses(statuses, ['5'], ['3']), [
    { id: '3', ids: ['3', '8'], name: 'In Progress' },
    { id: '5', ids: ['5'], name: 'Verified' },
  ]);
  assert.equal(isLegacyBroadStatusSelection(Array.from({ length: 21 }, (_, index) => index)), true);
  assert.equal(isLegacyBroadStatusSelection(['3', '4', '5']), false);
});
