/*!
 * Lead Magnet Generator - frontend
 * Mounts into <div id="lead-magnet-generator" data-api="https://.../webhook/lead-magnet"></div>
 * Options (data attributes on that div):
 *   data-api          base URL of the n8n webhooks (required unless data-mock="1")
 *   data-mock="1"     use fake answers (for previews and tests, no AI calls)
 *   data-concurrency  how many sections are written at the same time (default 3)
 *
 * Security: everything typed by users or returned by the AI is inserted with textContent,
 * never as HTML. The only innerHTML used is for the fixed icon SVGs below.
 */
(function () {
  'use strict';

  var ROOT_ID = 'lead-magnet-generator';
  var STORAGE_KEY = 'lmg:v1';
  var VERSION = '0.5.0';

  // ------------------------------------------------------------------ constants
  var FORMATS = {
    ebook: {
      name: 'Ebook',
      desc: 'An introduction, 4 to 7 chapters and a conclusion. Best for teaching a topic in depth.',
      first: ['intro'], middle: 'chapter', last: ['conclusion'], min: 4, max: 7,
      lengths: { short: '4 chapters', standard: '5 to 6 chapters', detailed: '7 chapters' },
      unit: 'chapter', writeLabel: 'Write my ebook'
    },
    guide: {
      name: 'Guide',
      desc: 'The problem, a step-by-step method, common mistakes and what to do next.',
      first: ['problem'], middle: 'step', last: ['mistakes', 'next_step'], min: 3, max: 9,
      lengths: { short: '3 steps', standard: '5 steps', detailed: '7 steps' },
      unit: 'step', writeLabel: 'Write my guide'
    },
    checklist: {
      name: 'Checklist',
      desc: 'One page of actions grouped by stage. Easy to print and tick off.',
      first: [], middle: 'group', last: [], min: 3, max: 5,
      lengths: { short: '3 groups, 12 items', standard: '4 groups, about 17 items', detailed: '5 groups, 20 items' },
      unit: 'group', writeLabel: 'Write my checklist'
    }
  };
  var TONES = [['friendly', 'Friendly'], ['professional', 'Professional'], ['bold', 'Bold'], ['inspiring', 'Inspiring'], ['conversational', 'Conversational']];
  var LENGTHS = [['short', 'Short'], ['standard', 'Standard'], ['detailed', 'Detailed']];
  var LANGUAGES = ['English', 'French', 'Spanish', 'German', 'Portuguese', 'Italian', 'Dutch', 'Arabic'];
  var LIMITS = {
    topic: [3, 200], audience: [3, 400], offer: [0, 300], languageOther: [2, 30],
    title: [3, 90], subtitle: [0, 160], heading: [2, 90], goal: [0, 200], point: [1, 160],
    ctaHeading: [0, 90], ctaText: [0, 400], ctaButton: [0, 40]
  };
  var MAX_POINTS = 8;
  var STEPS = ['Format', 'Details', 'Outline', 'Writing', 'Design'];

  var ICONS = {
    up: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 15V5M5.5 9.5 10 5l4.5 4.5"/></svg>',
    down: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 5v10M5.5 10.5 10 15l4.5-4.5"/></svg>',
    trash: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/></svg>',
    x: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
    plus: '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>',
    wait: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="6.5" stroke-dasharray="2.5 3"/></svg>',
    done: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M6.8 10.2 9 12.4l4.3-4.6"/></svg>',
    error: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 6.3v4.4M10 13.6v.1"/></svg>'
  };

  // ------------------------------------------------------------------ boot
  var root = document.getElementById(ROOT_ID);
  if (!root) return;
  if (root.getAttribute('data-lmg-mounted')) return;
  root.setAttribute('data-lmg-mounted', VERSION);

  var config = {
    api: (root.getAttribute('data-api') || '').replace(/\/+$/, ''),
    mock: root.getAttribute('data-mock') === '1',
    concurrency: Math.max(1, Math.min(4, parseInt(root.getAttribute('data-concurrency'), 10) || 3)),
    sitekey: (root.getAttribute('data-turnstile-sitekey') || '').trim(),
    // Inside the landing page (.lmg-page) the page has its own headline, so the tool skips its header.
    embedded: !!(root.closest && root.closest('.lmg-page')) || root.getAttribute('data-header') === 'off',
    // data-pdf="server": real one-click download through n8n + Apify. Otherwise the print window.
    pdfServer: root.getAttribute('data-pdf') === 'server'
  };

  var state = load() || freshState();
  var restored = !!(state.doc || state.input.topic);
  var run = null;            // active writing run { controller, queue }
  var outlineAbort = null;   // AbortController for the outline request
  var pendingFocus = null;   // selector to focus after the next render
  var saveTimer = null;

  function freshState() {
    return {
      v: 1, step: 1, format: null,
      input: { topic: '', audience: '', offer: '', tone: 'friendly', length: 'standard', language: 'English', languageOther: '' },
      doc: null, notice: null, errors: {}
    };
  }

  // ------------------------------------------------------------------ storage
  function load() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || s.v !== 1 || !s.input) return null;
      s.errors = {}; s.notice = null;
      if (s.doc && Array.isArray(s.doc.sections)) {
        s.doc.sections.forEach(function (x) { if (x.status === 'writing' || x.status === 'queued') x.status = 'outlined'; });
      }
      if (s.step > 3 && !s.doc) s.step = s.format ? 2 : 1;
      if (typeof s.pass !== 'string' || s.pass.length > 300) s.pass = '';
      return s;
    } catch (e) { return null; }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var copy = { v: 1, step: state.step, format: state.format, input: state.input, doc: state.doc, pass: state.pass || '' };
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
      } catch (e) { /* storage full or blocked: the tool still works, it just won't survive a refresh */ }
    }, 250);
  }
  function clearSaved() { try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------------ DOM helper (text only, never HTML)
  function h(tag, props, children) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') el.value = v;
        else if (k === 'icon') el.innerHTML = ICONS[v];            // fixed SVG constants only
        else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }
  function uid(prefix) { return prefix + Math.random().toString(36).slice(2, 8); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function fmtNum(n) { try { return n.toLocaleString(); } catch (e) { return String(n); } }
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  // ------------------------------------------------------------------ document helpers
  function rule() { return FORMATS[state.doc ? state.doc.format : state.format]; }
  function isMiddle(sec) { return sec.type === rule().middle; }
  function middleCount() { return state.doc.sections.filter(isMiddle).length; }
  function sectionLabel(sec) {
    var doc = state.doc;
    var middles = doc.sections.filter(function (s) { return s.type === sec.type; });
    var n = middles.indexOf(sec) + 1;
    switch (sec.type) {
      case 'intro': return 'Introduction';
      case 'conclusion': return 'Conclusion';
      case 'problem': return 'The problem';
      case 'mistakes': return 'Common mistakes';
      case 'next_step': return 'Next step';
      case 'chapter': return 'Chapter ' + n;
      case 'step': return 'Step ' + n;
      case 'group': return 'Group ' + n;
      default: return cap(sec.type);
    }
  }
  function words(sec) {
    return (sec.blocks || []).reduce(function (n, b) {
      return n + [b.text].concat(b.items || []).join(' ').split(/\s+/).filter(Boolean).length;
    }, 0);
  }
  function writtenCount() { return state.doc ? state.doc.sections.filter(function (s) { return s.status === 'written' && !s.dirty; }).length : 0; }
  function allWritten() { return !!state.doc && state.doc.sections.length > 0 && writtenCount() === state.doc.sections.length; }
  function anyStarted() { return !!state.doc && state.doc.sections.some(function (s) { return s.status !== 'outlined' || s.dirty; }); }
  function docMatchesFormat() { return !!state.doc && state.doc.format === state.format; }
  function maxStep() {
    if (!state.format) return 1;
    if (!docMatchesFormat()) return 2;
    if (allWritten()) return 5;
    if (anyStarted() || state.step >= 4) return 4;
    return 3;
  }
  function nextSectionId() {
    var used = {};
    state.doc.sections.forEach(function (s) { used[s.id] = true; });
    for (var i = 1; i < 100; i++) if (!used['s' + i]) return 's' + i;
    return null;
  }
  function outlinePayload() {
    var d = state.doc;
    return {
      schemaVersion: d.schemaVersion, format: d.format, meta: d.meta, title: d.title, subtitle: d.subtitle,
      sections: d.sections.map(function (s) {
        return { id: s.id, type: s.type, heading: s.heading, goal: s.goal, keyPoints: s.keyPoints.filter(function (k) { return k.trim(); }) };
      }),
      cta: d.cta
    };
  }
  function languageValue() {
    return state.input.language === 'other' ? state.input.languageOther.trim() : state.input.language;
  }

  // ------------------------------------------------------------------ API
  function api(path, body, signal) {
    if (config.mock) return mockApi(path, body, signal);
    if (!config.api) return Promise.resolve({ ok: false, code: 'config', message: 'This tool is not connected yet: the data-api address is missing.' });
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 100000);
    if (signal) signal.addEventListener('abort', function () { controller.abort(); });
    return fetch(config.api + '/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, code: 'bad_response' }; });
    }).catch(function (e) {
      if (signal && signal.aborted) return { ok: false, code: 'aborted' };
      if (controller.signal.aborted) return { ok: false, code: 'timeout' };
      return { ok: false, code: 'network' };
    }).then(function (j) { clearTimeout(timer); return j || { ok: false, code: 'bad_response' }; });
  }
  function errorText(r, what) {
    if (!r) return 'Something went wrong. Please try again.';
    if (['invalid_input', 'rejected', 'config', 'human', 'rate_limited', 'daily_limit', 'verify_required', 'verify_failed', 'forbidden_origin'].indexOf(r.code) !== -1 && r.message) return r.message;
    if (r.code === 'network') return 'Can\'t reach the generator. Check your internet connection and try again.';
    if (r.code === 'timeout') return 'The generator took too long to answer. Please try again.';
    return r.message || ('We couldn\'t ' + what + ' right now. Please try again in a minute.');
  }

  // ------------------------------------------------------------------ actions
  function goTo(step) {
    if (step < 1 || step > maxStep()) return;
    state.step = step; state.notice = null; state.errors = {};
    pendingFocus = '.lmg-panel-title';
    save(); render();
    var top = root.getBoundingClientRect().top + window.pageYOffset - 16;
    if (root.getBoundingClientRect().top < 0) window.scrollTo({ top: top, behavior: 'smooth' });
  }
  function chooseFormat(key) {
    state.format = key; state.notice = null; save(); render();
  }

  function validateDetails() {
    var i = state.input, e = {};
    var t = i.topic.trim(), a = i.audience.trim(), o = i.offer.trim();
    if (t.length < LIMITS.topic[0]) e.topic = 'Add a topic of at least 3 characters.';
    else if (t.length > LIMITS.topic[1]) e.topic = 'Keep the topic under 200 characters.';
    if (a.length < LIMITS.audience[0]) e.audience = 'Describe who it is for, in at least 3 characters.';
    else if (a.length > LIMITS.audience[1]) e.audience = 'Keep the audience under 400 characters.';
    if (o.length > LIMITS.offer[1]) e.offer = 'Keep the offer under 300 characters.';
    if (i.language === 'other' && !/^[\p{L} ()-]{2,30}$/u.test(i.languageOther.trim())) e.languageOther = 'Write a language name, for example Polish.';
    return e;
  }

  function createOutline() {
    var errs = validateDetails();
    state.errors = errs; state.notice = null;
    if (Object.keys(errs).length) {
      pendingFocus = '[data-field="' + Object.keys(errs)[0] + '"]';
      render(); return;
    }
    stopWriting();
    state.busy = 'outline';
    outlineAbort = new AbortController();
    render();
    var i = state.input;
    var signal = outlineAbort.signal;
    state.checking = !!config.sitekey;
    if (state.checking) render();
    getHumanToken().then(function (token) {
      if (state.checking) { state.checking = false; render(); }
      if (signal.aborted) return { ok: false, code: 'aborted' };
      return api('outline', {
        format: state.format, topic: i.topic.trim(), audience: i.audience.trim(), offer: i.offer.trim(),
        tone: i.tone, length: i.length, language: languageValue(), turnstile: token || undefined
      }, signal);
    }, function (e) { state.checking = false; return { ok: false, code: 'human', message: humanError(e) }; }).then(function (r) {
      outlineAbort = null; state.busy = null;
      if (r.code === 'aborted') { render(); return; }
      if (!r.ok) { state.notice = { kind: 'error', text: errorText(r, 'create your outline') }; render(); return; }
      if (r.pass) state.pass = r.pass;
      var doc = r.document;
      doc.sections.forEach(function (s) { s.status = 'outlined'; s.blocks = []; s.dirty = false; if (!s.keyPoints.length) s.keyPoints = ['']; });
      state.doc = doc;
      state.step = 3; pendingFocus = '.lmg-panel-title';
      save(); render();
    });
  }
  function cancelOutline() { if (outlineAbort) outlineAbort.abort(); }

  function validateOutline() {
    var d = state.doc, e = {};
    if (d.title.trim().length < LIMITS.title[0]) e.title = 'The title needs at least 3 characters.';
    if (d.title.length > LIMITS.title[1]) e.title = 'Keep the title under 90 characters.';
    if (d.subtitle.length > LIMITS.subtitle[1]) e.subtitle = 'Keep the subtitle under 160 characters.';
    d.sections.forEach(function (s) {
      var hd = s.heading.trim();
      if (hd.length < LIMITS.heading[0]) e['h-' + s.id] = 'Give this section a heading.';
      else if (hd.length > LIMITS.heading[1]) e['h-' + s.id] = 'Keep the heading under 90 characters.';
      if (s.goal.length > LIMITS.goal[1]) e['g-' + s.id] = 'Keep this under 200 characters.';
      s.keyPoints.forEach(function (k, j) { if (k.length > LIMITS.point[1]) e['p-' + s.id + '-' + j] = 'Keep each point under 160 characters.'; });
    });
    return e;
  }
  function writeAll() {
    var e = validateOutline();
    state.errors = e;
    if (Object.keys(e).length) {
      state.notice = { kind: 'error', text: 'Fix the highlighted fields before writing.' };
      pendingFocus = '[data-field="' + Object.keys(e)[0] + '"]';
      render(); return;
    }
    state.doc.sections.forEach(function (s) { s.keyPoints = s.keyPoints.filter(function (k) { return k.trim(); }); if (!s.keyPoints.length) s.keyPoints = ['']; });
    state.step = 4; state.notice = null; pendingFocus = '.lmg-panel-title';
    startWriting(null);
  }

  // Sections are written in parallel (fast) but revealed one at a time, in reading order,
  // so the user sees a calm "one by one" progress.
  function startWriting(ids) {
    if (run) return;
    var doc = state.doc;
    var targets = doc.sections.filter(function (s) {
      return ids ? ids.indexOf(s.id) !== -1 : (s.status !== 'written' || s.dirty);
    });
    if (!targets.length) { save(); render(); return; }
    targets.forEach(function (s) { s.status = 'queued'; s.error = null; });
    var order = targets.map(function (s) { return s.id; });
    run = { controller: new AbortController(), queue: order.slice(), order: order, results: {}, revealed: {}, done: false, timer: null };
    state.busy = 'writing';
    save(); render();
    var payload = outlinePayload();
    var current = run;
    function worker() {
      if (current !== run || !current.queue.length) return Promise.resolve();
      var id = current.queue.shift();
      var sec = findSection(id);
      if (!sec) { current.revealed[id] = true; return worker(); }
      sec.status = 'writing';
      function attempt(renewed) {
        var usedPass = state.pass || '';
        return api('section', { document: payload, sectionId: id, pass: usedPass || undefined }, current.controller.signal).then(function (r) {
          if (current !== run || r.code === 'aborted') return null;
          if (r.pass) { state.pass = r.pass; save(); }
          if (r.code === 'verify_required' && !renewed) {
            // Another writer already renewed the pass while this request was in flight: just retry.
            if (state.pass && state.pass !== usedPass && !passRenewal) return attempt(true);
            return renewPass().then(function () { return attempt(true); }, function (e) {
              return { ok: false, code: 'human', message: humanError(e) };
            });
          }
          return r;
        });
      }
      return attempt(false).then(function (r) {
        if (!r || current !== run) return;
        current.results[id] = r;
        reveal(current);
        return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < Math.min(config.concurrency, targets.length); i++) workers.push(worker());
    Promise.all(workers).then(function () {
      if (current !== run) return;
      current.done = true;
      reveal(current);
    });
  }
  function findSection(id) { return state.doc.sections.filter(function (s) { return s.id === id; })[0]; }
  function nextUnrevealed(cur) { return cur.order.filter(function (id) { return !cur.revealed[id]; })[0]; }
  function applyResult(sec, r) {
    if (r.ok) { sec.blocks = r.blocks; sec.status = 'written'; sec.dirty = false; sec.error = null; }
    else { sec.status = 'error'; sec.error = errorText(r, 'write this section'); }
  }
  function reveal(cur) {
    if (cur !== run || cur.timer) return;
    var id = nextUnrevealed(cur);
    if (!id) {
      if (cur.done) { run = null; state.busy = null; save(); render(); }
      return;
    }
    var r = cur.results[id];
    if (!r) return;
    applyResult(findSection(id), r);
    cur.revealed[id] = true;
    save(); render();
    cur.timer = setTimeout(function () { cur.timer = null; reveal(cur); }, 420);
  }
  // What the user sees: only the next section in reading order shows as "writing".
  function shownStatus(sec) {
    if (sec.dirty && sec.status === 'written') return 'outlined';
    if (run && (sec.status === 'writing' || sec.status === 'queued')) return sec.id === nextUnrevealed(run) ? 'writing' : 'queued';
    return sec.status;
  }
  function stopWriting() {
    if (!run) return;
    var cur = run;
    cur.controller.abort(); clearTimeout(cur.timer);
    cur.order.forEach(function (id) { var s = findSection(id); if (s && cur.results[id] && !cur.revealed[id]) applyResult(s, cur.results[id]); });
    state.doc.sections.forEach(function (s) { if (s.status === 'queued' || s.status === 'writing') s.status = 'outlined'; });
    run = null; state.busy = null; save(); render();
  }

  function startOver() {
    stopWriting(); cancelOutline(); clearSaved();
    state = freshState(); restored = false; pendingFocus = '.lmg-panel-title';
    render();
  }

  // ------------------------------------------------------------------ small UI pieces
  function radioGroup(label, options, value, onPick, className) {
    var group = h('div', { class: className || 'lmg-segments', role: 'radiogroup', 'aria-label': label });
    options.forEach(function (opt) {
      var selected = opt[0] === value;
      var b = h('button', {
        type: 'button', role: 'radio', class: 'lmg-segment', 'aria-checked': selected ? 'true' : 'false',
        tabindex: selected ? '0' : '-1', 'data-value': opt[0], text: opt[1],
        onclick: function () { pendingFocus = '[role="radiogroup"][aria-label="' + label + '"] [data-value="' + opt[0] + '"]'; onPick(opt[0]); }
      });
      group.appendChild(b);
    });
    group.addEventListener('keydown', arrowKeys);
    return group;
  }
  function arrowKeys(ev) {
    var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(ev.key in keys)) return;
    var radios = Array.prototype.slice.call(ev.currentTarget.querySelectorAll('[role="radio"]'));
    var i = radios.indexOf(document.activeElement);
    if (i === -1) return;
    ev.preventDefault();
    var next = radios[(i + keys[ev.key] + radios.length) % radios.length];
    next.click();
  }

  function countClass(n, limit, quiet) {
    return 'lmg-count' + (n > limit ? ' is-over' : '') + (quiet && n <= limit * 0.8 ? ' is-quiet' : '');
  }
  function counter(value, limit, quiet) {
    var n = value.length;
    return h('span', { class: countClass(n, limit, quiet), 'aria-hidden': 'true', text: n + ' / ' + limit });
  }
  // A text field bound to an object property. Typing never re-renders (keeps focus);
  // it only updates the counter and the live document.
  function field(opts) {
    var id = uid('lmg-');
    var value = opts.get();
    var limit = opts.limit;
    var count = limit ? counter(value, limit, opts.quietCount) : null;
    var grow = !!opts.autogrow;
    var tag = opts.multiline || grow ? 'textarea' : 'input';
    var err = state.errors[opts.key];
    var input = h(tag, {
      id: id, class: (opts.multiline ? 'lmg-textarea' : 'lmg-input') + (grow ? ' lmg-autogrow' : '') + (opts.quietCount ? ' has-inline-count' : '') + (opts.inputClass ? ' ' + opts.inputClass : '') + (err ? ' is-invalid' : ''),
      type: tag === 'input' ? 'text' : null, rows: opts.multiline ? (opts.rows || 3) : (grow ? 1 : null),
      placeholder: opts.placeholder || null, maxlength: limit ? String(limit + 40) : null,
      'data-field': opts.key, dir: 'auto', autocomplete: 'off', spellcheck: 'true',
      'aria-invalid': err ? 'true' : null, 'aria-describedby': (opts.help || err) ? id + '-d' : null,
      'aria-label': opts.label ? null : (opts.ariaLabel || null),
      value: value,
      oninput: function (ev) {
        opts.set(ev.target.value);
        if (count) { var n = ev.target.value.length; count.textContent = n + ' / ' + limit; count.className = countClass(n, limit, opts.quietCount); }
        if (state.errors[opts.key]) { delete state.errors[opts.key]; ev.target.classList.remove('is-invalid'); var e = ev.target.parentNode.querySelector('.lmg-field-error'); if (e) e.remove(); }
        if (grow) autosize(ev.target);
        if (opts.onChange) opts.onChange();
        updateLive(); save();
      },
      onkeydown: (opts.onEnter || grow) ? function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey && !opts.multiline) { ev.preventDefault(); if (opts.onEnter) opts.onEnter(); }
      } : null
    });
    var parts = [];
    if (opts.label) {
      parts.push(h('div', { class: 'lmg-label-row' }, [
        h('label', { class: 'lmg-label', for: id }, [opts.label, opts.optional ? h('span', { class: 'lmg-optional', text: ' (optional)' }) : null]),
        opts.quietCount ? null : count
      ]));
    }
    if (opts.quietCount && count) parts.push(h('div', { class: 'lmg-input-wrap' }, [input, count]));
    else parts.push(input);
    if (!opts.label && count && !opts.quietCount) parts.push(h('div', { class: 'lmg-label-row' }, [h('span'), count]));
    if (err) parts.push(h('p', { class: 'lmg-field-error', id: id + '-d', text: err }));
    else if (opts.help) parts.push(h('p', { class: 'lmg-help', id: id + '-d', text: opts.help }));
    return h('div', { class: 'lmg-field' + (opts.fieldClass ? ' ' + opts.fieldClass : '') }, parts);
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = (el.scrollHeight + 3) + 'px';
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { Array.prototype.forEach.call(root.querySelectorAll('.lmg-autogrow'), autosize); }, 120);
  });

  function button(label, opts) {
    opts = opts || {};
    var cls = 'lmg-btn' + (opts.kind ? ' lmg-btn--' + opts.kind : '') + (opts.small ? ' lmg-btn--small' : '') + (opts.busy ? ' is-busy' : '');
    return h('button', { type: 'button', class: cls, disabled: opts.disabled || false, 'aria-busy': opts.busy ? 'true' : null, onclick: opts.onClick },
      [opts.busy ? h('span', { class: 'lmg-spinner', 'aria-hidden': 'true' }) : null, label]);
  }
  // A button that asks for a second click before doing something destructive.
  function confirmButton(label, confirmLabel, onConfirm, opts) {
    var armed = false, timer = null;
    var b = button(label, opts);
    b.addEventListener('click', function () {
      if (!armed) {
        armed = true; b.lastChild.textContent = confirmLabel;
        timer = setTimeout(function () { armed = false; b.lastChild.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer); onConfirm();
    });
    return b;
  }
  function notice(n) {
    if (!n) return null;
    return h('div', { class: 'lmg-notice' + (n.kind === 'info' ? ' lmg-notice--info' : ''), role: n.kind === 'error' ? 'alert' : 'status' },
      [h('p', { class: 'lmg-notice-text', text: n.text }), n.action || null]);
  }
  function iconButton(icon, label, onClick, disabled) {
    return h('button', { type: 'button', class: 'lmg-icon-btn', 'aria-label': label, title: label, icon: icon, disabled: disabled || false, onclick: onClick });
  }

  // ------------------------------------------------------------------ render
  var els = {};
  function render() {
    var active = document.activeElement;
    var keepField = active && root.contains(active) && active.getAttribute('data-field');
    root.textContent = '';
    root.classList.add('lmg');
    root.setAttribute('data-step', state.step);

    if (!config.embedded) {
      root.appendChild(h('header', { class: 'lmg-head' }, [
        h('h2', { class: 'lmg-title', text: 'Create a lead magnet in minutes' }),
        h('p', { class: 'lmg-lede', text: 'Pick a format, describe your audience, and get a ready-to-edit ebook, guide or checklist written for you.' })
      ]));
    }
    root.appendChild(renderStepper());

    var wide = state.step === 5 && !!state.doc;
    els.aside = wide ? null : h('aside', { class: 'lmg-aside', 'aria-label': 'Your lead magnet' });
    if (!wide) previewFrame = null;
    var main = h('section', { class: 'lmg-main' });
    var panels = { 1: panelFormat, 2: panelDetails, 3: panelOutline, 4: panelWriting, 5: panelDesign };
    main.appendChild((panels[state.step] || panelFormat)());
    root.appendChild(h('div', { class: 'lmg-body' + (wide ? ' lmg-body--wide' : '') }, [main, els.aside]));
    root.appendChild(h('p', { class: 'lmg-foot', text: 'AI can make mistakes. Read your content before you share it.' }));
    updateLive();
    Array.prototype.forEach.call(root.querySelectorAll('.lmg-autogrow'), autosize);

    var target = pendingFocus ? root.querySelector(pendingFocus) : (keepField ? root.querySelector('[data-field="' + keepField + '"]') : null);
    if (target) {
      if (pendingFocus === '.lmg-panel-title') target.setAttribute('tabindex', '-1');
      try { target.focus({ preventScroll: pendingFocus === '.lmg-panel-title' }); } catch (e) { target.focus(); }
    }
    pendingFocus = null;
  }

  function renderStepper() {
    var reach = maxStep();
    var list = h('ol', { class: 'lmg-steps', 'aria-label': 'Progress' });
    STEPS.forEach(function (name, i) {
      var n = i + 1;
      var current = n === state.step, done = n < state.step || (n < reach && !current);
      var clickable = !current && n <= reach && !state.busy;
      var inner = [h('span', { class: 'lmg-step-num', text: String(n) }), h('span', { class: 'lmg-step-label', text: name })];
      var item = clickable
        ? h('button', { type: 'button', class: 'lmg-step lmg-step--link' + (done ? ' is-done' : ''), onclick: function () { goTo(n); }, 'aria-label': 'Go to step ' + n + ': ' + name }, inner)
        : h('span', { class: 'lmg-step' + (current ? ' is-current' : '') + (done ? ' is-done' : ''), 'aria-current': current ? 'step' : null }, inner);
      list.appendChild(h('li', null, item));
    });
    return list;
  }

  function panel(title, intro, body) {
    return h('div', { class: 'lmg-panel' }, [
      h('h3', { class: 'lmg-panel-title', text: title }),
      intro ? h('p', { class: 'lmg-panel-intro', text: intro }) : null,
      h('div', { class: 'lmg-panel-body' }, body)
    ]);
  }

  // ---- Step 1: format
  function sketch(key) {
    function lines(arr) { return arr.map(function (c) { return h('i', { class: c || null }); }); }
    if (key === 'ebook') {
      return h('div', { class: 'lmg-sketch lmg-sketch--ebook', 'aria-hidden': 'true' }, [
        h('div', { class: 'lmg-sketch-page' }, lines(['', 'w80', '', 'w60'])),
        h('div', { class: 'lmg-sketch-page' }, lines(['', 'w80', '', 'w60'])),
        h('div', { class: 'lmg-sketch-page' }, lines(['dark', 'w80', '', '', 'w60']))
      ]);
    }
    var rows = [];
    for (var i = 0; i < (key === 'guide' ? 4 : 6); i++) {
      rows.push(h('div', { class: 'lmg-sketch-row' }, [key === 'guide' ? h('b') : h('s'), h('i', { class: i % 2 ? 'w60' : null })]));
    }
    return h('div', { class: 'lmg-sketch', 'aria-hidden': 'true' }, h('div', { class: 'lmg-sketch-page' }, [h('i', { class: 'dark w80' })].concat(rows)));
  }
  function panelFormat() {
    var cards = h('div', { class: 'lmg-formats', role: 'radiogroup', 'aria-label': 'Format' });
    Object.keys(FORMATS).forEach(function (key) {
      var f = FORMATS[key], selected = state.format === key;
      cards.appendChild(h('button', {
        type: 'button', role: 'radio', class: 'lmg-format', 'aria-checked': selected ? 'true' : 'false',
        tabindex: selected || (!state.format && key === 'ebook') ? '0' : '-1', 'data-value': key,
        onclick: function () { pendingFocus = '.lmg-format[data-value="' + key + '"]'; chooseFormat(key); }, ondblclick: function () { chooseFormat(key); goTo(2); }
      }, [
        h('span', { class: 'lmg-format-check', 'aria-hidden': 'true' }),
        sketch(key),
        h('span', null, [h('span', { class: 'lmg-format-name', text: f.name }), h('span', { class: 'lmg-format-desc', style: 'display:block;margin-top:4px', text: f.desc })])
      ]));
    });
    cards.addEventListener('keydown', arrowKeys);
    var formatChanged = state.doc && state.format && state.doc.format !== state.format;
    return panel('What do you want to create?', 'Choose the format that fits how your audience will use it.', [
      cards,
      formatChanged ? notice({ kind: 'info', text: 'Your current outline is for a ' + FORMATS[state.doc.format].name.toLowerCase() + '. Continuing with a ' + FORMATS[state.format].name.toLowerCase() + ' creates a new outline.' }) : null,
      h('div', { class: 'lmg-actions' }, [button('Continue', { disabled: !state.format, onClick: function () { goTo(2); } })])
    ]);
  }

  // ---- Step 2: details
  function panelDetails() {
    var i = state.input, f = FORMATS[state.format];
    var busy = state.busy === 'outline';
    var lengthHelp = h('p', { class: 'lmg-help', text: cap(f.lengths[i.length]) + '.' });
    var langSelect = h('select', {
      class: 'lmg-select', id: 'lmg-language', 'data-field': 'language',
      onchange: function (ev) { i.language = ev.target.value; save(); render(); }
    }, LANGUAGES.map(function (l) { return h('option', { value: l, text: l, selected: i.language === l }); })
      .concat([h('option', { value: 'other', text: 'Other language', selected: i.language === 'other' })]));
    var hasOutline = docMatchesFormat();
    var hasWritten = hasOutline && writtenCount() > 0;
    return panel('Tell us about your ' + f.name.toLowerCase(), 'The more specific you are, the more useful the result.', [
      h('div', { class: 'lmg-fields' }, [
        field({ key: 'topic', label: 'Topic', limit: LIMITS.topic[1], placeholder: 'e.g. Getting your first 10 coaching clients',
          get: function () { return i.topic; }, set: function (v) { i.topic = v; }, onEnter: hasWritten ? null : createOutline }),
        field({ key: 'audience', label: 'Who is it for?', limit: LIMITS.audience[1], multiline: true, rows: 3,
          placeholder: 'e.g. New life coaches with no audience yet and a small marketing budget',
          help: 'Describe their situation and what they struggle with.',
          get: function () { return i.audience; }, set: function (v) { i.audience = v; } }),
        field({ key: 'offer', label: 'What do you offer next?', optional: true, limit: LIMITS.offer[1],
          placeholder: 'e.g. 1:1 coaching, a $297 course, a free discovery call',
          help: 'Used to write a call to action that matches your offer. Leave it blank if you are not selling anything yet.',
          get: function () { return i.offer; }, set: function (v) { i.offer = v; }, onEnter: hasWritten ? null : createOutline }),
        h('div', { class: 'lmg-field' }, [
          h('span', { class: 'lmg-label', id: 'lmg-tone-l', text: 'Tone' }),
          radioGroup('Tone', TONES, i.tone, function (v) { i.tone = v; save(); render(); })
        ]),
        h('div', { class: 'lmg-row-2' }, [
          h('div', { class: 'lmg-field' }, [
            h('span', { class: 'lmg-label', text: 'Length' }),
            radioGroup('Length', LENGTHS, i.length, function (v) { i.length = v; save(); render(); }),
            lengthHelp
          ]),
          h('div', { class: 'lmg-field' }, [
            h('label', { class: 'lmg-label', for: 'lmg-language', text: 'Language' }),
            langSelect,
            i.language === 'other' ? field({ key: 'languageOther', ariaLabel: 'Language name', placeholder: 'e.g. Polish', limit: LIMITS.languageOther[1],
              get: function () { return i.languageOther; }, set: function (v) { i.languageOther = v; } }) : null
          ])
        ])
      ]),
      notice(state.notice),
      h('div', { class: 'lmg-actions' }, [
        hasWritten && !busy
          ? confirmButton('Create a new outline', 'Click again: this replaces your written content', createOutline)
          : button(busy ? (state.checking ? 'Checking you\u2019re human\u2026' : 'Creating your outline\u2026') : (hasOutline ? 'Create a new outline' : 'Create outline'), { busy: busy, disabled: busy, onClick: createOutline }),
        busy ? button('Cancel', { kind: 'quiet', onClick: cancelOutline }) : null,
        !busy && hasOutline ? button('Keep my current outline', { kind: 'ghost', onClick: function () { goTo(3); } }) : null,
        h('span', { class: 'lmg-actions-spacer' }),
        !busy ? button('Back', { kind: 'quiet', onClick: function () { goTo(1); } }) : null
      ])
    ]);
  }

  // ---- Step 3: outline editor
  function markDirty(sec) {
    if (sec.status !== 'written' || sec.dirty) return;
    sec.dirty = true;
    var el = root.querySelector('.lmg-section[data-id="' + sec.id + '"] .lmg-section-kind');
    if (el) el.textContent = sectionLabel(sec) + ' (edited, will be rewritten)';
  }
  function sectionCard(sec, idx) {
    var d = state.doc, r = rule();
    var middle = isMiddle(sec);
    var middles = d.sections.filter(isMiddle);
    var mi = middles.indexOf(sec);
    var tools = middle ? h('div', { class: 'lmg-section-tools' }, [
      iconButton('up', 'Move up', function () { move(sec, -1); }, mi === 0),
      iconButton('down', 'Move down', function () { move(sec, 1); }, mi === middles.length - 1),
      iconButton('trash', 'Remove this ' + r.unit, function () { removeSection(sec); }, middles.length <= r.min)
    ]) : null;

    var points = h('div', { class: 'lmg-points' });
    sec.keyPoints.forEach(function (k, j) {
      points.appendChild(h('div', { class: 'lmg-point' }, [
        h('span', { class: 'lmg-point-dot', 'aria-hidden': 'true' }),
        h('div', { style: 'flex:1;min-width:0' }, field({
          key: 'p-' + sec.id + '-' + j, ariaLabel: sectionLabel(sec) + ', point ' + (j + 1), inputClass: 'lmg-input--point',
          placeholder: d.format === 'checklist' ? 'An action, starting with a verb' : 'Something this section covers',
          autogrow: true, limit: LIMITS.point[1], quietCount: true,
          get: function () { return sec.keyPoints[j]; }, set: function (v) { sec.keyPoints[j] = v; markDirty(sec); },
          onEnter: function () { addPoint(sec, j + 1); }
        })),
        iconButton('x', 'Remove point ' + (j + 1), function () {
          sec.keyPoints.splice(j, 1); if (!sec.keyPoints.length) sec.keyPoints.push('');
          markDirty(sec); save(); render();
        }, sec.keyPoints.length === 1 && !sec.keyPoints[0])
      ]));
    });

    return h('li', { class: 'lmg-section' + (middle ? '' : ' is-fixed'), 'data-id': sec.id }, [
      h('div', { class: 'lmg-section-top' }, [
        h('span', { class: 'lmg-section-kind', text: sectionLabel(sec) + (sec.dirty ? ' (edited, will be rewritten)' : '') }),
        tools
      ]),
      field({ key: 'h-' + sec.id, ariaLabel: sectionLabel(sec) + ' heading', inputClass: 'lmg-input--heading', limit: LIMITS.heading[1], quietCount: true, autogrow: true,
        get: function () { return sec.heading; }, set: function (v) { sec.heading = v; markDirty(sec); } }),
      d.format !== 'checklist' ? field({ key: 'g-' + sec.id, ariaLabel: sectionLabel(sec) + ' goal', inputClass: 'lmg-input--goal', fieldClass: 'lmg-section-goal',
        placeholder: 'What the reader will be able to do after this section', autogrow: true, limit: LIMITS.goal[1], quietCount: true,
        get: function () { return sec.goal; }, set: function (v) { sec.goal = v; markDirty(sec); } }) : null,
      points,
      sec.keyPoints.length < MAX_POINTS
        ? h('div', { class: 'lmg-add-point' }, button(d.format === 'checklist' ? 'Add an item' : 'Add a point', { kind: 'quiet', small: true, onClick: function () { addPoint(sec, sec.keyPoints.length); } }))
        : null
    ]);
  }
  function addPoint(sec, at) {
    if (sec.keyPoints.length >= MAX_POINTS) return;
    sec.keyPoints.splice(at, 0, ''); markDirty(sec);
    pendingFocus = '[data-field="p-' + sec.id + '-' + at + '"]';
    save(); render();
  }
  function move(sec, dir) {
    var list = state.doc.sections, i = list.indexOf(sec), j = i + dir;
    if (j < 0 || j >= list.length || !isMiddle(list[j])) return;
    list[i] = list[j]; list[j] = sec;
    save(); render();
    var btn = root.querySelector('[data-id="' + sec.id + '"] [aria-label="' + (dir < 0 ? 'Move up' : 'Move down') + '"]');
    if (btn && !btn.disabled) btn.focus(); else { var hd = root.querySelector('[data-field="h-' + sec.id + '"]'); if (hd) hd.focus(); }
  }
  function removeSection(sec) {
    if (middleCount() <= rule().min) return;
    var list = state.doc.sections; list.splice(list.indexOf(sec), 1);
    save(); render();
  }
  function addSection() {
    var r = rule(), list = state.doc.sections;
    if (middleCount() >= r.max) return;
    var id = nextSectionId(); if (!id) return;
    var lastMiddle = -1;
    list.forEach(function (s, i) { if (isMiddle(s)) lastMiddle = i; });
    var sec = { id: id, type: r.middle, heading: '', goal: '', keyPoints: [''], status: 'outlined', blocks: [], dirty: false };
    list.splice(lastMiddle + 1, 0, sec);
    pendingFocus = '[data-field="h-' + id + '"]';
    save(); render();
  }
  function panelOutline() {
    var d = state.doc, r = rule();
    var list = h('ol', { class: 'lmg-outline' });
    d.sections.forEach(function (s, i) {
      list.appendChild(sectionCard(s, i));
      var isLastMiddle = isMiddle(s) && !(d.sections[i + 1] && isMiddle(d.sections[i + 1]));
      if (isLastMiddle) {
        list.appendChild(h('li', null, h('button', {
          type: 'button', class: 'lmg-add-section', disabled: middleCount() >= r.max,
          onclick: addSection
        }, [h('span', { icon: 'plus', 'aria-hidden': 'true', style: 'display:inline-flex' }),
          middleCount() >= r.max ? 'Maximum of ' + r.max + ' ' + r.unit + 's reached' : 'Add a ' + r.unit])));
      }
    });
    var c = d.cta;
    var ctaCard = h('div', { class: 'lmg-cta-card' }, [
      h('div', { class: 'lmg-cta-head' }, [h('h4', { class: 'lmg-cta-title', text: 'Call to action' }), h('span', { class: 'lmg-help', text: 'You will add the link in the design step.' })]),
      field({ key: 'cta-h', label: 'Heading', limit: LIMITS.ctaHeading[1], get: function () { return c.heading; }, set: function (v) { c.heading = v; } }),
      field({ key: 'cta-t', label: 'Text', limit: LIMITS.ctaText[1], multiline: true, rows: 2, get: function () { return c.text; }, set: function (v) { c.text = v; } }),
      field({ key: 'cta-b', label: 'Button label', limit: LIMITS.ctaButton[1], get: function () { return c.buttonLabel; }, set: function (v) { c.buttonLabel = v; } })
    ]);
    var hasWritten = writtenCount() > 0;
    return panel('Review your outline', 'Edit anything you like. Each ' + r.unit + ' is written from its heading and points, so make them say what you want.', [
      h('div', { class: 'lmg-meta-card' }, [
        field({ key: 'title', label: 'Title', limit: LIMITS.title[1], inputClass: 'lmg-input--title', autogrow: true,
          get: function () { return d.title; }, set: function (v) { d.title = v; } }),
        field({ key: 'subtitle', label: 'Subtitle', limit: LIMITS.subtitle[1], autogrow: true,
          get: function () { return d.subtitle; }, set: function (v) { d.subtitle = v; } })
      ]),
      list,
      ctaCard,
      notice(state.notice),
      h('div', { class: 'lmg-actions' }, [
        button(hasWritten ? 'Continue' : r.writeLabel, { onClick: writeAll }),
        button('Change topic or audience', { kind: 'ghost', onClick: function () { goTo(2); } }),
        h('span', { class: 'lmg-actions-spacer' })
      ])
    ]);
  }

  // ---- Step 4: writing
  function panelWriting() {
    var d = state.doc, total = d.sections.length, done = writtenCount();
    var busy = state.busy === 'writing';
    var failed = d.sections.filter(function (s) { return s.status === 'error'; });
    var pending = d.sections.filter(function (s) { return s.status === 'outlined' || s.dirty; });
    var totalWords = d.sections.reduce(function (n, s) { return n + (s.status === 'written' ? words(s) : 0); }, 0);
    var pct = total ? Math.round(done / total * 100) : 0;

    var jobs = h('ul', { class: 'lmg-jobs' });
    d.sections.forEach(function (s) {
      var st = shownStatus(s);
      var icon = st === 'written' ? 'done' : st === 'error' ? 'error' : 'wait';
      var status = st === 'written' ? fmtNum(words(s)) + ' words'
        : st === 'writing' ? 'Writing\u2026'
        : st === 'queued' ? 'Up next'
        : st === 'error' ? s.error
        : 'Not written yet';
      var action = null;
      if (!busy && st === 'written') action = button('Rewrite', { kind: 'quiet', small: true, onClick: function () { startWriting([s.id]); } });
      if (!busy && (st === 'error' || st === 'outlined')) action = button(st === 'error' ? 'Try again' : 'Write', { kind: 'ghost', small: true, onClick: function () { startWriting([s.id]); } });
      jobs.appendChild(h('li', { class: 'lmg-job is-' + st }, [
        h('span', { class: 'lmg-job-icon' }, st === 'writing' ? h('span', { class: 'lmg-spinner', 'aria-hidden': 'true' }) : h('span', { icon: icon, style: 'display:inline-flex' })),
        h('div', { class: 'lmg-job-text' }, [
          h('p', { class: 'lmg-job-name', text: sectionLabel(s) + ': ' + s.heading }),
          h('p', { class: 'lmg-job-status', text: status })
        ]),
        action
      ]));
    });

    var cur = busy && run ? findSection(nextUnrevealed(run) || '') : null;
    var curLabel = cur ? sectionLabel(cur) : '';
    var label = busy ? (cur ? 'Writing ' + (/^(Chapter|Step|Group) /.test(curLabel) ? curLabel.charAt(0).toLowerCase() + curLabel.slice(1) : 'the ' + curLabel.toLowerCase()) + '\u2026' : 'Finishing up\u2026')
      : allWritten() ? 'Your ' + FORMATS[d.format].name.toLowerCase() + ' is written'
      : failed.length ? plural(failed.length, 'section', 'sections') + ' could not be written'
      : 'Ready to write';
    var actions = [];
    if (busy) actions.push(button('Stop writing', { kind: 'ghost', onClick: stopWriting }));
    else if (allWritten()) actions.push(button('Continue to design', { onClick: function () { goTo(5); } }));
    else if (failed.length || pending.length) actions.push(button(failed.length && !pending.length ? 'Try again' : 'Write the rest', { onClick: function () { startWriting(null); } }));
    actions.push(h('span', { class: 'lmg-actions-spacer' }));
    if (!busy) actions.push(button('Back to outline', { kind: 'quiet', onClick: function () { goTo(3); } }));

    return panel(busy ? 'Writing in progress' : 'Your content', busy ? 'Each ' + rule().unit + ' takes a few seconds. You can keep this page open and watch your document fill up.' : 'Rewrite any section you are not happy with, or go back and edit the outline.', [
      h('div', { class: 'lmg-progress' }, [
        h('div', { class: 'lmg-progress-row' }, [
          h('span', { class: 'lmg-progress-label', text: label }),
          h('span', { class: 'lmg-progress-meta', text: done + ' of ' + total + (totalWords ? ', ' + fmtNum(totalWords) + ' words' : '') })
        ]),
        h('div', { class: 'lmg-bar', role: 'progressbar', 'aria-label': 'Sections written', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
          h('div', { class: 'lmg-bar-fill' + (done === total ? ' is-complete' : ''), style: 'width:' + pct + '%' }))
      ]),
      notice(state.notice),
      jobs,
      h('p', { class: 'lmg-sr', 'aria-live': 'polite', style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)', text: done + ' of ' + total + ' sections written' }),
      h('div', { class: 'lmg-actions' }, actions)
    ]);
  }

  // ---- Step 5: design and download
  var previewFrame = null, previewTimer = null;
  function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 140); }
  function updatePreview() {
    if (!previewFrame || !previewFrame.isConnected) return;
    var doc = previewFrame.contentDocument, win = previewFrame.contentWindow;
    if (!doc || !doc.body) return;
    var y = win.scrollY;
    renderPrint(doc, state.doc, safeBranding(state.doc.branding), 'screen');
    fitPreview();
    win.scrollTo(0, y);
    whenReady(doc).then(function () { fitSheets(doc, state.doc.format); });
  }
  function fitPreview() {
    if (!previewFrame || !previewFrame.contentDocument) return;
    var z = previewFrame.contentDocument.querySelector('style[data-zoom]');
    if (!z) return;
    var size = PAGE_SIZES[safeBranding(state.doc.branding).pageSize];
    var pagePx = size.w * 96 / 25.4 + 40;
    var zoom = Math.max(0.3, Math.min(1, (previewFrame.clientWidth - 8) / pagePx));
    z.textContent = 'html { zoom: ' + zoom.toFixed(3) + '; }';
  }
  window.addEventListener('resize', function () { clearTimeout(previewTimer); previewTimer = setTimeout(fitPreview, 150); });

  // A set of choices that updates itself in place (so the preview frame is not rebuilt).
  function choiceGroup(label, options, value, onPick, renderOption, className) {
    var group = h('div', { class: className, role: 'radiogroup', 'aria-label': label });
    options.forEach(function (opt) {
      var selected = opt.id === value;
      var b = h('button', {
        type: 'button', role: 'radio', 'aria-checked': selected ? 'true' : 'false', tabindex: selected ? '0' : '-1', 'data-value': opt.id,
        'aria-label': opt.aria || null,
        onclick: function () {
          Array.prototype.forEach.call(group.children, function (c) { var on = c === b; c.setAttribute('aria-checked', on ? 'true' : 'false'); c.setAttribute('tabindex', on ? '0' : '-1'); });
          onPick(opt.id);
        }
      }, renderOption(opt));
      group.appendChild(b);
    });
    group.addEventListener('keydown', function (ev) {
      var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(ev.key in keys)) return;
      var radios = Array.prototype.slice.call(group.children);
      var i = radios.indexOf(document.activeElement); if (i === -1) return;
      ev.preventDefault();
      var next = radios[(i + keys[ev.key] + radios.length) % radios.length];
      next.click(); next.focus();
    });
    return group;
  }
  function ctrl(title, help, body) {
    return h('div', { class: 'lmg-ctrl' }, [h('h4', { class: 'lmg-ctrl-title', text: title }), help ? h('p', { class: 'lmg-help', text: help }) : null].concat(body));
  }
  function readLogo(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) { reject('Use a PNG, JPG or WebP image.'); return; }
      if (file.size > 5 * 1024 * 1024) { reject('Use an image under 5 MB.'); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        function encode(max) {
          var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          var cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.round(img.naturalWidth * s)); cv.height = Math.max(1, Math.round(img.naturalHeight * s));
          cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
          return cv.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
        }
        // Redrawing through a canvas also strips anything hidden in the original file.
        var data = encode(800);
        if (data.length > 700000) data = encode(480);
        URL.revokeObjectURL(url);
        if (!LOGO_RE.test(data) || data.length > 700000) reject('This image is too large. Try a smaller logo.');
        else resolve(data);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject('This image could not be read. Try another file.'); };
      img.src = url;
    });
  }

  function panelDesign() {
    var d = state.doc;
    d.branding = safeBranding(d.branding);
    var b = d.branding;
    ensureUiFonts();
    function setB(fn) { fn(b); save(); schedulePreview(); }

    // -- download
    var dlBtn = button('Download PDF', { onClick: function () { downloadPdf(dlBtn); } });
    dlBtn.classList.add('lmg-btn--block');
    var download = h('div', { class: 'lmg-ctrl lmg-ctrl--download lmg-dl' }, [
      dlBtn,
      h('p', { class: 'lmg-help lmg-dl-hint', text: DL_HINT }),
      state.notice && state.notice.kind === 'error' ? notice(state.notice) : null
    ]);

    // -- template
    var tplGroup = choiceGroup('Template', TEMPLATES, b.templateId, function (id) { setB(function (x) { x.templateId = id; }); },
      function (t) {
        return [h('span', { class: 'lmg-thumb lmg-thumb--' + t.id, 'aria-hidden': 'true', style: '--tp:' + b.colors.primary + ';--ta:' + b.colors.accent }, [h('i'), h('i'), h('i')]),
          h('span', { class: 'lmg-tpl-name', text: t.name }), h('span', { class: 'lmg-tpl-desc', text: t.desc })];
      }, 'lmg-tpls');

    // -- colors
    function paletteId() {
      var m = PALETTES.filter(function (p) { return p.primary.toLowerCase() === b.colors.primary.toLowerCase() && p.accent.toLowerCase() === b.colors.accent.toLowerCase(); })[0];
      return m ? m.id : 'custom';
    }
    var pickPrimary, pickAccent;
    function syncThumbs() {
      Array.prototype.forEach.call(root.querySelectorAll('.lmg-thumb'), function (el) { el.style.setProperty('--tp', b.colors.primary); el.style.setProperty('--ta', b.colors.accent); });
    }
    var swatches = choiceGroup('Colors', PALETTES.map(function (p) { return { id: p.id, aria: p.name, p: p }; }), paletteId(), function (id) {
      var p = PALETTES.filter(function (x) { return x.id === id; })[0];
      setB(function (x) { x.colors.primary = p.primary; x.colors.accent = p.accent; });
      pickPrimary.value = p.primary; pickAccent.value = p.accent; syncThumbs();
    }, function (o) {
      return [h('span', { class: 'lmg-swatch-dot', 'aria-hidden': 'true', style: 'background:' + o.p.primary }), h('span', { class: 'lmg-swatch-dot lmg-swatch-dot--a', 'aria-hidden': 'true', style: 'background:' + o.p.accent }), h('span', { class: 'lmg-swatch-name', text: o.p.name })];
    }, 'lmg-swatches');
    function colorInput(label, key) {
      var id = uid('lmg-c-');
      var input = h('input', { type: 'color', id: id, class: 'lmg-color', value: b.colors[key],
        oninput: function (ev) {
          if (!HEX.test(ev.target.value)) return;
          setB(function (x) { x.colors[key] = ev.target.value; });
          syncThumbs();
          var pid = paletteId();
          Array.prototype.forEach.call(swatches.children, function (c) { var on = c.getAttribute('data-value') === pid; c.setAttribute('aria-checked', on ? 'true' : 'false'); });
        } });
      return { input: input, el: h('label', { class: 'lmg-color-field', for: id }, [input, h('span', { text: label })]) };
    }
    var cp = colorInput('Main color', 'primary'), ca = colorInput('Accent color', 'accent');
    pickPrimary = cp.input; pickAccent = ca.input;

    // -- fonts
    var fontGroup = choiceGroup('Fonts', FONT_PAIRS, pairFor(b.fonts).id, function (id) {
      var p = FONT_PAIRS.filter(function (x) { return x.id === id; })[0];
      setB(function (x) { x.fonts = { heading: p.heading, body: p.body }; });
    }, function (p) {
      return [h('span', { class: 'lmg-font-name', style: 'font-family:' + cssString(p.heading) + ',serif;font-weight:' + Math.min(p.hw, 700), text: p.name }),
        h('span', { class: 'lmg-font-meta', text: p.heading === p.body ? p.heading : p.heading + ' and ' + p.body })];
    }, 'lmg-fonts');

    // -- brand (logo + name)
    var brandHost = h('div', { class: 'lmg-brand' });
    function brandBody() {
      var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'lmg-file', id: 'lmg-logo-file', tabindex: '-1',
        onchange: function (ev) {
          var f = ev.target.files && ev.target.files[0];
          ev.target.value = '';
          readLogo(f).then(function (data) {
            setB(function (x) { x.logoDataUrl = data; });
            logoError = null; redrawBrand();
          }, function (msg) { logoError = msg; redrawBrand(); });
        } });
      var row = b.logoDataUrl
        ? h('div', { class: 'lmg-logo-row' }, [
          h('img', { class: 'lmg-logo-preview', src: b.logoDataUrl, alt: 'Your logo' }),
          button('Replace', { kind: 'ghost', small: true, onClick: function () { file.click(); } }),
          button('Remove', { kind: 'quiet', small: true, onClick: function () { setB(function (x) { x.logoDataUrl = ''; }); redrawBrand(); } })
        ])
        : h('div', { class: 'lmg-logo-row' }, [button('Upload logo', { kind: 'ghost', small: true, onClick: function () { file.click(); } }),
          h('span', { class: 'lmg-help', text: 'PNG, JPG or WebP. It stays in your browser.' })]);
      var badge = b.logoDataUrl ? h('div', { class: 'lmg-field' }, [
        h('span', { class: 'lmg-label', text: 'Logo background' }),
        radioGroup('Logo background', [['clear', 'Transparent'], ['badge', 'White badge']], b.logoBadge ? 'badge' : 'clear', function (v) {
          b.logoBadge = v === 'badge'; save(); schedulePreview(); redrawBrand();
          var btn = root.querySelector('[aria-label="Logo background"] [data-value="' + v + '"]'); if (btn) btn.focus();
        }),
        h('p', { class: 'lmg-help', text: 'Use the white badge if your logo is hard to see on a colored cover.' })
      ]) : null;
      return [file, row, logoError ? h('p', { class: 'lmg-field-error', role: 'alert', text: logoError }) : null, badge,
        field({ key: 'brand', label: 'Brand or author name', optional: true, limit: 80, placeholder: 'e.g. Jane Doe Coaching',
          get: function () { return b.authorName; }, set: function (v) { b.authorName = v.slice(0, 80); }, onChange: schedulePreview })];
    }
    var logoError = null;
    function redrawBrand() { brandHost.textContent = ''; brandBody().forEach(function (n) { if (n) brandHost.appendChild(n); }); }
    redrawBrand();

    // -- call to action
    var c = d.cta;
    var ctaFields = [
      field({ key: 'cta-url', label: 'Link', limit: 500, placeholder: 'https://your-site.com/offer',
        help: 'Where the button takes readers: your offer, course or booking page.',
        get: function () { return c.url || ''; }, set: function (v) { c.url = v.trim(); }, onChange: schedulePreview }),
      field({ key: 'cta-b2', label: 'Button label', limit: LIMITS.ctaButton[1], get: function () { return c.buttonLabel; }, set: function (v) { c.buttonLabel = v; }, onChange: schedulePreview }),
      field({ key: 'cta-h2', label: 'Heading', limit: LIMITS.ctaHeading[1], get: function () { return c.heading; }, set: function (v) { c.heading = v; }, onChange: schedulePreview }),
      field({ key: 'cta-t2', label: 'Text', limit: LIMITS.ctaText[1], multiline: true, rows: 3, get: function () { return c.text; }, set: function (v) { c.text = v; }, onChange: schedulePreview })
    ];
    var showUrlId = uid('lmg-cb-');
    ctaFields.splice(1, 0, h('label', { class: 'lmg-check', for: showUrlId }, [
      h('input', { type: 'checkbox', id: showUrlId, checked: c.showUrl ? 'checked' : null,
        onchange: function (ev) { c.showUrl = !!ev.target.checked; save(); schedulePreview(); } }),
      h('span', { text: 'Show the link under the button (useful if people print the PDF)' })
    ]));
    var urlInput = ctaFields[0].querySelector('input');
    urlInput.setAttribute('inputmode', 'url'); urlInput.setAttribute('spellcheck', 'false');
    urlInput.addEventListener('blur', function () {
      var v = urlInput.value.trim();
      if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[\w-]+(\.[\w-]+)+/.test(v)) { v = 'https://' + v; urlInput.value = v; c.url = v; save(); schedulePreview(); }
    });

    // -- page size
    var sizeGroup = radioGroup('Page size', [['A4', 'A4'], ['Letter', 'US Letter']], b.pageSize, function (v) { b.pageSize = v; save(); render(); });

    var controls = h('div', { class: 'lmg-design-controls' }, [
      ctrl('Template', null, [tplGroup]),
      ctrl('Colors', null, [swatches, h('div', { class: 'lmg-color-row' }, [cp.el, ca.el])]),
      ctrl('Fonts', null, [fontGroup]),
      ctrl('Your brand', null, [brandHost]),
      ctrl('Call to action', null, ctaFields),
      ctrl('Page size', null, [sizeGroup])
    ]);

    previewFrame = h('iframe', { class: 'lmg-preview-frame', title: 'Preview of your lead magnet', tabindex: '0' });
    previewFrame.addEventListener('load', function () { updatePreview(); }, { once: true });
    previewFrame.srcdoc = EMPTY_DOC;

    var copyBtn = button('Copy text', { kind: 'ghost', onClick: function () {
      var text = docToText(d);
      var done = function () { copyBtn.lastChild.textContent = 'Copied'; setTimeout(function () { copyBtn.lastChild.textContent = 'Copy text'; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    } });

    return panel('Design and download', 'Pick a look, add your brand and your link, then download your PDF.', [
      state.notice && state.notice.kind !== 'error' ? h('div', { style: 'margin-bottom:24px' }, notice(state.notice)) : null,
      h('div', { class: 'lmg-design' }, [
        controls,
        // Preview and download share a column that stays in view on desktop.
        // On phones the preview goes first and the download card last, after all the options.
        h('div', { class: 'lmg-design-side' }, [
          h('div', { class: 'lmg-design-preview' }, [
            h('div', { class: 'lmg-design-preview-head' }, [h('span', { class: 'lmg-preview-title', text: 'Preview' }),
              h('span', { class: 'lmg-help', text: 'Scroll to see every page. Page numbers appear in the PDF.' })]),
            previewFrame
          ]),
          download
        ])
      ]),
      h('div', { class: 'lmg-actions' }, [
        copyBtn,
        button('Back to writing', { kind: 'ghost', onClick: function () { goTo(4); } }),
        h('span', { class: 'lmg-actions-spacer' }),
        confirmButton('Start a new lead magnet', 'Click again to delete this one', startOver, { kind: 'quiet' })
      ])
    ]);
  }

  // ------------------------------------------------------------------ PDF download: real file from the server, print window as backup
  function pdfFileName(title) {
    var n = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return (n || 'lead-magnet') + '.pdf';
  }
  // The exact document the print window would use (fonts loaded, page fit applied), as one HTML string.
  function printHtml() {
    return exportPdf({ dryRun: true }).then(function (frame) {
      var html = '<!doctype html>' + frame.contentDocument.documentElement.outerHTML;
      frame.remove();
      return html;
    });
  }
  function fetchPdf(html, filename) {
    if (config.mock) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (/\[pdf-fail\]/i.test(state.doc.title)) reject({ ok: false, code: 'generation_failed' });
          else resolve(new Blob(['%PDF-1.4\n% mock file\n' + html.length], { type: 'application/pdf' }));
        }, 900);
      });
    }
    function attempt(renewed) {
      var controller = new AbortController();
      var timer = setTimeout(function () { controller.abort(); }, 150000);
      return fetch(config.api + '/pdf', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ pass: state.pass || undefined, html: html, filename: filename.replace(/\.pdf$/, '') })
      }).then(function (res) {
        clearTimeout(timer);
        var type = res.headers.get('content-type') || '';
        if (res.ok && type.indexOf('application/pdf') !== -1) {
          return res.blob().then(function (blob) { if (blob.size < 500) throw { ok: false, code: 'bad_response' }; return blob; });
        }
        return res.json().catch(function () { return { ok: false, code: 'bad_response' }; }).then(function (j) {
          if (j && j.code === 'verify_required' && !renewed) {
            return renewPass().then(function () { return attempt(true); }, function (e) { throw { ok: false, code: 'human', message: humanError(e) }; });
          }
          throw j || { ok: false, code: 'bad_response' };
        });
      }, function () {
        clearTimeout(timer);
        throw { ok: false, code: controller.signal.aborted ? 'timeout' : 'network' };
      });
    }
    return attempt(false);
  }
  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 60000);
  }
  function setBtnBusy(btn, on, label) {
    btn.disabled = on; btn.classList.toggle('is-busy', on);
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    var sp = btn.querySelector('.lmg-spinner');
    if (on && !sp) btn.insertBefore(h('span', { class: 'lmg-spinner', 'aria-hidden': 'true' }), btn.firstChild);
    if (!on && sp) sp.remove();
    btn.lastChild.textContent = on ? label : 'Download PDF';
  }
  function downloadPdf(btn) {
    var c = state.doc.cta;
    if (c.url && !validUrl(c.url)) {
      state.errors = { 'cta-url': 'Enter a full link that starts with https://, for example https://your-site.com' };
      pendingFocus = '[data-field="cta-url"]';
      render(); return;
    }
    setBtnBusy(btn, true, 'Preparing your PDF\u2026');
    if (!config.pdfServer) {
      exportPdf().then(function () { setBtnBusy(btn, false); });
      return;
    }
    var hint = btn.parentNode && btn.parentNode.querySelector('.lmg-dl-hint');
    var oldNotice = btn.parentNode && btn.parentNode.querySelector('.lmg-notice');
    if (oldNotice) oldNotice.remove();
    var slow = setTimeout(function () { if (hint) hint.textContent = 'Almost there. The first PDF can take up to 20 seconds.'; }, 6000);
    var filename = pdfFileName(state.doc.title);
    printHtml().then(function (html) { return fetchPdf(html, filename); }).then(function (blob) {
      clearTimeout(slow);
      saveBlob(blob, filename);
      setBtnBusy(btn, false);
      if (hint) hint.textContent = 'Downloaded: ' + filename + '. Check your downloads folder.';
    }, function (err) {
      clearTimeout(slow);
      setBtnBusy(btn, false);
      if (hint) hint.textContent = DL_HINT;
      var own = err && ['rate_limited', 'daily_limit', 'human', 'verify_failed', 'invalid_input'].indexOf(err.code) !== -1 && err.message;
      state.notice = {
        kind: 'error',
        text: (own || 'We couldn\u2019t create the download right now.') + ' You can still save it with your browser\u2019s print window.',
        action: button('Use the print window', { kind: 'ghost', small: true, onClick: function () { exportPdf(); } })
      };
      var card = btn.parentNode;
      if (card) card.appendChild(notice(state.notice));
      state.notice = null;
    });
  }


  // ------------------------------------------------------------------ document renderer (plain preview, reused by templates later)
  function renderBlocks(blocks) {
    return blocks.map(function (b) {
      switch (b.type) {
        case 'paragraph': return h('p', { text: b.text });
        case 'subheading': return h('h4', { class: 'lmg-doc-h3', text: b.text });
        case 'bullets': case 'steps': case 'checklist':
          return h('div', null, [
            b.text ? h('p', { class: 'lmg-doc-lead', text: b.text }) : null,
            h(b.type === 'steps' ? 'ol' : 'ul', { class: 'lmg-doc-list lmg-doc-list--' + b.type }, b.items.map(function (it) { return h('li', { text: it }); }))
          ]);
        case 'tip': case 'warning': case 'example':
          return h('div', { class: 'lmg-doc-box lmg-doc-box--' + b.type }, [
            h('span', { class: 'lmg-doc-box-label', text: b.type === 'tip' ? 'Tip' : b.type === 'warning' ? 'Watch out' : 'Example' }),
            h('span', { text: b.text })
          ]);
        case 'template':
          return h('div', { class: 'lmg-doc-template' }, [h('span', { class: 'lmg-doc-box-label', text: b.text || 'Template' })]
            .concat(b.items.map(function (it) { return h('p', { text: it }); })));
        default: return null;
      }
    });
  }
  function renderDoc(d) {
    var parts = [h('h2', { class: 'lmg-doc-title', text: d.title }), d.subtitle ? h('p', { class: 'lmg-doc-subtitle', text: d.subtitle }) : null];
    d.sections.forEach(function (s) {
      parts.push(h('section', { class: 'lmg-doc-section' }, [
        h('p', { class: 'lmg-doc-kicker', text: sectionLabel(s) }),
        h('h3', { class: 'lmg-doc-h2', text: s.heading })
      ].concat(renderBlocks(s.blocks || []))));
    });
    var c = d.cta;
    if (c && (c.heading || c.text)) {
      parts.push(h('div', { class: 'lmg-doc-cta' }, [
        h('h3', { class: 'lmg-doc-h2', text: c.heading }), h('p', { text: c.text }),
        c.buttonLabel ? h('span', { class: 'lmg-doc-cta-btn', text: c.buttonLabel }) : null
      ]));
    }
    return h('article', { class: 'lmg-doc', dir: 'auto' }, parts);
  }
  function docToText(d) {
    var out = [d.title, d.subtitle, ''];
    d.sections.forEach(function (s) {
      out.push(sectionLabel(s).toUpperCase() + ': ' + s.heading, '');
      (s.blocks || []).forEach(function (b) {
        if (b.text) out.push((b.type === 'tip' ? 'Tip: ' : b.type === 'warning' ? 'Watch out: ' : b.type === 'example' ? 'Example: ' : '') + b.text);
        b.items.forEach(function (it, i) { out.push((b.type === 'steps' ? (i + 1) + '. ' : b.type === 'checklist' ? '[ ] ' : '- ') + it); });
        out.push('');
      });
    });
    if (d.cta) out.push(d.cta.heading, d.cta.text, d.cta.buttonLabel ? '> ' + d.cta.buttonLabel : '');
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ------------------------------------------------------------------ live document (aside)
  function updateLive() {
    var aside = els.aside;
    if (!aside) return;
    aside.textContent = '';
    var fmt = state.doc && state.step >= 3 ? state.doc.format : state.format;
    var d = state.doc && fmt === state.doc.format ? state.doc : null;
    var f = fmt ? FORMATS[fmt] : null;
    var title = d ? d.title : (state.input.topic.trim() || '');
    var stage = h('div', { class: 'lmg-live-stage', 'aria-hidden': 'true' });
    if (fmt !== 'checklist') {
      stage.appendChild(h('div', { class: 'lmg-live-page lmg-live-page--back2' }));
      stage.appendChild(h('div', { class: 'lmg-live-page lmg-live-page--back1' }));
    }
    stage.appendChild(h('div', { class: 'lmg-live-cover' + (fmt === 'checklist' ? ' is-light' : '') }, [
      h('span', { class: 'lmg-live-format', text: f ? f.name : 'Lead magnet' }),
      h('span', { class: 'lmg-live-title' + (title ? '' : ' is-empty'), text: title || 'Your title appears here' }),
      d && d.subtitle ? h('span', { class: 'lmg-live-sub', text: d.subtitle }) : null,
      h('span', { class: 'lmg-live-lines' }, [h('i'), h('i'), h('i')])
    ]));

    var info = h('div', { class: 'lmg-live-info' });
    if (d) {
      var secs = h('ul', { class: 'lmg-live-sections' });
      d.sections.forEach(function (s) {
        var st = shownStatus(s);
        secs.appendChild(h('li', { class: 'lmg-live-sec is-' + st }, [
          h('span', { class: 'lmg-live-sec-mark', 'aria-hidden': 'true' }),
          h('span', { class: 'lmg-live-sec-name', text: s.heading || sectionLabel(s) })
        ]));
      });
      var done = writtenCount(), total = d.sections.length;
      var w = d.sections.reduce(function (n, s) { return n + (s.status === 'written' ? words(s) : 0); }, 0);
      info.appendChild(secs);
      info.appendChild(h('p', { class: 'lmg-live-stats', style: 'margin-top:12px', text: done === 0 ? plural(total, 'section', 'sections')
        : done === total ? 'All ' + total + ' sections written, ' + fmtNum(w) + ' words'
        : done + ' of ' + total + ' written, ' + fmtNum(w) + ' words' }));
    } else {
      info.appendChild(h('p', { class: 'lmg-live-stats', text: f ? 'Your outline will appear here.' : 'Pick a format to begin.' }));
    }
    aside.appendChild(h('div', { class: 'lmg-live' + (state.busy === 'outline' ? ' is-thinking' : '') }, [stage, info]));
  }

  // ------------------------------------------------------------------ human check (Cloudflare Turnstile) + writing pass
  // Off until data-turnstile-sitekey is set on the root element. The check is usually invisible;
  // a small panel only appears if Cloudflare needs a click.
  var tsLoad = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve();
    if (tsLoad) return tsLoad;
    tsLoad = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = function () { var n = 0; (function wait() { if (window.turnstile) resolve(); else if (n++ > 100) reject(new Error('turnstile')); else setTimeout(wait, 50); })(); };
      s.onerror = function () { tsLoad = null; reject(new Error('turnstile')); };
      document.head.appendChild(s);
    });
    return tsLoad;
  }
  function getHumanToken() {
    if (!config.sitekey) return Promise.resolve('');
    return loadTurnstile().then(function () {
      return new Promise(function (resolve, reject) {
        var hd = hIn(document);
        var hostEl = hd('div', { class: 'lmg-ts-host' });
        var cancel = hd('button', { type: 'button', class: 'lmg-ts-cancel', text: 'Cancel' });
        var panel = hd('div', { class: 'lmg-ts', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick security check' },
          hd('div', { class: 'lmg-ts-card' }, [
            hd('p', { class: 'lmg-ts-title', text: 'Quick security check' }),
            hd('p', { class: 'lmg-ts-text', text: 'This keeps the free generator safe from bots.' }),
            hostEl, cancel
          ]));
        document.body.appendChild(panel);
        var widget = null, done = false;
        // The panel only appears when Cloudflare asks for a click (most visitors never see it).
        // Fallback after 12 s so a stuck check can always be cancelled.
        var showTimer = setTimeout(function () { panel.classList.add('is-visible'); }, 12000);
        function show() { clearTimeout(showTimer); panel.classList.add('is-visible'); var c = panel.querySelector('iframe') || cancel; try { c.focus(); } catch (e) { /* ignore */ } }
        function finish(fn, value) {
          if (done) return; done = true;
          clearTimeout(showTimer);
          try { if (widget !== null) window.turnstile.remove(widget); } catch (e) { /* ignore */ }
          panel.remove(); fn(value);
        }
        cancel.addEventListener('click', function () { finish(reject, new Error('cancelled')); });
        try {
          widget = window.turnstile.render(hostEl, {
            sitekey: config.sitekey, action: 'lead_magnet', appearance: 'interaction-only',
            callback: function (token) { finish(resolve, token); },
            'error-callback': function () { finish(reject, new Error('turnstile')); },
            'expired-callback': function () { /* a new token is issued automatically */ },
            'before-interactive-callback': show
          });
        } catch (e) { finish(reject, e); }
      });
    });
  }
  function humanError(e) {
    return e && e.message === 'cancelled' ? 'The security check was cancelled. Click the button again when you are ready.'
      : 'The security check could not load. Check your connection, or turn off a blocker for this page, then try again.';
  }
  // One shared renewal for all parallel writers.
  var passRenewal = null;
  function renewPass() {
    if (passRenewal) return passRenewal;
    passRenewal = getHumanToken().then(function (token) {
      return api('pass', { turnstile: token });
    }).then(function (r) {
      passRenewal = null;
      if (r.ok && r.pass) { state.pass = r.pass; save(); return true; }
      throw new Error(r.message || 'pass');
    }, function (e) { passRenewal = null; throw e; });
    return passRenewal;
  }

  // ------------------------------------------------------------------ design: templates, palettes, fonts
  var TEMPLATES = [
    { id: 'clean', name: 'Clean', desc: 'White pages, calm and easy to read.' },
    { id: 'bold', name: 'Bold', desc: 'Full-color cover and strong chapter openers.' },
    { id: 'editorial', name: 'Editorial', desc: 'Centered titles and fine rules, like a magazine.' }
  ];
  var PALETTES = [
    { id: 'navy', name: 'Navy', primary: '#181C39', accent: '#2F54EB' },
    { id: 'forest', name: 'Forest', primary: '#1F3D2B', accent: '#C9922E' },
    { id: 'plum', name: 'Plum', primary: '#3B1F4A', accent: '#D9577A' },
    { id: 'ocean', name: 'Ocean', primary: '#0F4C5C', accent: '#E8923A' },
    { id: 'ember', name: 'Ember', primary: '#24262B', accent: '#E4572E' },
    { id: 'clay', name: 'Clay', primary: '#5A3A26', accent: '#B5651D' }
  ];
  var FONT_PAIRS = [
    { id: 'modern', name: 'Modern', heading: 'Outfit', body: 'Outfit', hw: 700, q: 'family=Outfit:wght@400;500;600;700' },
    { id: 'classic', name: 'Classic', heading: 'Fraunces', body: 'Source Sans 3', hw: 700, q: 'family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,400&family=Source+Sans+3:ital,wght@0,400;0,600;1,400' },
    { id: 'elegant', name: 'Elegant', heading: 'DM Serif Display', body: 'DM Sans', hw: 400, q: 'family=DM+Serif+Display:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;1,9..40,400' },
    { id: 'friendly', name: 'Friendly', heading: 'Nunito', body: 'Nunito', hw: 800, q: 'family=Nunito:ital,wght@0,400;0,600;0,800;1,400' },
    { id: 'sharp', name: 'Sharp', heading: 'Space Grotesk', body: 'Inter', hw: 700, q: 'family=Space+Grotesk:wght@500;700&family=Inter:ital,wght@0,400;0,600;1,400' }
  ];
  var PAGE_SIZES = { A4: { w: 210, h: 297, css: 'A4', label: 'A4' }, Letter: { w: 215.9, h: 279.4, css: 'letter', label: 'US Letter' } };
  var LABELS = {
    English: ['Contents', 'Chapter', 'Step', 'Introduction', 'Conclusion', 'The problem', 'Common mistakes', 'Next step', 'Tip', 'Watch out', 'Example'],
    French: ['Sommaire', 'Chapitre', '\u00C9tape', 'Introduction', 'Conclusion', 'Le probl\u00E8me', 'Erreurs fr\u00E9quentes', 'Prochaine \u00E9tape', 'Astuce', 'Attention', 'Exemple'],
    Spanish: ['\u00CDndice', 'Cap\u00EDtulo', 'Paso', 'Introducci\u00F3n', 'Conclusi\u00F3n', 'El problema', 'Errores comunes', 'Siguiente paso', 'Consejo', 'Cuidado', 'Ejemplo'],
    German: ['Inhalt', 'Kapitel', 'Schritt', 'Einleitung', 'Fazit', 'Das Problem', 'H\u00E4ufige Fehler', 'N\u00E4chster Schritt', 'Tipp', 'Achtung', 'Beispiel'],
    Portuguese: ['Sum\u00E1rio', 'Cap\u00EDtulo', 'Passo', 'Introdu\u00E7\u00E3o', 'Conclus\u00E3o', 'O problema', 'Erros comuns', 'Pr\u00F3ximo passo', 'Dica', 'Aten\u00E7\u00E3o', 'Exemplo'],
    Italian: ['Indice', 'Capitolo', 'Passo', 'Introduzione', 'Conclusione', 'Il problema', 'Errori comuni', 'Prossimo passo', 'Consiglio', 'Attenzione', 'Esempio'],
    Dutch: ['Inhoud', 'Hoofdstuk', 'Stap', 'Inleiding', 'Conclusie', 'Het probleem', 'Veelgemaakte fouten', 'Volgende stap', 'Tip', 'Let op', 'Voorbeeld'],
    Arabic: ['\u0627\u0644\u0645\u062D\u062A\u0648\u064A\u0627\u062A', '\u0627\u0644\u0641\u0635\u0644', '\u0627\u0644\u062E\u0637\u0648\u0629', '\u0645\u0642\u062F\u0645\u0629', '\u0627\u0644\u062E\u0627\u062A\u0645\u0629', '\u0627\u0644\u0645\u0634\u0643\u0644\u0629', '\u0623\u062E\u0637\u0627\u0621 \u0634\u0627\u0626\u0639\u0629', '\u0627\u0644\u062E\u0637\u0648\u0629 \u0627\u0644\u062A\u0627\u0644\u064A\u0629', '\u0646\u0635\u064A\u062D\u0629', '\u062A\u0646\u0628\u064A\u0647', '\u0645\u062B\u0627\u0644']
  };
  var LABEL_KEYS = ['contents', 'chapter', 'step', 'intro', 'conclusion', 'problem', 'mistakes', 'next_step', 'tip', 'warning', 'example'];
  function labelsFor(language) {
    var arr = LABELS[language] || LABELS.English, out = {};
    LABEL_KEYS.forEach(function (k, i) { out[k] = arr[i]; });
    return out;
  }
  var HEX = /^#[0-9A-Fa-f]{6}$/;
  var LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

  function defaultBranding() {
    var lang = (navigator.language || '').toLowerCase();
    var letter = /^(en-us|en-ca|es-mx|fr-ca|en-ph)$/.test(lang);
    return { templateId: 'clean', colors: { primary: PALETTES[0].primary, accent: PALETTES[0].accent, text: '#2B2D3A', background: '#FFFFFF' },
      fonts: { heading: 'Outfit', body: 'Outfit' }, logoDataUrl: '', authorName: '', pageSize: letter ? 'Letter' : 'A4' };
  }
  function safeBranding(b) {
    var d = defaultBranding();
    b = b && typeof b === 'object' ? b : {};
    var c = b.colors || {};
    var tpl = TEMPLATES.some(function (t) { return t.id === b.templateId; }) ? b.templateId : d.templateId;
    var pair = pairFor(b.fonts);
    return {
      templateId: tpl,
      colors: { primary: HEX.test(c.primary) ? c.primary : d.colors.primary, accent: HEX.test(c.accent) ? c.accent : d.colors.accent, text: '#2B2D3A', background: '#FFFFFF' },
      fonts: { heading: pair.heading, body: pair.body },
      logoBadge: b.logoBadge === true,
      logoDataUrl: typeof b.logoDataUrl === 'string' && LOGO_RE.test(b.logoDataUrl) && b.logoDataUrl.length <= 700000 ? b.logoDataUrl : '',
      authorName: typeof b.authorName === 'string' ? b.authorName.slice(0, 80) : '',
      pageSize: PAGE_SIZES[b.pageSize] ? b.pageSize : d.pageSize
    };
  }
  function pairFor(fonts) {
    var hd = fonts && fonts.heading;
    return FONT_PAIRS.filter(function (p) { return p.heading === hd; })[0] || FONT_PAIRS[0];
  }
  function fontsUrl(pairs, arabic) {
    var q = pairs.map(function (p) { return p.q; }).join('&');
    if (arabic) q += '&family=Noto+Sans+Arabic:wght@400;600;700';
    return 'https://fonts.googleapis.com/css2?' + q + '&display=swap';
  }
  function ensureUiFonts() {
    if (document.getElementById('lmg-ui-fonts')) return;
    var link = document.createElement('link');
    link.id = 'lmg-ui-fonts'; link.rel = 'stylesheet'; link.href = fontsUrl(FONT_PAIRS.slice(1), false);
    document.head.appendChild(link);
  }
  // A CSS string literal that can't break out of its quotes.
  function cssString(s) {
    return '"' + String(s).replace(/[\\"\u0000-\u001F\u007F<>]/g, function (ch) { return '\\' + ch.charCodeAt(0).toString(16) + ' '; }) + '"';
  }
  function validUrl(s) {
    if (!s) return true;
    if (s.length > 500 || /\s|["'<>]/.test(s)) return false;
    try { var u = new URL(s); return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && u.hostname.indexOf('.') > 0; }
    catch (e) { return false; }
  }

  // ------------------------------------------------------------------ design: print stylesheet (shared by preview and PDF)
  var TEMPLATE_CSS = [
    '*, *::before, *::after { box-sizing: border-box; }',
    'html, body { margin: 0; padding: 0; }',
    'body { background: #DFE2EA; }',
    '.lmt { font-family: var(--bf), "Noto Sans Arabic", system-ui, -apple-system, "Segoe UI", sans-serif; color: #2B2D3A; font-size: 10.5pt; line-height: 1.62; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-kerning: normal; hyphens: auto; orphans: 3; widows: 3; }',
    '.lmt :where(h1, h2, h3, h4) { font-family: var(--hf), "Noto Sans Arabic", system-ui, sans-serif; font-weight: var(--hw); color: var(--pt); margin: 0; line-height: 1.18; hyphens: manual; }',
    '.lmt :where(p) { margin: 0 0 8pt; }',
    '.lmt :where(ul, ol) { margin: 0; padding: 0; list-style: none; }',
    '.lmt-cover-sub, .lmt-ck-sub, .lmt-cta-text, .lmt-cover-title, .lmt-toc-name { hyphens: manual; }',
    '.lmt a { color: inherit; }',
    '.lmt img { display: block; }',
    /* sheets: screen = paper cards, print = real pages */
    '@media screen { .lmt { padding: 28px 0 40px; } .lmt-sheet { width: var(--pw); min-height: var(--ph); margin: 0 auto 28px; background: #fff; padding: var(--mt) var(--mx) var(--mb); box-shadow: 0 1px 2px rgba(24,28,57,.08), 0 10px 28px -10px rgba(24,28,57,.25); position: relative; }',
    '  .lmt-sheet--cover { height: var(--ph); padding: 0; overflow: hidden; } .lmt-sheet--single { min-height: var(--ph); } }',
    '@media print { body { background: none; } .lmt-sheet { break-before: page; } .lmt-sheet:first-child { break-before: auto; }',
    '  .lmt-sheet--cover { page: lmt-cover; width: var(--pw); height: calc(var(--ph) - 1mm); overflow: hidden; break-after: page; }',
    '  .lmt-sheet--cta { min-height: calc(var(--ph) - 18mm - 20mm - 2mm); }',
    '  .lmt-f-checklist .lmt-sheet--single { height: calc(var(--ph) - 1mm); overflow: hidden; } }',
    /* cover (shared) */
    '.lmt-cover { position: relative; height: 100%; display: flex; flex-direction: column; padding: 26mm 22mm 20mm; }',
    '.lmt-cover-logo { max-height: 15mm; max-width: 60mm; object-fit: contain; }',
    '.lmt-cover-main { margin-top: auto; margin-bottom: auto; }',
    '.lmt-cover-title { font-size: 34pt; line-height: 1.08; letter-spacing: -0.01em; overflow-wrap: anywhere; }',
    '.lmt-cover-sub { margin-top: 7mm; font-size: 13.5pt; line-height: 1.45; color: #5E6075; max-width: 140mm; }',
    '.lmt-cover-brand { font-size: 10.5pt; font-weight: 600; color: var(--pt); }',
    /* section heads */
    '.lmt-kicker { display: block; font-size: 9.5pt; font-weight: 600; color: var(--at); margin-bottom: 2.5mm; }',
    '.lmt-h2 { font-size: 22pt; letter-spacing: -0.005em; }',
    '.lmt-head { margin-bottom: 7mm; break-inside: avoid; break-after: avoid; }',
    '.lmt-section + .lmt-section { margin-top: 12mm; }',
    '.lmt-h3 { font-size: 12.5pt; margin: 6mm 0 2mm; break-after: avoid; }',
    '.lmt-lead { font-weight: 600; color: #1F2133; margin-bottom: 2mm; }',
    /* lists */
    '.lmt-list { margin: 1mm 0 4mm; display: grid; gap: 2mm; }',
    '.lmt-list li { position: relative; padding-inline-start: 7mm; break-inside: avoid; }',
    '.lmt-list--bullets li::before { content: ""; position: absolute; inset-inline-start: 1.6mm; top: .62em; width: 1.6mm; height: 1.6mm; border-radius: 50%; background: var(--at); }',
    '.lmt-list--steps { counter-reset: lmt-li; }',
    '.lmt-list--steps li { counter-increment: lmt-li; padding-inline-start: 9mm; }',
    '.lmt-list--steps li::before { content: counter(lmt-li); position: absolute; inset-inline-start: 0; top: .08em; width: 5.6mm; height: 5.6mm; border-radius: 50%; background: var(--p); color: var(--onp); font-size: 8.5pt; font-weight: 700; line-height: 5.6mm; text-align: center; }',
    '.lmt-list--checklist li { padding-inline-start: 8.5mm; }',
    '.lmt-list--checklist li::before { content: ""; position: absolute; inset-inline-start: 0; top: .22em; width: 4.4mm; height: 4.4mm; border: 1.4pt solid var(--pt); border-radius: 1mm; }',
    /* boxes */
    '.lmt-box { margin: 4mm 0 5mm; padding: 4mm 5mm; border-radius: 2mm; break-inside: avoid; }',
    '.lmt-box-label { display: block; font-size: 9pt; font-weight: 700; margin-bottom: 1mm; color: var(--pt); }',
    '.lmt-box--tip { background: color-mix(in srgb, var(--a) 9%, #fff); }',
    '.lmt-box--example { background: #F4F5F8; }',
    '.lmt-box--warning { background: #FFF5E1; }',
    '.lmt-box--warning .lmt-box-label { color: #8A5A00; }',
    '.lmt-box p { margin: 0; }',
    '.lmt-template { margin: 4mm 0 5mm; padding: 4.5mm 5mm; border: 1.2pt dashed color-mix(in srgb, var(--p) 45%, #fff); border-radius: 2mm; break-inside: avoid; }',
    '.lmt-template p { margin: 1.4mm 0 0; }',
    /* contents page */
    '.lmt-toc-title { font-size: 22pt; margin-bottom: 10mm; }',
    '.lmt-toc li { display: flex; gap: 6mm; align-items: baseline; padding: 4mm 0; border-bottom: .6pt solid #E3E5EC; font-size: 12pt; }',
    '.lmt-toc-num { flex: none; min-width: 10mm; font-weight: 700; color: var(--at); font-variant-numeric: tabular-nums; }',
    '.lmt-toc-name { color: #1F2133; }',
    /* call to action page / box */
    '.lmt-cta { break-inside: avoid; }',
    '.lmt-sheet--cta { display: flex; flex-direction: column; justify-content: center; }',
    '.lmt-cta-inner { padding: 14mm 12mm; border-radius: 4mm; background: var(--p); color: var(--onp); text-align: center; }',
    '.lmt-cta-inner h2 { color: var(--onp); font-size: 24pt; }',
    '.lmt-cta-text { margin: 5mm auto 0; max-width: 120mm; font-size: 12pt; color: color-mix(in srgb, var(--onp) 86%, transparent); }',
    '.lmt-cta-btn { display: inline-block; margin-top: 8mm; padding: 3.6mm 8mm; border-radius: 2mm; background: var(--a); color: var(--ona) !important; font-weight: 700; font-size: 11.5pt; text-decoration: none; }',
    '.lmt-cta-url { display: block; margin-top: 4mm; font-size: 8.5pt; color: color-mix(in srgb, var(--onp) 60%, transparent); overflow-wrap: anywhere; }',
    /* checklist single page */
    '.lmt-f-checklist .lmt-sheet--single { padding: 16mm 16mm 14mm; display: flex; flex-direction: column; }',
    '.lmt-ck-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8mm; padding-bottom: 6mm; margin-bottom: 7mm; border-bottom: 1.2pt solid var(--pt); }',
    '.lmt-ck-title { font-size: 22pt; }',
    '.lmt-ck-sub { margin: 2.5mm 0 0; color: #5E6075; font-size: 11pt; }',
    '.lmt-ck-logo { max-height: 12mm; max-width: 40mm; object-fit: contain; flex: none; }',
    '.lmt-ck-groups { columns: 2; column-gap: 10mm; }',
    '.lmt-ck-group { break-inside: avoid; margin-bottom: 7mm; }',
    '.lmt-ck-group h2 { font-size: 13pt; margin-bottom: 3mm; }',
    '.lmt-ck-group .lmt-list { gap: 2.4mm; font-size: 10.5pt; }',
    '.lmt-f-checklist .lmt-cta { margin-top: auto; }',
    '.lmt-f-checklist .lmt-cta-inner { display: flex; align-items: center; gap: 8mm; text-align: start; padding: 6mm 8mm; }',
    '.lmt-f-checklist .lmt-cta-inner h2 { font-size: 15pt; }',
    '.lmt-f-checklist .lmt-cta-text { margin: 1.5mm 0 0; font-size: 10pt; }',
    '.lmt-f-checklist .lmt-cta-btn { margin: 0; flex: none; }',
    '.lmt-f-checklist .lmt-cta-copy { flex: 1; }',
    '.lmt-ck-brand { margin-top: 4mm; font-size: 9pt; color: #8A8CA0; }',
    '.lmt-ck--roomy .lmt-ck-group { margin-bottom: 9mm; } .lmt-ck--roomy .lmt-ck-group .lmt-list { font-size: 12pt; gap: 3.6mm; } .lmt-ck--roomy .lmt-ck-group h2 { font-size: 15pt; margin-bottom: 4mm; }',
    '.lmt-ck--comfy .lmt-ck-group { margin-bottom: 9mm; } .lmt-ck--comfy .lmt-ck-group .lmt-list { font-size: 11.5pt; gap: 3.4mm; } .lmt-ck--comfy .lmt-ck-group h2 { font-size: 14pt; }',
    '.lmt-ck--roomy .lmt-list--checklist li::before, .lmt-ck--comfy .lmt-list--checklist li::before { width: 5mm; height: 5mm; }',
    '.lmt-ck--roomy .lmt-list--checklist li, .lmt-ck--comfy .lmt-list--checklist li { padding-inline-start: 9.5mm; }',
    /* guide steps */
    /* fit pass: slightly tighter setting for sections that would leave a near-empty page */
    '.lmt-fit { font-size: 10pt; line-height: 1.52; } .lmt-fit .lmt-h3 { margin: 4.5mm 0 1.5mm; } .lmt-fit .lmt-box, .lmt-fit .lmt-template { margin: 3mm 0 3.5mm; padding: 3mm 4mm; } .lmt-fit .lmt-list { gap: 1.4mm; } .lmt-fit .lmt-head { margin-bottom: 5mm; } .lmt-fit p { margin-bottom: 6pt; }',
    '.lmt-fit3 { font-size: 9.2pt; line-height: 1.42; } .lmt-fit3 .lmt-h2 { font-size: 20pt; } .lmt-fit3 .lmt-head { margin-bottom: 4mm; } .lmt-fit3 p { margin-bottom: 4.5pt; }',
    '.lmt-fit2 { font-size: 9.5pt; line-height: 1.46; } .lmt-fit2 .lmt-h3 { margin: 3.5mm 0 1.2mm; } .lmt-fit2 .lmt-box, .lmt-fit2 .lmt-template { margin: 2.5mm 0 3mm; padding: 2.6mm 3.6mm; } .lmt-fit2 .lmt-list { gap: 1.1mm; }',
    '.lmt-stepnum { display: inline-grid; place-items: center; width: 9mm; height: 9mm; border-radius: 50%; background: var(--a); color: #fff; font-family: var(--hf), sans-serif; font-weight: 700; font-size: 12pt; margin-bottom: 3mm; }',

    /* ---------------- template: Clean ---------------- */
    '.lmt-t-clean .lmt-cover { background: #fff; }',
    '.lmt-t-clean .lmt-cover-rule { width: 18mm; height: 1.6mm; background: var(--a); margin-bottom: 8mm; }',
    '.lmt-t-clean .lmt-cover-foot { display: flex; align-items: center; justify-content: space-between; padding-top: 6mm; border-top: .8pt solid #E3E5EC; }',
    '.lmt-t-clean .lmt-cover::after { content: ""; position: absolute; inset-inline-end: 0; top: 0; width: 9mm; height: 100%; background: var(--p); }',
    '.lmt-t-clean .lmt-head::after { content: ""; display: block; width: 12mm; height: 1.2mm; margin-top: 4mm; background: var(--a); }',

    /* ---------------- template: Bold ---------------- */
    '.lmt-t-bold .lmt-cover { background: var(--p); color: var(--onp); }',
    '.lmt-t-bold .lmt-cover::before { content: ""; position: absolute; inset-inline-end: -30mm; bottom: -30mm; width: 120mm; height: 120mm; border-radius: 50%; background: var(--a); opacity: .9; }',
    '.lmt-t-bold .lmt-cover > * { position: relative; }',
    '.lmt-t-bold .lmt-cover-title { color: var(--onp); font-size: 40pt; }',
    '.lmt-t-bold .lmt-cover-sub { color: color-mix(in srgb, var(--onp) 82%, transparent); }',
    '.lmt-t-bold .lmt-cover-brand { color: var(--onp); }',
    '.lmt-logo-badge { align-self: flex-start; flex: none; background: #fff; padding: 3mm 4mm; border-radius: 2mm; box-shadow: 0 0 0 .5pt rgba(24,28,57,.08); }',
    '.lmt-t-editorial .lmt-logo-badge { align-self: center; }',
    '.lmt-t-bold .lmt-cover-rule { display: none; }',
    '.lmt-t-bold .lmt-head { background: var(--p); color: var(--onp); border-radius: 3mm; padding: 8mm 9mm; display: flex; align-items: flex-end; justify-content: space-between; gap: 6mm; }',
    '.lmt-t-bold .lmt-head .lmt-h2 { color: var(--onp); }',
    '.lmt-t-bold .lmt-head .lmt-kicker { color: color-mix(in srgb, var(--onp) 72%, transparent); }',
    '.lmt-t-bold .lmt-bignum { flex: none; font-family: var(--hf), sans-serif; font-weight: var(--hw); font-size: 40pt; line-height: .8; color: var(--aop); }',
    '.lmt-t-bold .lmt-h3 { color: var(--pt); padding-inline-start: 3mm; border-inline-start: 1.4mm solid var(--a); }',
    '.lmt-t-bold .lmt-toc li { border-bottom-color: color-mix(in srgb, var(--p) 18%, #fff); }',
    '.lmt-t-bold .lmt-f-guide .lmt-head, .lmt-t-bold.lmt-f-guide .lmt-head { padding: 6mm 8mm; }',
    '.lmt-t-bold.lmt-f-checklist .lmt-ck-head { background: var(--p); border: 0; padding: 8mm; border-radius: 3mm; }',
    '.lmt-t-bold.lmt-f-checklist .lmt-ck-title { color: var(--onp); } .lmt-t-bold.lmt-f-checklist .lmt-ck-sub { color: color-mix(in srgb, var(--onp) 80%, transparent); }',
    '.lmt-t-bold.lmt-f-checklist .lmt-cta-inner { background: var(--a); color: var(--ona); } .lmt-t-bold.lmt-f-checklist .lmt-cta-inner h2 { color: var(--ona); } .lmt-t-bold.lmt-f-checklist .lmt-cta-text { color: color-mix(in srgb, var(--ona) 86%, transparent); } .lmt-t-bold.lmt-f-checklist .lmt-cta-btn { background: var(--p); color: var(--onp) !important; }',

    /* ---------------- template: Editorial ---------------- */
    '.lmt-t-editorial .lmt-cover { text-align: center; align-items: center; padding: 30mm 26mm 24mm; background: color-mix(in srgb, var(--p) 4%, #fff); }',
    '.lmt-t-editorial .lmt-cover::before, .lmt-t-editorial .lmt-cover::after { content: ""; position: absolute; left: 14mm; right: 14mm; border-top: .8pt solid var(--pt); }',
    '.lmt-t-editorial .lmt-cover::before { top: 14mm; } .lmt-t-editorial .lmt-cover::after { bottom: 14mm; }',
    '.lmt-t-editorial .lmt-cover-title { font-size: 38pt; }',
    '.lmt-t-editorial .lmt-cover-sub { margin-left: auto; margin-right: auto; font-style: italic; }',
    '.lmt-t-editorial .lmt-cover-rule { width: 30mm; height: 0; border-top: .8pt solid var(--a); margin: 0 auto 9mm; }',
    '.lmt-t-editorial .lmt-cover-foot { display: flex; flex-direction: column; align-items: center; gap: 4mm; }',
    '.lmt-t-editorial .lmt-head { text-align: center; padding-bottom: 6mm; border-bottom: .8pt solid color-mix(in srgb, var(--p) 30%, #fff); }',
    '.lmt-t-editorial .lmt-kicker { font-style: italic; font-weight: 400; font-size: 11pt; }',
    '.lmt-t-editorial .lmt-h2 { font-size: 24pt; }',
    '.lmt-t-editorial .lmt-dropcap::first-letter { float: inline-start; font-family: var(--hf), serif; font-weight: var(--hw); font-size: 38pt; line-height: .82; padding-inline-end: 2.2mm; padding-top: 1.2mm; color: var(--pt); }',
    '.lmt-t-editorial .lmt-box { background: none; border-radius: 0; border-top: .8pt solid var(--pt); border-bottom: .8pt solid var(--pt); padding: 3.5mm 1mm; }',
    '.lmt-t-editorial .lmt-box-label { font-style: italic; font-weight: 400; font-size: 10pt; color: var(--at); }',
    '.lmt-t-editorial .lmt-toc-title { text-align: center; }',
    '.lmt-t-editorial .lmt-cta-inner { background: none; color: #2B2D3A; border-top: .8pt solid var(--pt); border-bottom: .8pt solid var(--pt); border-radius: 0; }',
    '.lmt-t-editorial .lmt-cta-inner h2 { color: var(--pt); } .lmt-t-editorial .lmt-cta-text { color: #5E6075; } .lmt-t-editorial .lmt-cta-url { color: #8A8CA0; }',
    '.lmt-t-editorial.lmt-f-checklist .lmt-ck-head { flex-direction: column; align-items: center; text-align: center; border-bottom: .8pt solid var(--pt); }',
    '.lmt-t-editorial.lmt-f-checklist .lmt-ck-group h2 { font-style: italic; }'
  ].join('\n');

  // ------------------------------------------------------------------ design: renderer (DOM only, works in any document)
  function hIn(doc) {
    return function (tag, props, children) {
      var el = doc.createElement(tag);
      if (props) Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, String(v));
      });
      (Array.isArray(children) ? children : [children]).forEach(function (c) {
        if (c === null || c === undefined || c === false) return;
        el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
      });
      return el;
    };
  }

  // White or dark text, whichever reads better on a given background color.
  function onColor(hex) {
    var n = parseInt(hex.slice(1), 16), c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    var lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return lum > 0.42 ? '#1B1D2B' : '#FFFFFF';
  }
  function luminance(hex) {
    var n = parseInt(hex.slice(1), 16);
    var c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { var x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  // The color itself when it reads well on white paper, otherwise a darker version of it.
  function textColor(hex) {
    var r = contrast(hex, '#FFFFFF');
    return r >= 3 ? hex : 'color-mix(in srgb, ' + hex + ' ' + (r >= 2 ? 55 : 35) + '%, #1B1D2B)';
  }
  function renderPrint(doc, d, b, mode) {
    var x = hIn(doc);
    var L = labelsFor(d.meta && d.meta.language);
    var pair = pairFor(b.fonts), size = PAGE_SIZES[b.pageSize];
    var arabic = d.meta && /arab/i.test(d.meta.language || '');
    var brand = b.authorName.trim();
    var logo = b.logoDataUrl && LOGO_RE.test(b.logoDataUrl) ? b.logoDataUrl : '';
    var tpl = b.templateId;

    // ---- head: fonts, template css, variables, page rules
    var head = doc.head;
    while (head.firstChild) head.removeChild(head.firstChild);
    head.appendChild(x('meta', { charset: 'utf-8' }));
    head.appendChild(x('title', { text: d.title }));
    head.appendChild(x('link', { rel: 'stylesheet', href: fontsUrl([pair], arabic) }));
    var css = TEMPLATE_CSS;
    var margins = d.format === 'checklist' ? '0' : '18mm 17mm 20mm';
    var foot = d.format === 'checklist' ? '' :
      ' @bottom-right { content: counter(page); font-family: ' + cssString(pair.body) + ', sans-serif; font-size: 8.5pt; color: #8A8CA0; }' +
      (brand ? ' @bottom-left { content: ' + cssString(brand) + '; font-family: ' + cssString(pair.body) + ', sans-serif; font-size: 8.5pt; color: #8A8CA0; }' : '');
    var vars = ':root { --onp: ' + onColor(b.colors.primary) + '; --ona: ' + onColor(b.colors.accent) +
      '; --pt: ' + textColor(b.colors.primary) + '; --at: ' + textColor(b.colors.accent) + '; --aop: ' + (contrast(b.colors.accent, b.colors.primary) < 2.2 ? 'color-mix(in srgb, ' + onColor(b.colors.primary) + ' 45%, transparent)' : b.colors.accent) +
      '; --p: ' + b.colors.primary + '; --a: ' + b.colors.accent + '; --hf: ' + cssString(pair.heading) + '; --bf: ' + cssString(pair.body) +
      '; --hw: ' + pair.hw + '; --pw: ' + size.w + 'mm; --ph: ' + size.h + 'mm; --mt: 18mm; --mx: 17mm; --mb: 20mm; }';
    var pages = '@page { size: ' + size.css + '; margin: ' + margins + ';' + foot + ' }' +
      ' @page lmt-cover { margin: 0; @bottom-right { content: none; } @bottom-left { content: none; } }';
    head.appendChild(x('style', { text: css + '\n' + vars + '\n' + pages }));
    if (mode === 'screen') head.appendChild(x('style', { 'data-zoom': '1', text: 'html { zoom: 1; }' }));

    var body = doc.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    doc.documentElement.setAttribute('lang', arabic ? 'ar' : 'en');
    doc.documentElement.setAttribute('dir', arabic ? 'rtl' : 'ltr');

    // ---- blocks
    function blocks(list, dropcap) {
      var firstP = true;
      return (list || []).map(function (bl) {
        switch (bl.type) {
          case 'paragraph':
            var p = x('p', { class: dropcap && firstP && tpl === 'editorial' ? 'lmt-dropcap' : null, text: bl.text });
            firstP = false; return p;
          case 'subheading': return x('h3', { class: 'lmt-h3', text: bl.text });
          case 'bullets': case 'steps': case 'checklist':
            return x('div', null, [
              bl.text ? x('p', { class: 'lmt-lead', text: bl.text }) : null,
              x(bl.type === 'steps' ? 'ol' : 'ul', { class: 'lmt-list lmt-list--' + bl.type }, bl.items.map(function (it) { return x('li', { text: it }); }))
            ]);
          case 'tip': case 'warning': case 'example':
            return x('div', { class: 'lmt-box lmt-box--' + bl.type }, [x('span', { class: 'lmt-box-label', text: L[bl.type] }), x('p', { text: bl.text })]);
          case 'template':
            return x('div', { class: 'lmt-template' }, [x('span', { class: 'lmt-box-label', text: bl.text })].concat(bl.items.map(function (it) { return x('p', { text: it }); })));
          default: return null;
        }
      });
    }
    function kicker(sec, i) {
      var n = d.sections.filter(function (s) { return s.type === sec.type; }).indexOf(sec) + 1;
      return { intro: L.intro, conclusion: L.conclusion, problem: L.problem, mistakes: L.mistakes, next_step: L.next_step,
        chapter: L.chapter + ' ' + n, step: L.step + ' ' + n, group: '' }[sec.type];
    }
    function numberFor(sec) {
      if (sec.type !== 'chapter' && sec.type !== 'step') return null;
      var n = d.sections.filter(function (s) { return s.type === sec.type; }).indexOf(sec) + 1;
      return n < 10 ? '0' + n : String(n);
    }
    function sectionHead(sec) {
      var num = numberFor(sec);
      return x('header', { class: 'lmt-head' }, [
        x('div', null, [
          x('span', { class: 'lmt-kicker', text: kicker(sec) }),
          x('h2', { class: 'lmt-h2', text: sec.heading })
        ]),
        tpl === 'bold' && num ? x('span', { class: 'lmt-bignum', 'aria-hidden': 'true', text: num }) : null
      ]);
    }
    function ctaBlock() {
      var c = d.cta || {};
      if (!c.heading && !c.text && !c.buttonLabel) return null;
      var url = validUrl(c.url) && c.url ? c.url : '';
      var btn = c.buttonLabel ? (url ? x('a', { class: 'lmt-cta-btn', href: url, text: c.buttonLabel }) : x('span', { class: 'lmt-cta-btn', text: c.buttonLabel })) : null;
      var shortUrl = url ? url.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
      if (d.format === 'checklist') {
        return x('div', { class: 'lmt-cta' }, x('div', { class: 'lmt-cta-inner' }, [
          x('div', { class: 'lmt-cta-copy' }, [c.heading ? x('h2', { text: c.heading }) : null, c.text ? x('p', { class: 'lmt-cta-text', text: c.text }) : null]), btn
        ]));
      }
      return x('div', { class: 'lmt-cta' }, x('div', { class: 'lmt-cta-inner' }, [
        c.heading ? x('h2', { text: c.heading }) : null,
        c.text ? x('p', { class: 'lmt-cta-text', text: c.text }) : null,
        btn,
        shortUrl && c.showUrl ? x('span', { class: 'lmt-cta-url', text: shortUrl }) : null
      ]));
    }
    function cover() {
      var logoEl = logo ? x('img', { class: 'lmt-cover-logo', src: logo, alt: '' }) : null;
      return x('section', { class: 'lmt-sheet lmt-sheet--cover' }, x('div', { class: 'lmt-cover' }, [
        logoEl ? (b.logoBadge ? x('div', { class: 'lmt-logo-badge' }, logoEl) : logoEl) : null,
        x('div', { class: 'lmt-cover-main' }, [
          x('div', { class: 'lmt-cover-rule', 'aria-hidden': 'true' }),
          x('h1', { class: 'lmt-cover-title', text: d.title }),
          d.subtitle ? x('p', { class: 'lmt-cover-sub', text: d.subtitle }) : null
        ]),
        x('div', { class: 'lmt-cover-foot' }, [brand ? x('span', { class: 'lmt-cover-brand', text: brand }) : x('span')])
      ]));
    }

    var root = x('main', { class: 'lmt lmt-t-' + tpl + ' lmt-f-' + d.format });
    if (d.format === 'checklist') {
      var logoEl = logo ? x('img', { class: 'lmt-ck-logo', src: logo, alt: '' }) : null;
      var total = d.sections.reduce(function (n, s) {
        var c = 0; (s.blocks || []).forEach(function (bl) { if (bl.type === 'checklist') c += bl.items.length; });
        return n + (c || s.keyPoints.length);
      }, 0);
      var density = total <= 12 ? 'lmt-ck--roomy' : total <= 17 ? 'lmt-ck--comfy' : 'lmt-ck--dense';
      root.appendChild(x('section', { class: 'lmt-sheet lmt-sheet--single ' + density }, [
        x('header', { class: 'lmt-ck-head' }, [
          x('div', null, [x('h1', { class: 'lmt-ck-title', text: d.title }), d.subtitle ? x('p', { class: 'lmt-ck-sub', text: d.subtitle }) : null]),
          logoEl ? (b.logoBadge ? x('div', { class: 'lmt-logo-badge' }, logoEl) : logoEl) : null
        ]),
        x('div', { class: 'lmt-ck-groups' }, d.sections.map(function (s) {
          var items = [];
          (s.blocks || []).forEach(function (bl) { if (bl.type === 'checklist') items = items.concat(bl.items); });
          if (!items.length) items = s.keyPoints.filter(function (k) { return k.trim(); });
          return x('section', { class: 'lmt-ck-group' }, [x('h2', { text: s.heading }), x('ul', { class: 'lmt-list lmt-list--checklist' }, items.map(function (it) { return x('li', { text: it }); }))]);
        })),
        ctaBlock(),
        brand ? x('p', { class: 'lmt-ck-brand', text: brand }) : null
      ]));
    } else if (d.format === 'ebook') {
      root.appendChild(cover());
      var chapters = d.sections;
      root.appendChild(x('section', { class: 'lmt-sheet' }, [
        x('h2', { class: 'lmt-toc-title', text: L.contents }),
        x('ol', { class: 'lmt-toc' }, chapters.map(function (s) {
          var num = numberFor(s);
          return x('li', null, [x('span', { class: 'lmt-toc-num', text: num || '' }), x('span', { class: 'lmt-toc-name', text: s.heading })]);
        }))
      ]));
      chapters.forEach(function (s) {
        root.appendChild(x('section', { class: 'lmt-sheet lmt-section' }, [sectionHead(s)].concat(blocks(s.blocks, true))));
      });
      var cta = ctaBlock();
      if (cta) root.appendChild(x('section', { class: 'lmt-sheet lmt-sheet--cta' }, cta));
    } else {
      root.appendChild(cover());
      root.appendChild(x('section', { class: 'lmt-sheet' }, d.sections.map(function (s) {
        return x('section', { class: 'lmt-section' }, [sectionHead(s)].concat(blocks(s.blocks, s.type === 'problem')));
      })));
      var gcta = ctaBlock();
      if (gcta) root.appendChild(x('section', { class: 'lmt-sheet lmt-sheet--cta' }, gcta));
    }
    body.appendChild(root);
    return root;
  }

  // Measures each flowing sheet against the printable page height. When a sheet would spill a
  // small remainder onto an extra page, its setting is tightened one or two notches.
  function fitSheets(doc, format) {
    if (format === 'checklist') return;
    var probe = doc.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:calc(var(--ph) - 38mm);';
    doc.body.appendChild(probe);
    var pageH = probe.getBoundingClientRect().height;
    probe.remove();
    if (!pageH) return;
    function used(sheet) {
      var first = sheet.firstElementChild, last = sheet.lastElementChild;
      if (!first) return 0;
      return last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
    }
    Array.prototype.forEach.call(doc.querySelectorAll('.lmt-sheet:not(.lmt-sheet--cover):not(.lmt-sheet--cta)'), function (sheet) {
      sheet.classList.remove('lmt-fit', 'lmt-fit2', 'lmt-fit3');
      // At risk = ends just after a page boundary (small spill) or just before one: in print,
      // boxes that can't be split are pushed down, so "almost full" often spills too.
      function atRisk(p) { var r = p - Math.floor(p); return (p >= 1 && r < 0.34) || (p >= 0.8 && r > 0.86); }
      function settled(p) { var r = p - Math.floor(p); return !(p >= 1 && r < 0.34) && r <= 0.94; }
      if (!atRisk(used(sheet) / pageH)) return;
      var levels = ['lmt-fit', 'lmt-fit2', 'lmt-fit3'];
      for (var i = 0; i < levels.length; i++) {
        sheet.classList.add(levels[i]);
        if (settled(used(sheet) / pageH)) return;
      }
      // Could not end cleanly even at the tightest setting: keep the normal size instead.
      sheet.classList.remove('lmt-fit', 'lmt-fit2', 'lmt-fit3');
    });
  }

  function whenReady(doc) {
    var imgs = Array.prototype.slice.call(doc.images || []).map(function (img) {
      return img.decode ? img.decode().catch(function () {}) : Promise.resolve();
    });
    var fonts = doc.fonts && doc.fonts.ready ? doc.fonts.ready : Promise.resolve();
    var timeout = new Promise(function (r) { setTimeout(r, 4000); });
    return Promise.race([Promise.all([fonts].concat(imgs)), timeout]).then(function () {
      return new Promise(function (r) { setTimeout(r, 120); });
    });
  }

  var DL_HINT_PRINT = 'Your browser\'s print window opens. Choose "Save as PDF" as the destination (not "Microsoft Print to PDF"), so your button stays clickable.';
  var DL_HINT_SERVER = 'Your PDF downloads in a few seconds, with a clickable button.';
  var DL_HINT = config.pdfServer ? DL_HINT_SERVER : DL_HINT_PRINT;
  var EMPTY_DOC = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

  // Builds the document in a hidden frame and opens the browser's print dialog.
  // opts.dryRun keeps the frame and skips print() (used by tests).
  function exportPdf(opts) {
    opts = opts || {};
    var d = state.doc, b = safeBranding(d.branding);
    var old = document.getElementById('lmg-print-frame');
    if (old) old.remove();
    var frame = document.createElement('iframe');
    frame.id = 'lmg-print-frame';
    frame.setAttribute('aria-hidden', 'true'); frame.setAttribute('tabindex', '-1'); frame.title = 'Print';
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    return new Promise(function (resolve) {
      frame.addEventListener('load', function () {
        var doc = frame.contentDocument;
        renderPrint(doc, d, b, 'print');
        whenReady(doc).then(function () {
          fitSheets(doc, d.format);
          if (opts.dryRun) { resolve(frame); return; }
          var oldTitle = document.title;
          document.title = d.title;
          var cleanup = function () { document.title = oldTitle; setTimeout(function () { frame.remove(); }, 500); };
          try {
            frame.contentWindow.addEventListener('afterprint', cleanup);
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch (e) { cleanup(); }
          setTimeout(function () { document.title = oldTitle; }, 3000);
          resolve(frame);
        });
      }, { once: true });
      frame.srcdoc = EMPTY_DOC;
      document.body.appendChild(frame);
    });
  }

  // ------------------------------------------------------------------ mock API (data-mock="1")
  function mockApi(path, body, signal) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () {
        if (path === 'pass') { resolve(config.sitekey && !body.turnstile ? { ok: false, code: 'verify_required', message: 'Please confirm you are human, then try again.' } : { ok: true, pass: 'mock.' + Date.now() }); return; }
        if (path === 'outline' && config.sitekey && !body.turnstile) { resolve({ ok: false, code: 'verify_required', message: 'Please confirm you are human, then try again.' }); return; }
        var r = path === 'outline' ? mockOutline(body) : mockSection(body);
        if (r.ok && path === 'outline') r.pass = 'mock.' + Date.now();
        resolve(r);
      }, path === 'outline' ? 1400 : path === 'pass' ? 300 : 700 + Math.random() * 1600);
      if (signal) signal.addEventListener('abort', function () { clearTimeout(t); resolve({ ok: false, code: 'aborted' }); });
    });
  }
  function mockOutline(b) {
    if (/\bfail\b/i.test(b.topic)) return { ok: false, code: 'generation_failed', message: 'We couldn\'t create your outline right now. Please try again in a minute.' };
    var r = FORMATS[b.format], n = { short: r.min, standard: Math.min(r.min + 1, r.max), detailed: Math.min(r.min + 3, r.max) }[b.length];
    var heads = {
      chapter: ['Know exactly who you help', 'Shape an offer people want', 'Start conversations without ads', 'Turn calls into clients', 'Ask for referrals the right way', 'Keep clients longer', 'Plan your next 90 days'],
      step: ['Pick your three content pillars', 'Batch your ideas in one hour', 'Write captions from templates', 'Schedule a month in one sitting', 'Review what worked', 'Recycle your best posts', 'Plan the next month'],
      group: ['Before you start', 'Build the basics', 'Launch week', 'After launch', 'Keep it going']
    }[r.middle];
    var sections = r.first.map(function (t) { return { type: t, heading: t === 'intro' ? 'Why this matters now' : 'Why most plans fall apart' }; })
      .concat(heads.slice(0, n).map(function (hd) { return { type: r.middle, heading: hd }; }))
      .concat(r.last.map(function (t) { return { type: t, heading: { conclusion: 'Your next move', mistakes: 'Mistakes to avoid', next_step: 'What to do next' }[t] }; }));
    return {
      ok: true,
      document: {
        schemaVersion: '1.0', format: b.format,
        meta: { topic: b.topic, audience: b.audience, offer: b.offer, tone: b.tone, length: b.length, language: b.language },
        title: b.format === 'checklist' ? 'The ' + cap(b.topic) + ' Checklist' : cap(b.topic) + ': a practical ' + r.name.toLowerCase(),
        subtitle: 'For ' + b.audience.replace(/\.$/, '').toLowerCase() + '.',
        sections: sections.map(function (s, i) {
          return { id: 's' + (i + 1), type: s.type, heading: s.heading, goal: 'The reader will be able to act on this today.',
            keyPoints: s.type === 'group' ? ['Write down one clear goal', 'Block two hours in your calendar', 'Tell one person your deadline', 'Prepare your tools'] : ['The core idea in plain words', 'A short example from your world', 'A template you can copy'],
            status: 'outlined', blocks: [] };
        }),
        cta: { heading: 'Ready for the next step?', text: b.offer ? 'Get ' + b.offer + ' and go further, faster.' : 'Take the next step and keep the momentum going.', buttonLabel: b.offer ? 'Get started' : 'Take the next step', url: '' }
      },
      generator: { promptVersion: 'mock', model: 'mock', tokens: 0 }
    };
  }
  function mockSection(b) {
    if (config.sitekey && !(typeof b.pass === 'string' && /^mock\.\d+$/.test(b.pass))) return { ok: false, code: 'verify_required', message: 'For your security, please confirm you are human to keep writing.' };
    var sec = b.document.sections.filter(function (s) { return s.id === b.sectionId; })[0];
    if (!sec) return { ok: false, code: 'invalid_input', message: 'sectionId does not match any section in the outline.' };
    if (/\[fail\]/i.test(sec.heading)) return { ok: false, code: 'generation_failed', message: 'We couldn\'t write this section right now. Please try again.' };
    if (sec.type === 'group') {
      return { ok: true, sectionId: sec.id, blocks: [{ type: 'checklist', text: '', items: sec.keyPoints.slice(0, 5).map(function (k) { return k.replace(/^./, function (c) { return c.toUpperCase(); }); }) }] };
    }
    return { ok: true, sectionId: sec.id, blocks: [
      { type: 'paragraph', text: 'This section shows how to ' + sec.heading.toLowerCase() + '. It keeps things simple so you can act on it the same day, even with a busy week.', items: [] },
      { type: 'subheading', text: sec.keyPoints[0] || 'The core idea', items: [] },
      { type: 'paragraph', text: 'Start small. Pick one action, do it today, and look at the result before you add more. Progress comes from repeating the basics, not from doing everything at once.', items: [] },
      { type: 'steps', text: 'Do this now:', items: ['Write down what you want from this step', 'Block 30 minutes in your calendar', 'Do the first action and note what happened'] },
      { type: 'example', text: 'Imagine a coach who sends three short messages a week to past contacts. After a month, two of them turn into calls.', items: [] },
      { type: 'tip', text: 'Action step: choose one idea from this section and do it before tomorrow.', items: [] }
    ] };
  }

  // ------------------------------------------------------------------ go
  if (restored && state.step > 1) {
    state.notice = { kind: 'info', text: 'Welcome back. Your work was saved in this browser.',
      action: confirmButton('Start over', 'Click again to delete it', startOver, { kind: 'quiet', small: true }) };
  }
  render();
  root.lmg = { version: VERSION, state: function () { return state; }, reset: startOver, exportPdf: exportPdf };
})();
