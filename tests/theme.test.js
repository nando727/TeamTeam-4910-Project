// Sprint 9: daylight and night palettes, chosen with a header toggle,
// defaulting to the computer's own setting.
//
// The things worth testing here are the ones that break quietly: a colour
// written straight into a rule works in one mode and is wrong in the other,
// and the two night palettes (one per selector) drift apart the moment
// somebody edits only one of them.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const { app } = require('../src/app');
const { hashPassword } = require('../src/auth/password');

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const themeScript = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');

// Every `--token: value;` declaration inside one block, as a map.
function tokensOf(block) {
  const map = {};
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) map[name] = value.trim();
  return map;
}
// The body of the first rule whose selector matches, braces balanced.
function blockFor(selector) {
  const start = css.indexOf(selector);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unbalanced rule: ${selector}`);
}

describe('the palettes', () => {
  const light = tokensOf(blockFor(':root {'));
  const mediaDark = tokensOf(blockFor(':root:not([data-theme="light"]) {'));
  const attributeDark = tokensOf(blockFor(':root[data-theme="dark"] {'));

  test('the daylight palette defines every token the night ones do', () => {
    expect(Object.keys(light).length).toBeGreaterThan(40);
    expect(Object.keys(mediaDark).sort()).toEqual(Object.keys(attributeDark).sort());
    for (const name of Object.keys(mediaDark)) {
      expect(light, `--${name} has no daylight value`).toHaveProperty(name);
    }
  });

  test('the two night palettes are identical, so neither can drift', () => {
    expect(mediaDark).toEqual(attributeDark);
  });

  test('the night palette actually differs, and names itself to the browser', () => {
    expect(mediaDark['--bg']).not.toBe(light['--bg']);
    expect(mediaDark['--text']).not.toBe(light['--text']);
    expect(mediaDark['--surface']).not.toBe(light['--surface']);
    // So form controls, scrollbars, and the like follow the page.
    expect(blockFor(':root {')).toContain('color-scheme: light');
    expect(blockFor(':root[data-theme="dark"] {')).toContain('color-scheme: dark');
    expect(blockFor(':root:not([data-theme="light"]) {')).toContain('color-scheme: dark');
  });

  test('an explicit daylight choice wins on a computer set to dark', () => {
    // The guard is what makes the toggle work in that direction at all.
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  test('no rule outside the palettes names a colour of its own', () => {
    // Token blocks may hold colours; nothing else may. A hex code added to a
    // rule below would look right in one mode and wrong in the other.
    const withoutTokenBlocks = css.replace(/:root[^{]*\{[^}]*\}/g, '');
    const offenders = withoutTokenBlocks.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(/.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'));
    expect(offenders.map(([line, text]) => `${line}: ${text.trim()}`)).toEqual([]);
  });

  test('both palettes keep a readable pairing for the things drawn on a colour', () => {
    // Each of these is a filled surface and the text on it; a palette that
    // defines one without the other is how white-on-pale-blue happens.
    for (const palette of [light, mediaDark]) {
      for (const [surface, ink] of [['--accent', '--on-accent'], ['--danger-bg', '--on-danger'], ['--green', '--on-green'], ['--warn-button', '--on-warn']]) {
        expect(palette).toHaveProperty(surface);
        expect(palette).toHaveProperty(ink);
      }
    }
  });

  test('printing forces the daylight values, so a page printed at night is readable', () => {
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toContain('--surface: var(--paper)');
    expect(print).toContain('--text:');
    expect(print).toContain('--surface-muted: var(--paper)');
    // And the toggle is not printed: it is of no use on paper.
    expect(print).toMatch(/\.theme-toggle[^{]*\{[^}]*display: none/);
  });
});

describe('the toggle script', () => {
  test('applies the saved choice before the first paint and survives blocked storage', () => {
    expect(themeScript).toContain("localStorage.getItem");
    expect(themeScript).toContain("setAttribute('data-theme'");
    expect(themeScript).toContain("classList.add('theme-ready')");
    // Reading and writing storage are both guarded: a private window throws.
    expect(themeScript.match(/try \{/g).length).toBeGreaterThanOrEqual(2);
    expect(themeScript).toContain("'(prefers-color-scheme: dark)'");
    expect(themeScript).not.toMatch(/import |require\(|https?:\/\//);
  });

  test('only a value it wrote itself is trusted from storage', () => {
    expect(themeScript).toContain("value === 'dark' || value === 'light' ? value : null");
  });
});

describe('every page', () => {
  let hash;
  beforeAll(async () => { hash = await hashPassword('Password1!'); });
  beforeEach(() => {
    vi.spyOn(db, 'query').mockImplementation(async (sql, params = []) => {
      if (sql.includes('latest_failure')) return [{ failures: 0, latest_failure: null }];
      if (sql.startsWith('INSERT INTO login_attempts')) return {};
      if (sql.startsWith('SELECT sessions_valid_from')) return [{ revoked: 0 }];
      if (sql.includes('FROM users WHERE username')) {
        return [{ id: 1, username: params[0], role: 'driver', status: 'active', sponsor_id: null, password_hash: hash }];
      }
      if (sql.includes('FROM users WHERE id')) return [{ id: 1, username: 'driver1', role: 'driver', status: 'active' }];
      return [];
    });
  });
  afterEach(() => vi.restoreAllMocks());

  test('loads the theme script in the head, before the stylesheet, on a signed-out page', async () => {
    const res = await request(app).get('/login').expect(200);
    const theme = res.text.indexOf('/theme.js');
    const styles = res.text.indexOf('/styles.css');
    expect(theme).toBeGreaterThan(-1);
    expect(theme).toBeLessThan(styles);
    // Not deferred: a deferred script would run after the first paint.
    expect(res.text).toContain('<script src="/theme.js"></script>');
  });

  test('offers the toggle in the header, signed in and signed out', async () => {
    const out = await request(app).get('/login').expect(200);
    expect(out.text).toContain('data-theme-toggle');
    expect(out.text).toContain('theme-toggle__sun');
    expect(out.text).toContain('theme-toggle__moon');
    const agent = request.agent(app);
    await agent.post('/login').type('form').send({ username: 'driver1', password: 'Password1!' }).expect(302);
    const home = await agent.get('/').expect(200);
    expect(home.text).toContain('data-theme-toggle');
  });

  test('the toggle is a real button with a label, not an empty icon', async () => {
    const res = await request(app).get('/login').expect(200);
    expect(res.text).toMatch(/<button class="theme-toggle" type="button"/);
    expect(res.text).toContain('aria-pressed="false"');
    expect(res.text).toContain('data-theme-label');
  });
});
