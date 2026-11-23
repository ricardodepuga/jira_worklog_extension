const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../src/shared/time-utils.js');

// ---------------------------------------------------------------------------
// Minimal DOM implementation for testing calendar.js in Node without external deps
// ---------------------------------------------------------------------------

function decodeEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function camelCaseDataKey(k) {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'path']);
const elementRegistry = new Map();

class MiniElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = String(tagName || 'div').toUpperCase();
    this._id = id || '';
    this._className = '';
    this._classes = new Set();
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.type = '';
    this.clientHeight = 600;
    this._textContent = '';
    this._listeners = {};
    this._boundingRect = { left: 100, top: 100, right: 580, bottom: 500, width: 480, height: 400 };
    if (this._id) elementRegistry.set(this._id, this);

    const self = this;
    this.classList = {
      add: (...cls) => {
        cls.filter(Boolean).forEach((c) => self._classes.add(c));
        self._className = [...self._classes].join(' ');
      },
      remove: (...cls) => {
        cls.forEach((c) => self._classes.delete(c));
        self._className = [...self._classes].join(' ');
      },
      toggle: (c, force) => {
        const shouldHave = force === undefined ? !self._classes.has(c) : Boolean(force);
        if (shouldHave) self._classes.add(c);
        else self._classes.delete(c);
        self._className = [...self._classes].join(' ');
        return shouldHave;
      },
      contains: (c) => self._classes.has(c),
    };
  }

  get id() {
    return this._id;
  }
  set id(val) {
    this._id = String(val || '');
    if (this._id) elementRegistry.set(this._id, this);
  }

  get className() {
    return this._className;
  }
  set className(val) {
    this._className = String(val || '');
    this._classes = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(val) {
    this.children = [];
    this._textContent = String(val ?? '');
    if (this.tagName === 'TEXTAREA') this.value = this._textContent;
  }

  get firstChild() {
    if (!this.children.length) {
      const textNode = new MiniElement('#text');
      textNode._textContent = this._textContent;
      this.children.push(textNode);
    }
    return this.children[0];
  }

  get selectedOptions() {
    const opts = this.querySelectorAll('option');
    const selected = opts.filter((o) => o.selected);
    return selected.length ? selected : opts.slice(0, 1);
  }

  setAttribute(name, value) {
    const v = String(value ?? '');
    this.attributes[name] = v;
    if (name === 'id') this.id = v;
    else if (name === 'class') this.className = v;
    else if (name === 'value') this.value = v;
    else if (name === 'type') this.type = v;
    else if (name === 'disabled') this.disabled = true;
    else if (name === 'checked') this.checked = true;
    else if (name === 'hidden') this.hidden = true;
    else if (name.startsWith('data-')) {
      this.dataset[camelCaseDataKey(name.slice(5))] = v;
    }
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'disabled') this.disabled = false;
    if (name === 'style') this.style = {};
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        const t = new MiniElement('#text');
        t._textContent = node;
        t.parentNode = this;
        this.children.push(t);
      } else if (node instanceof MiniElement) {
        node.parentNode = this;
        this.children.push(node);
        registerSubtreeIds(node);
      }
    }
  }

  appendChild(node) {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._textContent = '';
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
  }

  contains(target) {
    let cur = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    while (cur && cur instanceof MiniElement) {
      if (matchesSimpleSelector(cur, selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return this._boundingRect;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }

  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter((item) => item !== fn);
  }

  dispatchEvent(event) {
    const evt = event instanceof Object ? event : { type: String(event) };
    if (!evt.target) {
      try {
        evt.target = this;
      } catch {
        Object.defineProperty(evt, 'target', { value: this, configurable: true });
      }
    }
    if (typeof evt.preventDefault !== 'function') {
      evt.defaultPrevented = false;
      evt.preventDefault = () => { evt.defaultPrevented = true; };
    }
    if (typeof evt.stopPropagation !== 'function') {
      evt.stopPropagation = () => { evt._stopped = true; };
    }
    const list = (this._listeners[evt.type] || []).slice();
    for (const fn of list) {
      fn(evt);
    }
    return !evt.defaultPrevented;
  }

  click(extra = {}) {
    return this.dispatchEvent({ type: 'click', target: this, ...extra });
  }

  get innerHTML() {
    return serializeChildren(this);
  }

  set innerHTML(html) {
    this.children = [];
    this._textContent = '';
    const parsed = parseHtmlFragment(String(html || ''), this);
    this.children = parsed;
    registerSubtreeIds(this);
  }

  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    let currentSet = [this];
    for (const part of parts) {
      const nextSet = [];
      for (const root of currentSet) {
        collectDescendants(root, (el) => matchesSimpleSelector(el, part), nextSet);
      }
      currentSet = [...new Set(nextSet)];
    }
    return currentSet;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function registerSubtreeIds(root) {
  if (root._id) elementRegistry.set(root._id, root);
  for (const child of root.children || []) {
    registerSubtreeIds(child);
  }
}

function collectDescendants(node, predicate, out) {
  for (const child of node.children || []) {
    if (child.tagName !== '#TEXT') {
      if (predicate(child)) out.push(child);
      collectDescendants(child, predicate, out);
    }
  }
}

function matchesSimpleSelector(el, selector) {
  if (!el || el.tagName === '#TEXT') return false;
  let rem = selector;

  // Pseudo :checked
  if (rem.endsWith(':checked')) {
    if (!el.checked) return false;
    rem = rem.slice(0, -8);
  }

  // Attribute selectors e.g. [data-date], [type="checkbox"], [data-half-slot="am"]
  const attrRegex = /\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = attrRegex.exec(rem)) !== null) {
    const attrName = m[1];
    const attrVal = m[2];
    const hasAttr = attrName in el.attributes || (attrName.startsWith('data-') && camelCaseDataKey(attrName.slice(5)) in el.dataset);
    if (!hasAttr) return false;
    if (attrVal !== undefined) {
      const actual = el.attributes[attrName] ?? el.dataset[camelCaseDataKey(attrName.slice(5))];
      if (String(actual) !== attrVal) return false;
    }
  }
  rem = rem.replace(attrRegex, '');

  // ID selector
  const idMatch = rem.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    if (el.id !== idMatch[1]) return false;
    rem = rem.replace(idMatch[0], '');
  }

  // Class selectors
  const classRegex = /\.([a-zA-Z0-9_-]+)/g;
  while ((m = classRegex.exec(rem)) !== null) {
    if (!el.classList.contains(m[1])) return false;
  }
  rem = rem.replace(classRegex, '');

  // Tag name
  if (rem && rem.toUpperCase() !== el.tagName) return false;
  return true;
}

function parseAttributes(attrStr, el) {
  const regex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = regex.exec(attrStr)) !== null) {
    const name = match[1];
    const rawVal = match[2] ?? match[3] ?? match[4] ?? '';
    el.setAttribute(name, decodeEntities(rawVal));
  }
}

function parseHtmlFragment(html, parent) {
  const root = { children: [], parentNode: null };
  const stack = [root];
  const tokenRegex = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9_-]+)\s*>|<([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match;
  while ((match = tokenRegex.exec(html)) !== null) {
    const [, closeTag, openTag, attrStr, selfClose, textNode] = match;
    const current = stack[stack.length - 1];
    if (closeTag) {
      const upper = closeTag.toUpperCase();
      if (stack.length > 1 && stack[stack.length - 1].tagName === upper) {
        const finished = stack.pop();
        if (finished.tagName === 'TEXTAREA') {
          finished.value = finished.textContent;
        }
      }
    } else if (openTag) {
      const el = new MiniElement(openTag);
      parseAttributes(attrStr || '', el);
      el.parentNode = current === root ? parent : current;
      current.children.push(el);
      if (!selfClose && !VOID_TAGS.has(openTag.toLowerCase())) {
        stack.push(el);
      }
    } else if (textNode) {
      const decoded = decodeEntities(textNode);
      if (decoded) {
        const t = new MiniElement('#text');
        t._textContent = decoded;
        t.parentNode = current === root ? parent : current;
        current.children.push(t);
      }
    }
  }
  return root.children;
}

function serializeChildren(el) {
  return (el.children || [])
    .map((c) => {
      if (c.tagName === '#TEXT') return c._textContent;
      const tag = c.tagName.toLowerCase();
      const attrs = Object.entries(c.attributes || {})
        .map(([k, v]) => (v === '' ? k : `${k}="${v}"`))
        .join(' ');
      const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
      if (VOID_TAGS.has(tag)) return open;
      return `${open}${serializeChildren(c)}</${tag}>`;
    })
    .join('');
}

// Parse actual calendar.html so all real IDs and initial structure exist
const calendarHtmlPath = path.resolve(__dirname, '../src/frontend/calendar/calendar.html');
const calendarHtml = fs.readFileSync(calendarHtmlPath, 'utf8');
const bodyRoot = new MiniElement('body');
bodyRoot.innerHTML = calendarHtml;

const docListeners = {};
globalThis.document = {
  body: bodyRoot,
  activeElement: null,
  getElementById: (id) => elementRegistry.get(id) || bodyRoot.querySelector(`#${id}`) || new MiniElement('div', id),
  querySelectorAll: (sel) => bodyRoot.querySelectorAll(sel),
  querySelector: (sel) => bodyRoot.querySelector(sel),
  createElement: (tag) => new MiniElement(tag),
  createTextNode: (text) => {
    const t = new MiniElement('#text');
    t._textContent = String(text ?? '');
    return t;
  },
  addEventListener: (type, fn) => {
    (docListeners[type] ||= []).push(fn);
  },
  dispatchEvent: (event) => {
    for (const fn of docListeners[event.type] || []) fn(event);
  },
};

const winListeners = {};
globalThis.window = {
  innerHeight: 800,
  innerWidth: 1280,
  addEventListener: (type, fn) => {
    (winListeners[type] ||= []).push(fn);
  },
  dispatchEvent: (event) => {
    for (const fn of winListeners[event.type] || []) fn(event);
  },
};
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 1;
};
globalThis.cancelAnimationFrame = () => {};
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.location = { reload: () => {} };
let clipboardText = '';
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'NodeTest/1.0',
    clipboard: {
      writeText: async (text) => { clipboardText = text; },
    },
  },
  configurable: true,
});

const localStore = {};
globalThis.localStorage = {
  getItem: (k) => localStore[k] ?? null,
  setItem: (k, v) => { localStore[k] = String(v); },
  removeItem: (k) => { delete localStore[k]; },
};

const chromeStorage = {
  oofByAccount: {},
  vacationByAccount: {},
  manualHolidays: {},
  settingsSectionState: {},
};

let apiMock = async (route, options = {}) => {
  const url = new URL(route, 'https://extension.local');
  if (url.pathname === '/api/config/status') {
    return { configured: true, site: 'demo.atlassian.net', email: 'ricardo@example.com' };
  }
  if (url.pathname === '/api/me') {
    return { accountId: 'acc-1', displayName: 'Ricardo Puga', email: 'ricardo@example.com', timeZone: 'Europe/Lisbon' };
  }
  if (url.pathname === '/api/settings') {
    return {
      autoLogEnabled: true,
      expectedHours: 7,
      annualVacationDays: 22,
      annualVacationDaysByYear: { '2026': 22 },
      morningStart: '09:00',
      afternoonStart: '14:00',
      holidayCountry: 'PT',
      holidayMode: 'exclude',
      allowUserSwitch: true,
    };
  }
  if (url.pathname === '/api/status-filters') {
    return {
      statuses: [{ id: '3', ids: ['3'], name: 'In Progress' }],
      autoLogStatusIds: ['3'],
      taskListStatusIds: ['3'],
    };
  }
  if (url.pathname === '/api/holidays') {
    return [{ date: '2026-10-05', name: 'Republic Day', localName: 'Implantação da República' }];
  }
  if (url.pathname === '/api/worklogs' && (!options.method || options.method === 'GET')) {
    return { byDate: {} };
  }
  if (url.pathname === '/api/worklogs' && options.method === 'POST') {
    return { ok: true, worklogId: 'w-new' };
  }
  if (url.pathname.startsWith('/api/worklogs/') && (options.method === 'PUT' || options.method === 'DELETE')) {
    return { ok: true };
  }
  if (url.pathname === '/api/issues/open') {
    return [
      { key: 'PROJ-101', projectKey: 'PROJ', summary: 'First open task', status: 'In Progress' },
      { key: 'PROJ-102', projectKey: 'PROJ', summary: 'Second open task', status: 'Review' },
    ];
  }
  if (url.pathname === '/api/issues/search') {
    return [
      { key: 'PROJ-205', projectKey: 'PROJ', summary: 'Searched task', status: 'In Progress' },
    ];
  }
  if (url.pathname.endsWith('/details')) {
    return { loggedSeconds: 7200, storyPoints: 3 };
  }
  if (url.pathname === '/api/errors') {
    return [];
  }
  if (url.pathname === '/api/auto-log/status') {
    return { checkedAt: '2026-10-14T18:00:00.000Z', outcome: 'success', message: 'Created 1 automatic worklog.' };
  }
  return {};
};

globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: '1.7.0' }),
    sendMessage: async (msg) => {
      try {
        const data = await apiMock(msg.path, msg.options || {});
        return { ok: true, data };
      } catch (err) {
        return { ok: false, error: err.message, code: err.code, site: err.site };
      }
    },
  },
  storage: {
    local: {
      get: async (keys) => {
        if (typeof keys === 'string') return { [keys]: chromeStorage[keys] };
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((k) => [k, chromeStorage[k]]));
        }
        return { ...chromeStorage };
      },
      set: async (patch) => {
        Object.assign(chromeStorage, JSON.parse(JSON.stringify(patch)));
      },
    },
  },
};

const cal = require('../src/frontend/calendar/calendar.js');

test('calendar: allows marking half-day OOF and then marking the other half as Vacation (and vice versa)', async () => {
  await new Promise((r) => setTimeout(r, 20));
  cal.state.me = { accountId: 'acc-1', displayName: 'Ricardo Puga', email: 'ricardo@example.com' };
  cal.state.user = cal.state.me;
  cal.state.byDate = {};
  chromeStorage.oofByAccount = {};
  chromeStorage.vacationByAccount = {};

  const dateStr = '2026-10-14';

  // Step 1: Mark Morning as OOF via setOofDate
  await cal.setOofDate('acc-1', dateStr, 'am');
  cal.state.oofDates = await cal.loadOofDates('acc-1');
  cal.state.vacationDates = await cal.loadVacationDates('acc-1');

  assert.equal(cal.oofPeriod(dateStr), 'am');
  assert.equal(cal.vacationPeriod(dateStr), null);
  assert.equal(cal.isHalfAbsence(dateStr), true);
  assert.equal(cal.isFullAbsence(dateStr), false);
  assert.equal(cal.dayExpectedHours(dateStr), 3.5);
  assert.equal(cal.suggestedStartTime(dateStr), '14:00');
  assert.equal(cal.suggestedHours(dateStr), 3.5);

  // Step 2: Open Day Dialog on that date; verify top .absence-selector does NOT highlight full-day OOF for a half-day,
  // and click Afternoon Vacation in the always-visible .absence-halves-box
  cal.renderDayDialogBody(dateStr);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="none"]').classList.contains('active'), false);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="oof"]').classList.contains('active'), false);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="vacation"]').classList.contains('active'), false);

  const pmVacHalfBtn = cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-half-slot="pm"][data-half-cat="vacation"]');
  assert.ok(pmVacHalfBtn, 'Afternoon Vacation button should exist in .absence-halves-box');
  pmVacHalfBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  // Verify the other half (Afternoon / PM) is now Vacation while Morning (AM) stays OOF!
  assert.equal(cal.oofPeriod(dateStr), 'am');
  assert.equal(cal.vacationPeriod(dateStr), 'pm');
  const abs = cal.dayAbsence(dateStr);
  assert.equal(abs.isSplit, true);
  assert.equal(abs.isFull, true);
  assert.equal(abs.am, 'oof');
  assert.equal(abs.pm, 'vacation');
  assert.equal(cal.dayExpectedHours(dateStr), 0);
  assert.deepEqual(cal.absenceInfo(dateStr), {
    type: 'split',
    period: 'full',
    days: 1,
    am: 'oof',
    pm: 'vacation',
    oofPeriod: 'am',
    vacationPeriod: 'pm',
  });

  // Verify Day Dialog renders both Morning and Afternoon half-day breakdown cards active, while top full-day buttons remain inactive
  const amOofBtn = cal.els.dayDialogBody.querySelector('[data-half-slot="am"][data-half-cat="oof"]');
  const pmVacBtn = cal.els.dayDialogBody.querySelector('[data-half-slot="pm"][data-half-cat="vacation"]');
  assert.ok(amOofBtn.classList.contains('active'));
  assert.ok(pmVacBtn.classList.contains('active'));
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="oof"]').classList.contains('active'), false);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="vacation"]').classList.contains('active'), false);
  assert.match(cal.els.dayDialogBody.innerHTML, /Split absence/);

  // Step 3: Use the Half-day breakdown buttons to flip Morning to Vacation -> Full day Vacation highlights top Vacation button
  const amVacBtn = cal.els.dayDialogBody.querySelector('[data-half-slot="am"][data-half-cat="vacation"]');
  amVacBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cal.vacationPeriod(dateStr), 'full');
  assert.equal(cal.oofPeriod(dateStr), null);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="vacation"]').classList.contains('active'), true);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="oof"]').classList.contains('active'), false);

  const pmOofBtn = cal.els.dayDialogBody.querySelector('[data-half-slot="pm"][data-half-cat="oof"]');
  pmOofBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cal.vacationPeriod(dateStr), 'am');
  assert.equal(cal.oofPeriod(dateStr), 'pm');
  assert.equal(cal.dayAbsence(dateStr).isSplit, true);

  // Step 4: Set Afternoon back to Work (none) -> leaves Morning Vacation (0.5d)
  const pmWorkBtn = cal.els.dayDialogBody.querySelector('[data-half-slot="pm"][data-half-cat="none"]');
  pmWorkBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cal.vacationPeriod(dateStr), 'am');
  assert.equal(cal.oofPeriod(dateStr), null);
  assert.equal(cal.isHalfAbsence(dateStr), true);
  assert.equal(cal.dayExpectedHours(dateStr), 3.5);

  // Step 5: Clicking "OOF" in the top .absence-selector sets the full day to OOF (instead of a confusing split)
  cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="oof"]').click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cal.oofPeriod(dateStr), 'full');
  assert.equal(cal.vacationPeriod(dateStr), null);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="oof"]').classList.contains('active'), true);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="vacation"]').classList.contains('active'), false);
});

test('calendar: Month view small day boxes display task-count-badge and inline +N indicator clearly', async () => {
  cal.state.view = 'month';
  cal.state.anchor = new Date(2026, 9, 14);
  cal.state.showWeekends = false;
  cal.state.oofDates = new Map([['2026-10-15', 'am']]);
  cal.state.vacationDates = new Map([['2026-10-15', 'pm']]);
  cal.state.byDate = {
    '2026-10-14': [
      { worklogId: '1', issueKey: 'PROJ-101', issueSummary: 'Task One', seconds: 7200, started: '2026-10-14T09:00:00.000' },
      { worklogId: '2', issueKey: 'PROJ-102', issueSummary: 'Task Two', seconds: 7200, started: '2026-10-14T11:00:00.000' },
      { worklogId: '3', issueKey: 'PROJ-103', issueSummary: 'Task Three', seconds: 10800, started: '2026-10-14T14:00:00.000' },
    ],
    '2026-10-16': [
      { worklogId: '4', issueKey: 'PROJ-104', issueSummary: 'Single Task', seconds: 25200, started: '2026-10-16T09:00:00.000' },
    ],
  };

  // Simulate small day boxes (e.g. 360px grid height across 5 rows -> 72px per row)
  cal.els.calendarGrid.clientHeight = 360;
  assert.equal(cal.monthChipLimit(5), 1);

  cal.renderGrid();

  const multiTaskCell = cal.els.calendarGrid.querySelector('.day-cell[data-date="2026-10-14"]');
  assert.ok(multiTaskCell, 'Day cell for 2026-10-14 should be rendered');

  // 1. Header has .date-num and .task-count-badge ("3 tasks"), while .day-badges is at the bottom of .day-cell
  const cellHeader = multiTaskCell.querySelector('.day-cell-header');
  assert.ok(cellHeader, 'Day cell should have .day-cell-header');
  const countBadge = cellHeader.querySelector('.task-count-badge');
  assert.ok(countBadge, 'Header should display .task-count-badge');
  assert.equal(countBadge.textContent, '3 tasks');
  assert.equal(countBadge.classList.contains('multi'), true);
  assert.equal(cellHeader.querySelector('.hours-badge'), null, 'Hours badge should not be in the top header');

  const elementChildren = multiTaskCell.children.filter((c) => c.tagName !== '#TEXT');
  assert.equal(elementChildren[0].className, 'day-cell-header');
  assert.equal(elementChildren[1].className, 'issue-list');
  assert.equal(elementChildren[2].className, 'day-badges', 'Total hours / day badges should sit at the bottom of .day-cell');
  assert.equal(elementChildren[2].querySelector('.hours-badge').textContent, '7h');

  // 2. Only 1 chip is rendered so it never overflows, and it includes the inline "+2" badge
  const chips = multiTaskCell.querySelectorAll('.chip');
  assert.equal(chips.length, 1);
  const inlineMore = multiTaskCell.querySelector('.chip-more-inline');
  assert.ok(inlineMore, 'Chip should display inline +2 indicator');
  assert.equal(inlineMore.textContent, '+2');
  assert.match(inlineMore.getAttribute('title'), /PROJ-101[\s\S]*PROJ-102[\s\S]*PROJ-103/);

  // 3. Single-task day cell shows "1 task" badge in header, 1 chip without +N, and hours badge at bottom
  const singleTaskCell = cal.els.calendarGrid.querySelector('.day-cell[data-date="2026-10-16"]');
  const singleBadge = singleTaskCell.querySelector('.day-cell-header .task-count-badge');
  assert.ok(singleBadge);
  assert.equal(singleBadge.textContent, '1 task');
  assert.equal(singleBadge.classList.contains('multi'), false);
  assert.equal(singleTaskCell.querySelector('.chip-more-inline'), null);
  assert.equal(singleTaskCell.querySelector('.day-badges .hours-badge').textContent, '7h');

  // 4. Split absence day cell shows both OOF ½ and Vac ½ badges at bottom (without AM/PM text) and split CSS class
  const splitCell = cal.els.calendarGrid.querySelector('.day-cell[data-date="2026-10-15"]');
  assert.equal(splitCell.classList.contains('split-oof-vacation'), true);
  const splitBadges = splitCell.querySelectorAll('.day-badges .hours-badge');
  assert.equal(splitBadges.length, 2);
  assert.equal(splitBadges[0].textContent, 'OOF ½');
  assert.equal(splitBadges[1].textContent, 'Vac ½');
  assert.doesNotMatch(splitCell.querySelector('.day-badges').textContent, /\b(AM|PM)\b/);
  assert.match(splitBadges[0].getAttribute('title'), /Morning: Out of Office/);
  assert.match(splitBadges[1].getAttribute('title'), /Afternoon: Vacation/);

  // Half-day absence cell with worklogs shows absence badge (Vac ½ / OOF ½) on the left and hours badge on the right
  cal.state.vacationDates.set('2026-10-16', 'am');
  cal.state.oofDates.set('2026-10-12', 'pm');
  cal.state.vacationDates.set('2026-10-13', 'am');
  cal.state.oofDates.set('2026-10-13', 'pm');
  cal.renderGrid();
  const halfVacCell = cal.els.calendarGrid.querySelector('.day-cell[data-date="2026-10-16"]');
  const halfVacBadges = halfVacCell.querySelectorAll('.day-badges .hours-badge');
  assert.equal(halfVacBadges.length, 2);
  assert.equal(halfVacBadges[0].textContent, 'Vac ½');
  assert.equal(halfVacBadges[0].classList.contains('vacation-badge'), true);
  assert.equal(halfVacBadges[0].classList.contains('half-badge'), true);
  assert.equal(halfVacBadges[1].textContent, '7h');
  assert.doesNotMatch(halfVacCell.querySelector('.day-badges').textContent, /\b(AM|PM)\b/);

  const halfOofCell = cal.els.calendarGrid.querySelector('.day-cell[data-date="2026-10-12"]');
  const halfOofBadges = halfOofCell.querySelectorAll('.day-badges .hours-badge');
  assert.equal(halfOofBadges.length, 2);
  assert.equal(halfOofBadges[0].textContent, 'OOF ½');
  assert.equal(halfOofBadges[0].classList.contains('oof-badge'), true);
  assert.equal(halfOofBadges[1].textContent, '0h');

  const reverseSplitCell = cal.els.calendarGrid.querySelector('.day-cell[data-date="2026-10-13"]');
  assert.equal(reverseSplitCell.classList.contains('split-vacation-oof'), true);
  const reverseSplitBadges = reverseSplitCell.querySelectorAll('.day-badges .hours-badge');
  assert.equal(reverseSplitBadges.length, 2);
  assert.equal(reverseSplitBadges[0].textContent, 'Vac ½');
  assert.equal(reverseSplitBadges[1].textContent, 'OOF ½');
  assert.doesNotMatch(reverseSplitCell.querySelector('.day-badges').textContent, /\b(AM|PM)\b/);

  // 5. Verify larger grid heights scale monthChipLimit to 2, 3, and 4 while accounting for bottom .day-badges
  cal.els.calendarGrid.clientHeight = 550; // 110px/row -> 1 chip so 2nd chip never clips against bottom .day-badges
  assert.equal(cal.monthChipLimit(5), 1);
  cal.els.calendarGrid.clientHeight = 580; // 116px/row -> 2 chips
  assert.equal(cal.monthChipLimit(5), 2);
  cal.els.calendarGrid.clientHeight = 700; // 140px/row -> 3 chips
  assert.equal(cal.monthChipLimit(5), 3);
  cal.els.calendarGrid.clientHeight = 850; // 170px/row -> 4 chips
  assert.equal(cal.monthChipLimit(5), 4);

  // 6. Verify CSS uniformizes badge sizes and fixes hours badge on the right while absence badges stay on the left
  const cssText = fs.readFileSync(path.resolve(__dirname, '../src/frontend/calendar/calendar.css'), 'utf8');
  const hoursBadgeRule = cssText.match(/\.day-cell\s+\.hours-badge\s*\{([^}]*)\}/);
  assert.ok(hoursBadgeRule, '.day-cell .hours-badge rule should exist');
  assert.match(hoursBadgeRule[1], /display\s*:\s*inline-block/, '.hours-badge should use display: inline-block so holiday-badge text-overflow: ellipsis works');
  const halfBadgeRule = cssText.match(/\.day-cell\s+\.hours-badge\.half-badge\s*\{([^}]*)\}/);
  assert.ok(halfBadgeRule, '.day-cell .hours-badge.half-badge rule should exist');
  assert.doesNotMatch(halfBadgeRule[1], /font-size\s*:/, '.half-badge should inherit uniform font-size from .hours-badge');
  assert.doesNotMatch(halfBadgeRule[1], /padding\s*:/, '.half-badge should inherit uniform padding from .hours-badge');
  assert.match(halfBadgeRule[1], /min-width\s*:\s*58px/, '.half-badge should set min-width: 58px (>= OOF ½ 56.25px natural width) so Vac ½ and OOF ½ match in size');
  const rightHoursRule = cssText.match(/\.day-cell\s+\.hours-badge:not\(\.oof-badge\):not\(\.vacation-badge\):not\(\.holiday-badge\)\s*\{([^}]*)\}/);
  assert.ok(rightHoursRule, 'Hours badge right-alignment rule should exist');
  assert.match(rightHoursRule[1], /margin-left\s*:\s*auto/, 'Hours badge should use margin-left: auto to stay fixed on the right');

  // 7. Half-day absences: tasks sit in the worked half (morning absent -> bottom, afternoon absent -> top)
  const amListRule = cssText.match(/\.day-cell\.half-absence\.half-am\s+\.issue-list\s*>\s*:first-child\s*\{([^}]*)\}/);
  assert.ok(amListRule, 'half-am should push the first task chip towards the bottom (afternoon) half');
  assert.match(amListRule[1], /margin-top\s*:\s*auto/);
  assert.ok(/\.day-cell\.half-absence\.half-pm\s+\.issue-list\s*\{[^}]*flex-start/.test(cssText), 'half-pm keeps tasks in the top (morning) half');

  assert.doesNotMatch(cssText, /\.nav\s*\{[^}]*position:\s*absolute/, '.nav must not use position:absolute which overlaps .view-toggle on horizontal resize');
  const controlsLeftMatch = cssText.match(/\.controls-left\s*\{([^}]*)\}/);
  assert.ok(controlsLeftMatch, '.controls-left rule should exist in calendar.css');
  assert.match(controlsLeftMatch[1], /flex:\s*1\s+1\s+0/, '.controls-left should use flex-basis 0 so .header-actions stays on the right while .controls-left wraps internally');

  assert.equal(cal.els.manageCredentialsBtn.textContent.trim(), 'Jira connection');
  assert.equal(cal.els.exportDataBtn.textContent.trim(), 'Export data');
  assert.equal(cal.els.importDataBtn.textContent.trim(), 'Import data');
  assert.equal(cal.els.manageCredentialsBtn.classList.contains('icon-btn'), false);
  assert.equal(cal.els.exportDataBtn.classList.contains('icon-btn'), false);
  assert.equal(cal.els.importDataBtn.classList.contains('icon-btn'), false);
});

test('calendar: clicking task search input opens scrollable overlay dropdown without affecting dialog size', async () => {
  const dateStr = '2026-10-16';
  cal.state.oofDates = new Map();
  cal.state.vacationDates = new Map();
  cal.state.byDate = {};
  cal.state.openIssuesCache.clear();

  cal.renderDayDialogBody(dateStr);
  const addToggle = document.getElementById('addEntryToggle');
  assert.ok(addToggle, '+ Add worklog button should exist');
  addToggle.click();

  await new Promise((r) => setTimeout(r, 20));

  const issueInput = document.getElementById('issuePickerInput');
  const suggestionsEl = document.getElementById('issueSuggestions');
  assert.ok(issueInput, '#issuePickerInput should exist');
  assert.ok(suggestionsEl, '#issueSuggestions should exist');

  // Verify #issueSuggestions is inside .issue-picker (not inside <label>)
  const pickerField = cal.els.dayDialogBody.querySelector('.issue-picker-field');
  assert.ok(pickerField, '.issue-picker-field wrapper should exist');
  const labelEl = pickerField.querySelector('label');
  assert.equal(labelEl.getAttribute('for'), 'issuePickerInput');
  assert.equal(labelEl.contains(suggestionsEl), false, 'Dropdown must not be nested inside <label>');

  // Verify CSS configures .issue-picker as position:relative and .issue-suggestions as position:absolute with scroll
  const cssText = fs.readFileSync(path.resolve(__dirname, '../src/frontend/calendar/calendar.css'), 'utf8');
  assert.match(cssText, /\.issue-picker\s*\{\s*position:\s*relative;\s*\}/);
  assert.match(cssText, /\.issue-suggestions\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?max-height:\s*175px;[\s\S]*?overflow-y:\s*auto;/);

  // Clicking on the search input opens the task list dropdown
  document.activeElement = issueInput;
  issueInput.click();
  assert.equal(suggestionsEl.classList.contains('hidden'), false, 'Suggestions list should be visible on click');
  const items = suggestionsEl.querySelectorAll('.issue-suggestion-item');
  assert.equal(items.length, 2);
  assert.equal(items[0].dataset.key, 'PROJ-101');

  // Selecting an issue hides the dropdown, updates label, and clicking input again re-opens dropdown
  items[0].click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(suggestionsEl.classList.contains('hidden'), true);
  assert.match(document.getElementById('selectedIssueLabel').textContent, /PROJ-101/);

  // Clicking the already-focused search input again re-opens the dropdown
  issueInput.click();
  assert.equal(suggestionsEl.classList.contains('hidden'), false);
});

test('calendar: Day dialog stays open when dragging out or clicking outside in edit mode, and closes on clean outside click in view mode', async () => {
  const dateStr = '2026-10-14';
  cal.state.oofDates = new Map();
  cal.state.vacationDates = new Map();
  cal.state.byDate = {
    [dateStr]: [
      { worklogId: 'w-1', issueKey: 'PROJ-101', issueSummary: 'Task One', seconds: 7200, started: '2026-10-14T09:00:00.000', comment: 'Initial' },
    ],
  };

  await cal.openDayDialog(dateStr);
  assert.equal(cal.els.dayDialog.open, true);
  assert.equal(cal.isDayDialogEditing(), false, 'Should start in viewing mode');

  // 1. In viewing mode: dragging from inside the dialog out onto the backdrop must NOT close the dialog
  const bodyEl = cal.els.dayDialogBody;
  cal.els.dayDialog.dispatchEvent({ type: 'mousedown', target: bodyEl, clientX: 250, clientY: 250 });
  cal.els.dayDialog.dispatchEvent({ type: 'click', target: cal.els.dayDialog, clientX: 20, clientY: 20 });
  assert.equal(cal.els.dayDialog.open, true, 'Dragging from inside out onto backdrop must not close dialog');

  // 2. Enter "+ Add worklog" edit mode: clicking outside or pressing Escape must NOT close the dialog
  const addToggle = document.getElementById('addEntryToggle');
  addToggle.click();
  assert.equal(cal.isDayDialogEditing(), true, 'Opening add form puts dialog into editing mode');

  cal.els.dayDialog.dispatchEvent({ type: 'mousedown', target: cal.els.dayDialog, clientX: 20, clientY: 20 });
  cal.els.dayDialog.dispatchEvent({ type: 'click', target: cal.els.dayDialog, clientX: 20, clientY: 20 });
  assert.equal(cal.els.dayDialog.open, true, 'Clicking outside while adding a worklog must NOT close dialog');

  const cancelEvt = { type: 'cancel', target: cal.els.dayDialog, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  cal.els.dayDialog.dispatchEvent(cancelEvt);
  assert.equal(cancelEvt.defaultPrevented, true, 'Escape (cancel) while adding a worklog must be prevented');

  // Cancel add form -> back to viewing mode
  document.getElementById('cancelAddEntry').click();
  assert.equal(cal.isDayDialogEditing(), false);

  // 3. Enter row "Edit" mode: clicking outside must NOT close the dialog
  const editBtn = cal.els.dayDialogBody.querySelector('.edit-entry-btn');
  assert.ok(editBtn);
  editBtn.click();
  assert.equal(cal.isDayDialogEditing(), true, 'Editing an existing row puts dialog into editing mode');

  cal.els.dayDialog.dispatchEvent({ type: 'mousedown', target: cal.els.dayDialog, clientX: 20, clientY: 20 });
  cal.els.dayDialog.dispatchEvent({ type: 'click', target: cal.els.dayDialog, clientX: 20, clientY: 20 });
  assert.equal(cal.els.dayDialog.open, true, 'Clicking outside while editing an entry must NOT close dialog');

  // Cancel row edit -> back to viewing mode
  cal.els.dayDialogBody.querySelector('.cancel-edit-btn').click();
  assert.equal(cal.isDayDialogEditing(), false);

  // 4. In viewing mode: a clean click outside on the backdrop DOES close the dialog
  cal.els.dayDialog.dispatchEvent({ type: 'mousedown', target: cal.els.dayDialog, clientX: 20, clientY: 20 });
  cal.els.dayDialog.dispatchEvent({ type: 'click', target: cal.els.dayDialog, clientX: 20, clientY: 20 });
  assert.equal(cal.els.dayDialog.open, false, 'Clean click outside in viewing mode should close dialog');
});

test('calendar: computeStats, vacationSummaryHtml, Year view, and Bulk actions handle half-day and split absences', async () => {
  cal.state.expectedHours = 7;
  cal.state.annualVacationDaysByYear = { '2026': 22 };
  cal.state.oofDates = new Map([
    ['2026-10-12', 'full'], // Monday: full OOF (1d)
    ['2026-10-13', 'am'],   // Tuesday: AM OOF (0.5d) + PM Vacation (0.5d) -> split full day (1d)
    ['2026-10-14', 'pm'],   // Wednesday: PM OOF (0.5d), 3.5h expected
  ]);
  cal.state.vacationDates = new Map([
    ['2026-10-13', 'pm'],   // Tuesday: PM Vacation (0.5d)
    ['2026-10-15', 'am'],   // Thursday: AM Vacation (0.5d), 3.5h expected
    ['2026-10-16', 'full'], // Friday: full Vacation (1d)
  ]);

  const dataMap = {
    '2026-10-14': [{ seconds: 3.5 * 3600 }],
  };
  const stats = cal.computeStats(dataMap, new Date(2026, 9, 12), new Date(2026, 9, 16));
  // Mon (1d) + Tue split (1d) + Wed (0.5d) + Thu (0.5d) + Fri (1d) = 4.0 absence days
  assert.equal(stats.oofCount, 4);
  // Wed and Thu have half-days of work -> 2 weekdaysConsidered, 3.5 + 3.5 = 7h expected
  assert.equal(stats.weekdaysConsidered, 2);
  assert.equal(stats.weekdaysWithWork, 1);
  assert.equal(stats.expectedTotal, 7);
  assert.equal(stats.totalHours, 3.5);
  assert.equal(stats.missing.length, 1);
  assert.equal(stats.missing[0].dateStr, '2026-10-15');
  assert.match(stats.missing[0].label, /\(½\)/);

  // Vacation summary counts 0.5d (Tue PM) + 0.5d (Thu AM) + 1d (Fri) = 2d
  const vacHtml = cal.vacationSummaryHtml(2026);
  assert.match(vacHtml, />22<\/span><span class="label">Total days/);
  assert.match(vacHtml, />20<\/span><span class="label">Days available/);

  // Year view renders split and half-day classes and labels
  cal.state.view = 'year';
  cal.renderGrid();
  const splitYearBtn = cal.els.calendarGrid.querySelector('.year-day[data-date="2026-10-13"]');
  assert.ok(splitYearBtn);
  assert.equal(splitYearBtn.classList.contains('split-oof-vacation'), true);
  assert.match(splitYearBtn.innerHTML, /½O·½V/);

  const halfOofYearBtn = cal.els.calendarGrid.querySelector('.year-day[data-date="2026-10-14"]');
  assert.ok(halfOofYearBtn);
  assert.equal(halfOofYearBtn.classList.contains('half-pm'), true);
  assert.match(halfOofYearBtn.innerHTML, /½OOF/);

  // Bulk panel supports selecting Morning/Afternoon duration and combining half-day OOF + half-day Vacation
  cal.state.view = 'month';
  cal.state.selectedDates = new Set(['2026-10-19', '2026-10-20']);
  cal.state.byDate = {};
  chromeStorage.oofByAccount = { 'acc-1': [] };
  chromeStorage.vacationByAccount = { 'acc-1': [] };
  cal.state.oofDates = new Map();
  cal.state.vacationDates = new Map();

  cal.renderBulkPanel();
  const amBulkBtn = cal.els.bulkPeriodSelector.querySelector('[data-bulk-period="am"]');
  const pmBulkBtn = cal.els.bulkPeriodSelector.querySelector('[data-bulk-period="pm"]');
  amBulkBtn.click();
  assert.equal(cal.state.bulkAbsencePeriod, 'am');
  assert.equal(cal.els.bulkOofBtn.textContent, 'Mark OOF (AM)');

  cal.els.bulkOofBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.oofPeriod('2026-10-19'), 'am');
  assert.equal(cal.oofPeriod('2026-10-20'), 'am');

  pmBulkBtn.click();
  assert.equal(cal.state.bulkAbsencePeriod, 'pm');
  assert.equal(cal.els.bulkVacationBtn.textContent, 'Mark vacation (PM)');
  cal.els.bulkVacationBtn.click();
  await new Promise((r) => setTimeout(r, 15));

  // Both days are now split: AM OOF + PM Vacation!
  assert.equal(cal.oofPeriod('2026-10-19'), 'am');
  assert.equal(cal.vacationPeriod('2026-10-19'), 'pm');
  assert.equal(cal.dayAbsence('2026-10-19').isSplit, true);

  // Conflict check: when a day has worklogs, marking Full-day or the opposite half that would make a full split absence is blocked
  cal.state.byDate = {
    '2026-10-19': [{ worklogId: 'w-1', issueKey: 'PROJ-101', issueSummary: 'Task', seconds: 3600, started: '2026-10-19T14:00:00.000' }],
  };
  await cal.setDayHalves('acc-1', '2026-10-19', 'oof', 'none');
  await cal.setDayHalves('acc-1', '2026-10-20', 'oof', 'none');
  cal.state.oofDates = await cal.loadOofDates('acc-1');
  cal.state.vacationDates = await cal.loadVacationDates('acc-1');
  cal.state.bulkAbsencePeriod = 'pm';
  cal.renderBulkPanel();
  cal.els.bulkVacationBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cal.els.bulkError.classList.contains('hidden'), false);
  assert.match(cal.els.bulkError.textContent, /Full-day absence cannot be applied/);
});

test('calendar: worklog add, edit, delete, and bulk worklog workflows', async () => {
  const dateStr = '2026-10-15';
  cal.state.me = { accountId: 'acc-1', displayName: 'Ricardo Puga', email: 'ricardo@example.com' };
  cal.state.user = cal.state.me;
  cal.state.oofDates = new Map();
  cal.state.vacationDates = new Map();
  cal.state.byDate = {};
  cal.state.openIssuesCache.clear();

  // 1. Add worklog validation and submission
  cal.renderDayDialogBody(dateStr);
  document.getElementById('addEntryToggle').click();
  await new Promise((r) => setTimeout(r, 20));

  const saveBtn = document.getElementById('saveAddEntry');
  const errorEl = document.getElementById('addEntryError');

  // Missing task selection error
  saveBtn.click();
  assert.equal(errorEl.classList.contains('hidden'), false);
  assert.match(errorEl.textContent, /Pick a task/);

  // Select first open task
  const issueInput = document.getElementById('issuePickerInput');
  document.activeElement = issueInput;
  issueInput.click();
  const firstSuggestion = document.getElementById('issueSuggestions').querySelector('.issue-suggestion-item');
  firstSuggestion.click();
  await new Promise((r) => setTimeout(r, 15));

  // Invalid hours error
  const hoursInput = document.getElementById('addHoursInput');
  hoursInput.value = '0';
  hoursInput.dispatchEvent({ type: 'input' });
  saveBtn.click();
  assert.match(errorEl.textContent, /Enter a number of hours/);

  // Quick time button and valid submission
  const quickBtns = document.getElementById('addEntryForm').querySelectorAll('.time-quick-btn');
  quickBtns[1].click();
  assert.equal(document.getElementById('addTimeInput').value, '14:00');
  hoursInput.value = '3.5';
  hoursInput.dispatchEvent({ type: 'change' });
  document.getElementById('addCommentInput').value = 'Implemented half-day feature';
  saveBtn.click();
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(cal.state.byDate[dateStr].length, 1);
  assert.equal(cal.state.byDate[dateStr][0].issueKey, 'PROJ-101');
  assert.equal(cal.state.byDate[dateStr][0].seconds, 3.5 * 3600);

  // 2. Edit existing worklog entry
  const editBtn = cal.els.dayDialogBody.querySelector('.edit-entry-btn');
  assert.ok(editBtn);
  editBtn.click();
  const editForm = cal.els.dayDialogBody.querySelector('.edit-row-form');
  assert.ok(editForm);
  const editHoursInput = editForm.querySelector('input[type="number"]');
  editHoursInput.value = '4';
  editHoursInput.dispatchEvent({ type: 'input' });
  editForm.querySelectorAll('.time-quick-btn')[0].click();
  editForm.querySelector('textarea').value = 'Updated comment';
  editForm.querySelector('.save-edit-btn').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cal.state.byDate[dateStr][0].seconds, 4 * 3600);

  // 3. Delete existing worklog entry
  cal.renderDayDialogBody(dateStr);
  const deleteBtn = cal.els.dayDialogBody.querySelector('.delete-entry-btn');
  assert.ok(deleteBtn);
  deleteBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cal.state.byDate[dateStr].length, 0);

  // 4. Bulk worklog form and save
  cal.state.selectedDates = new Set(['2026-10-19', '2026-10-20']);
  cal.state.oofDates = new Map([['2026-10-19', 'am'], ['2026-10-20', 'am']]);
  cal.state.vacationDates = new Map();
  cal.renderBulkPanel();
  cal.els.bulkWorklogBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cal.els.bulkWorklogForm.classList.contains('hidden'), false);
  assert.equal(Number(cal.els.bulkHours.value), 3.5);
  assert.equal(cal.els.bulkTime.value, '14:00');

  cal.els.bulkHours.value = '0';
  cal.els.bulkSaveBtn.click();
  assert.match(cal.els.bulkError.textContent, /Enter valid hours/);

  cal.els.bulkHours.value = '3.5';
  cal.els.bulkComment.value = 'Bulk log';
  cal.els.bulkSaveBtn.click();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(cal.els.bulkWorklogForm.classList.contains('hidden'), true);
});

test('calendar: view switching, navigation, settings, holidays, status filters, diagnostics, and import/export', async () => {
  cal.state.me = { accountId: 'acc-1', displayName: 'Ricardo Puga', email: 'ricardo@example.com' };
  cal.state.user = cal.state.me;

  // View switching & navigation buttons
  cal.els.viewWeekBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.state.view, 'week');
  cal.els.prevBtn.click();
  cal.els.nextBtn.click();

  cal.els.viewYearBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.state.view, 'year');
  cal.els.prevBtn.click();
  cal.els.nextBtn.click();
  cal.els.vacationSummaryToggle.click();
  assert.equal(cal.state.showVacationSummary, true);

  cal.els.viewMonthBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.state.view, 'month');
  cal.els.prevBtn.click();
  cal.els.nextBtn.click();
  cal.els.todayBtn.click();

  cal.els.showWeekendsInput.checked = true;
  cal.els.showWeekendsInput.dispatchEvent({ type: 'change' });
  assert.equal(cal.state.showWeekends, true);

  // Select day with and without ctrlKey
  await cal.selectCalendarDay('2026-10-14', { ctrlKey: false, metaKey: false });
  await cal.selectCalendarDay('2026-10-15', { ctrlKey: true, metaKey: false });
  assert.equal(cal.state.selectedDates.has('2026-10-14'), true);
  assert.equal(cal.state.selectedDates.has('2026-10-15'), true);
  cal.els.bulkCloseBtn.click();
  assert.equal(cal.state.selectedDates.size, 1);

  // Settings inputs
  cal.els.expectedHoursInput.value = '8';
  cal.els.expectedHoursInput.dispatchEvent({ type: 'change' });
  assert.equal(cal.state.expectedHours, 8);
  cal.els.expectedHoursInput.value = '7';
  cal.els.expectedHoursInput.dispatchEvent({ type: 'change' });

  cal.els.annualVacationDaysInput.value = '25';
  cal.els.annualVacationDaysInput.dispatchEvent({ type: 'change' });
  assert.equal(cal.vacationAllowanceForYear(cal.state.anchor.getFullYear()), 25);

  cal.els.morningStartInput.value = '08:30';
  cal.els.afternoonStartInput.value = '13:30';
  cal.els.morningStartInput.dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cal.state.morningStart, '08:30');

  cal.els.holidayCountryInput.value = 'PT';
  cal.els.holidayModeInput.value = 'exclude';
  cal.els.holidayCountryInput.dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 15));

  // Manual holidays: validation + add + remove
  cal.els.manualHolidayDateInput.value = '';
  cal.els.manualHolidayNameInput.value = '';
  cal.els.addManualHolidayBtn.click();
  assert.equal(cal.els.manualHolidayError.classList.contains('hidden'), false);

  cal.els.manualHolidayDateInput.value = '2026-12-24';
  cal.els.manualHolidayNameInput.value = 'Christmas Eve';
  cal.els.addManualHolidayBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.state.manualHolidays.has('2026-12-24'), true);
  const removeHolBtn = cal.els.manualHolidayList.querySelector('.manual-holiday-remove');
  assert.ok(removeHolBtn);
  removeHolBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.state.manualHolidays.has('2026-12-24'), false);

  // Status filters sync & reset
  cal.els.syncStatusFiltersBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.els.statusFilterMessage.textContent, 'Statuses synchronized.');

  cal.els.resetStatusFiltersBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.els.statusFilterMessage.textContent, 'Defaults restored.');

  await cal.saveStatusFilters();
  assert.equal(cal.els.statusFilterMessage.textContent, 'Saved.');

  // Settings panel & diagnostics
  cal.els.settingsBtn.click();
  assert.equal(cal.els.settingsPanel.classList.contains('open'), true);
  cal.renderDiagnostics([{ timestamp: '2026-10-14T10:00:00Z', context: 'Sync', message: 'Boom', stack: 'trace' }]);
  cal.els.copyDiagnosticsBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(clipboardText, /JiraLogWork/);
  cal.els.clearDiagnosticsBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  cal.els.settingsCloseBtn.click();
  assert.equal(cal.els.settingsPanel.classList.contains('open'), false);

  // Legacy OOF migration
  localStore.logwork_oof_v1 = JSON.stringify({ 'acc-1': ['2026-11-02:am'] });
  await cal.migrateLegacyOofData();
  assert.equal(localStore.logwork_oof_v1, undefined);
  assert.ok(chromeStorage.oofByAccount['acc-1'].includes('2026-11-02:am'));

  // Export and Import data with split/reconciled half-day OOF + Vacation
  let createdBlob = null;
  globalThis.URL.createObjectURL = (blob) => {
    createdBlob = blob;
    return 'blob:test-export';
  };
  globalThis.URL.revokeObjectURL = () => {};
  cal.els.exportDataBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(createdBlob);

  // Import JSON that has AM OOF on 2026-11-05 while existing storage has Full Vacation on 2026-11-05 -> reconciles to AM OOF + PM Vacation!
  chromeStorage.oofByAccount = { 'acc-1': [] };
  chromeStorage.vacationByAccount = { 'acc-1': ['2026-11-05'] };
  const importPayload = {
    format: 'jiralogwork-export',
    version: 6,
    oof: { 'acc-1': ['2026-11-05:am'] },
    vacations: { 'acc-1': { '2026': ['2026-11-06:pm'] } },
    manualHolidays: { '2026-12-31': { date: '2026-12-31', name: 'NYE', localName: 'NYE' } },
    preferences: { expectedHours: 7, showWeekends: false },
  };
  cal.els.importDataInput.files = [{ text: async () => JSON.stringify(importPayload) }];
  cal.els.importDataInput.dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(cal.oofPeriod('2026-11-05'), 'am');
  assert.equal(cal.vacationPeriod('2026-11-05'), 'pm');
  assert.equal(cal.vacationPeriod('2026-11-06'), 'pm');
  assert.equal(cal.state.manualHolidays.has('2026-12-31'), true);
});

test('calendar: Day dialog category & duration buttons, task search retry/reopen, bulk conflicts, setup dialog, and error paths', async () => {
  const dateStr = '2026-10-21';
  cal.state.me = { accountId: 'acc-1', displayName: 'Ricardo Puga', email: 'ricardo@example.com' };
  cal.state.user = cal.state.me;
  cal.state.oofDates = new Map();
  cal.state.vacationDates = new Map();
  cal.state.byDate = {};

  // 1. Verify .absence-period-selector is removed from #oofToggleWrapper and .absence-halves-box is always visible (even on a Working day)
  cal.renderDayDialogBody(dateStr);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper .absence-period-selector'), null, '.absence-period-selector must not be rendered in #oofToggleWrapper');
  const halvesBox = cal.els.dayDialogBody.querySelector('#oofToggleWrapper .absence-halves-box');
  assert.ok(halvesBox, '.absence-halves-box must be visible even when Day category is Working day');
  assert.equal(halvesBox.querySelector('[data-half-slot="am"][data-half-cat="none"]').classList.contains('active'), true);
  assert.equal(halvesBox.querySelector('[data-half-slot="pm"][data-half-cat="none"]').classList.contains('active'), true);

  // Directly toggle Morning to OOF from Working day using the always-visible .absence-halves-box
  halvesBox.querySelector('[data-half-slot="am"][data-half-cat="oof"]').click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.oofPeriod(dateStr), 'am');

  // Clicking [data-absence="oof"] promotes half-day OOF to full-day OOF
  cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="oof"]').click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.oofPeriod(dateStr), 'full');

  // Switch Morning back to Work -> Afternoon OOF ('pm')
  cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-half-slot="am"][data-half-cat="none"]').click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.oofPeriod(dateStr), 'pm');

  // Reset to Working day via [data-absence="none"] -> .absence-halves-box remains visible
  cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="none"]').click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.oofPeriod(dateStr), null);
  assert.equal(cal.vacationPeriod(dateStr), null);
  assert.ok(cal.els.dayDialogBody.querySelector('#oofToggleWrapper .absence-halves-box'), '.absence-halves-box remains visible after resetting to Working day');

  // When a day has worklogs, clicking OOF defaults to 'am' (half-day), and the opposite half's OOF/Vacation buttons are disabled
  cal.state.byDate[dateStr] = [
    { worklogId: 'w-1', issueKey: 'PROJ-101', issueSummary: 'Task', seconds: 3600, started: `${dateStr}T14:00:00.000` },
  ];
  cal.renderDayDialogBody(dateStr);
  cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-absence="oof"]').click();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(cal.oofPeriod(dateStr), 'am');
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-half-slot="pm"][data-half-cat="oof"]').disabled, true);
  assert.equal(cal.els.dayDialogBody.querySelector('#oofToggleWrapper [data-half-slot="pm"][data-half-cat="vacation"]').disabled, true);

  // 2. Task search input: open issues load error + clicking Retry keeps dropdown open and loads tasks; typing >= 2 chars searches and clicking input reopens dropdown
  cal.state.byDate[dateStr] = [];
  await cal.setDayHalves('acc-1', dateStr, 'none', 'none');
  cal.state.oofDates = new Map();
  cal.state.vacationDates = new Map();
  cal.state.openIssuesCache.clear();

  const origApiMock = apiMock;
  let failOpenIssuesOnce = true;
  apiMock = async (route, options = {}) => {
    const url = new URL(route, 'https://extension.local');
    if (url.pathname === '/api/issues/open' && failOpenIssuesOnce) {
      failOpenIssuesOnce = false;
      throw new Error('Temporary Jira failure');
    }
    return origApiMock(route, options);
  };

  cal.renderDayDialogBody(dateStr);
  document.getElementById('addEntryToggle').click();
  await new Promise((r) => setTimeout(r, 25));

  const suggestionsEl = document.getElementById('issueSuggestions');
  const issueInput = document.getElementById('issuePickerInput');
  document.activeElement = issueInput;
  issueInput.click();
  assert.equal(suggestionsEl.classList.contains('hidden'), false);
  const retryBtn = suggestionsEl.querySelector('.issue-load-retry');
  assert.ok(retryBtn, 'Retry button should be rendered when open issues fail to load');

  // Simulate document click bubbling when clicking Retry (which stops propagation and replaces suggestionsEl children)
  document.activeElement = retryBtn;
  const retryClickEvt = { type: 'click', target: retryBtn };
  retryBtn.dispatchEvent(retryClickEvt);
  if (!retryClickEvt._stopped) {
    document.dispatchEvent(retryClickEvt);
  }
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(suggestionsEl.classList.contains('hidden'), false, 'Clicking Retry must keep suggestions open and show loaded tasks');
  assert.ok(suggestionsEl.querySelectorAll('.issue-suggestion-item').length > 0);

  // Typing >= 2 characters triggers debounced search; clicking outside closes; clicking input with >= 2 chars reopens
  issueInput.value = 'PR';
  issueInput.dispatchEvent({ type: 'input' });
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(suggestionsEl.classList.contains('hidden'), false);
  assert.match(suggestionsEl.innerHTML, /PROJ-205/);

  // Click outside .issue-picker -> closes suggestions
  document.dispatchEvent({ type: 'click', target: cal.els.dayDialogBody });
  assert.equal(suggestionsEl.classList.contains('hidden'), true);

  // Click #issuePickerInput again while it still has 'PR' -> reopens suggestions!
  document.activeElement = issueInput;
  issueInput.click();
  assert.equal(suggestionsEl.classList.contains('hidden'), false);

  // Typing < 2 characters switches back to open issues list
  issueInput.value = 'P';
  issueInput.dispatchEvent({ type: 'input' });
  assert.equal(suggestionsEl.classList.contains('hidden'), false);
  apiMock = origApiMock;

  // 3. Bulk OOF conflict error, bulk worklog errors (full absence, mismatched open tasks), and bulk cancel
  cal.state.selectedDates = new Set(['2026-10-22']);
  cal.state.byDate = {
    '2026-10-22': [{ worklogId: 'w-2', issueKey: 'PROJ-101', issueSummary: 'Task', seconds: 3600, started: '2026-10-22T09:00:00.000' }],
  };
  cal.state.bulkAbsencePeriod = 'full';
  cal.renderBulkPanel();
  cal.els.bulkOofBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(cal.els.bulkError.textContent, /Full-day absence cannot be applied/);

  // Bulk worklog blocked when a selected date has a full absence
  cal.state.byDate = {};
  cal.state.oofDates = new Map([['2026-10-22', 'full']]);
  cal.renderBulkPanel();
  cal.els.bulkWorklogBtn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(cal.els.bulkError.textContent, /Remove full-day OOF or Vacation/);

  // Bulk cancel button hides form
  cal.state.oofDates = new Map();
  cal.renderBulkPanel();
  cal.els.bulkWorklogBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  cal.els.bulkCancelBtn.click();
  assert.equal(cal.els.bulkWorklogForm.classList.contains('hidden'), true);

  // 4. Setup dialog, credential management, user search, autoLog toggle, Escape on settings, and window listeners
  const setupSubmitPromise = cal.openSetupDialog();
  assert.equal(cal.els.setupDialog.open, true);
  cal.els.setupSite.value = 'demo.atlassian.net';
  cal.els.setupEmail.value = 'ricardo@example.com';
  cal.els.setupToken.value = 'secret-token';
  cal.els.setupForm.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  assert.equal(await setupSubmitPromise, true);
  assert.equal(cal.els.setupDialog.open, false);

  const setupClosePromise = cal.openSetupDialog();
  cal.els.setupCloseBtn.click();
  assert.equal(await setupClosePromise, false);
  assert.equal(cal.els.setupDialog.open, false);

  cal.els.manageCredentialsBtn.click();
  await new Promise((r) => setTimeout(r, 15));
  cal.els.setupCloseBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  cal.els.deleteCredentialsBtn.click();
  await new Promise((r) => setTimeout(r, 15));

  // User search suggestions & selection
  apiMock = async (route, options = {}) => {
    if (route.startsWith('/api/users/search')) {
      return [{ accountId: 'acc-2', displayName: 'Ana Silva', email: 'ana@example.com' }];
    }
    return origApiMock(route, options);
  };
  cal.els.userInput.value = 'Ana';
  cal.els.userInput.dispatchEvent({ type: 'input' });
  await new Promise((r) => setTimeout(r, 280));
  const userItem = cal.els.userSuggestions.querySelector('.suggestion-item');
  assert.ok(userItem);
  userItem.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cal.state.user.accountId, 'acc-2');
  cal.state.user = cal.state.me;
  apiMock = origApiMock;

  // Auto-log toggle, info icon, Escape closing settings panel, dayDialogCloseBtn, and window resize/error listeners
  cal.els.autoLogInput.checked = false;
  cal.els.autoLogInput.dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 15));

  cal.els.autoLogInfoIcon.click({ stopPropagation: () => {}, preventDefault: () => {} });
  assert.equal(cal.els.autoLogInfoIcon.classList.contains('open'), true);
  document.dispatchEvent({ type: 'click', target: document.body });
  assert.equal(cal.els.autoLogInfoIcon.classList.contains('open'), false);

  cal.els.settingsBtn.click();
  assert.equal(cal.els.settingsPanel.classList.contains('open'), true);
  document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(cal.els.settingsPanel.classList.contains('open'), false);

  await cal.openDayDialog('2026-10-14');
  // Native <select> / <input type="time"> popovers or keyboard-triggered clicks with clientX=0, clientY=0 must NOT close the dialog
  cal.els.dayDialog.dispatchEvent({ type: 'mousedown', target: cal.els.dayDialog, clientX: 0, clientY: 0 });
  cal.els.dayDialog.dispatchEvent({ type: 'click', target: cal.els.dayDialog, clientX: 0, clientY: 0 });
  assert.equal(cal.els.dayDialog.open, true, 'clientX=0, clientY=0 popover/keyboard click must not close dayDialog');

  document.getElementById('dayDialogCloseBtn').click();
  assert.equal(cal.els.dayDialog.open, false);

  // Importing onto an account that already has a split absence (AM OOF + PM Vacation) reconciles cleanly
  chromeStorage.oofByAccount = { 'acc-1': ['2026-11-10:am', '2026-11-11:am'] };
  chromeStorage.vacationByAccount = { 'acc-1': ['2026-11-10:pm', '2026-11-11:pm'] };
  const splitImport = {
    format: 'jiralogwork-export',
    version: 5,
    oof: { 'acc-1': ['2026-11-10:pm'] },
    vacations: { 'acc-1': { '2026': ['2026-11-11:am'] } },
  };
  cal.els.importDataInput.files = [{ text: async () => JSON.stringify(splitImport) }];
  cal.els.importDataInput.dispatchEvent({ type: 'change' });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(cal.oofPeriod('2026-11-10'), 'pm');
  assert.equal(cal.vacationPeriod('2026-11-10'), null);
  assert.equal(cal.vacationPeriod('2026-11-11'), 'am');
  assert.equal(cal.oofPeriod('2026-11-11'), null);

  cal.setApiError(Object.assign(new Error('Expired'), { code: 'JIRA_AUTH_REQUIRED', site: 'demo.atlassian.net' }));
  assert.equal(cal.els.statusBar.classList.contains('hidden'), false);
  const setupBannerBtn = cal.els.statusBar.querySelector('.status-action');
  assert.ok(setupBannerBtn);

  window.dispatchEvent({ type: 'resize' });
  window.dispatchEvent({ type: 'error', error: new Error('Window boom') });
  window.dispatchEvent({ type: 'unhandledrejection', reason: new Error('Promise boom') });
});


