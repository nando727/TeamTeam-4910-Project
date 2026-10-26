// RC#1: the pipe-delimited file format, defined once in src/bulk/parser.js.
import { createRequire } from 'node:module';
import { describe, test, expect } from 'vitest';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { FORMAT, describeFormat, parseLine, parseText, parseStream } = require('../src/bulk/parser');

describe('format definition', () => {
  test('is pipe-delimited with no header and exactly O, S, and D rows (no admin rows)', () => {
    expect(FORMAT.delimiter).toBe('|');
    expect(FORMAT.headerLine).toBe(false);
    expect(Object.keys(FORMAT.rows)).toEqual(['O', 'S', 'D']);
    expect(describeFormat()).toEqual([
      'O|organization name',
      'S|organization name|first name|last name|email',
      'D|organization name|first name|last name|email|[points]|[reason]',
    ]);
  });
});

describe('parseLine', () => {
  test('O, S, and D rows parse into typed rows; surrounding spaces and CR are ignored', () => {
    expect(parseLine('O| Coastal Carriers \r', 1)).toMatchObject({ ok: true, row: { type: 'O', organization: 'Coastal Carriers' } });
    expect(parseLine('s|Coastal Carriers|Casey|Coastal|casey@example.com', 2)).toMatchObject({
      ok: true, row: { type: 'S', organization: 'Coastal Carriers', firstName: 'Casey', lastName: 'Coastal', email: 'casey@example.com' },
    });
    expect(parseLine('D|Coastal Carriers|Pat|Driver|pat@example.com', 3)).toMatchObject({ ok: true, row: { type: 'D', points: null, reason: null } });
    expect(parseLine('D|Coastal Carriers|Robin|Rider|robin@example.com|150|Welcome bonus', 4)).toMatchObject({ ok: true, row: { points: 150, reason: 'Welcome bonus' } });
    expect(parseLine('D|Coastal Carriers|Alex|Able|alex@example.com|-20|Late paperwork', 5)).toMatchObject({ ok: true, row: { points: -20 } });
  });

  test('blank lines are skipped', () => {
    expect(parseLine('', 1)).toBeNull();
    expect(parseLine('   \r', 2)).toBeNull();
  });

  test.each([
    ['A|Org|Max|Mallory|max@example.com', 'Admin users cannot be created by upload.'],
    ['X|Org', 'Unknown row type "X". Use O, S, D.'],
    ['O|', 'Missing organization name.'],
    ['O', 'A organization row needs at least 1 field'],
    ['S|Org|Casey|Coastal', 'A sponsor user row needs at least 4 fields'],
    ['S|Org|Casey|Coastal|casey@example.com|extra', 'A sponsor user row has at most 4 fields'],
    ['D|Org|Pat|Driver|pat@example.com|10|Reason|extra', 'A driver user row has at most 6 fields'],
    ['D||Pat|Driver|pat@example.com', 'Missing organization name.'],
    ['D|Org||Driver|pat@example.com', 'Missing first name.'],
    ['D|Org|Pat|Driver|not-an-email', '"not-an-email" is not a valid email address.'],
    ['D|Org|Pat|Driver|pat@example.com|75', 'Points were given without a reason. Every point change needs a reason.'],
    ['D|Org|Pat|Driver|pat@example.com||Just because', 'A reason was given but no points.'],
    ['D|Org|Pat|Driver|pat@example.com|ten|Reason', 'Points must be a whole number, not "ten".'],
    ['D|Org|Pat|Driver|pat@example.com|0|Reason', 'Points must not be zero.'],
    ['D|Org|Pat|Driver|pat@example.com|99999999999|Reason', 'Points value is too large.'],
  ])('%s -> error', (line, message) => {
    const item = parseLine(line, 7);
    expect(item.ok).toBe(false);
    expect(item.line).toBe(7);
    expect(item.error).toContain(message);
  });

  test('field length limits are enforced', () => {
    expect(parseLine(`O|${'x'.repeat(256)}`, 1).error).toContain('organization name is longer than 255');
    expect(parseLine(`D|Org|Pat|Driver|pat@example.com|5|${'r'.repeat(256)}`, 1).error).toContain('reason is longer than 255');
  });
});

describe('parseText and parseStream', () => {
  const text = 'O|Org\n\nS|Org|A|B|a@b.com\r\nD|Org|C|D|bad\n';
  test('number lines including blank ones, and report each row independently', () => {
    const items = parseText(text);
    expect(items.map(i => [i.line, i.ok])).toEqual([[1, true], [3, true], [4, false]]);
  });
  test('the stream parser yields the same items line by line', async () => {
    const items = [];
    for await (const item of parseStream(Readable.from([text.slice(0, 10), text.slice(10)]))) items.push(item);
    expect(items.map(i => [i.line, i.ok])).toEqual([[1, true], [3, true], [4, false]]);
  });
});
