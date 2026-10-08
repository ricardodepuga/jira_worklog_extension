const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../src/shared/diagnostics-utils.js');

test('keeps only the five most recent diagnostic errors', () => {
  let entries = [];
  for (let index = 1; index <= 7; index += 1) {
    const entry = diagnostics.createDiagnosticEntry(
      new Error(`Failure ${index}`),
      'Auto-log',
      `2026-09-24T10:0${index}:00.000Z`,
      String(index),
    );
    entries = diagnostics.keepLatestDiagnostics(entries, entry);
  }

  assert.deepEqual(entries.map((entry) => entry.id), ['3', '4', '5', '6', '7']);
});

test('truncates diagnostic content before persisting it', () => {
  const entry = diagnostics.createDiagnosticEntry(
    { message: 'x'.repeat(800), stack: 's'.repeat(2500) },
    'c'.repeat(150),
    '2026-09-24T10:00:00.000Z',
    'entry',
  );

  assert.equal(entry.context.length, 120);
  assert.equal(entry.message.length, 600);
  assert.equal(entry.stack.length, 2000);
});
