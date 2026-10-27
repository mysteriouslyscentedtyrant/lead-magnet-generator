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
  var VERSION = '0.1.0';

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
    concurrency: Math.max(1, Math.min(4, parseInt(root.getAttribute('data-concurrency'), 10) || 3))
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
      return s;
    } catch (e) { return null; }
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        var copy = { v: 1, step: state.step, format: state.format, input: state.input, doc: state.doc };
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
    if ((r.code === 'invalid_input' || r.code === 'rejected' || r.code === 'config') && r.message) return r.message;
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
    api('outline', {
      format: state.format, topic: i.topic.trim(), audience: i.audience.trim(), offer: i.offer.trim(),
      tone: i.tone, length: i.length, language: languageValue()
    }, outlineAbort.signal).then(function (r) {
      outlineAbort = null; state.busy = null;
      if (r.code === 'aborted') { render(); return; }
      if (!r.ok) { state.notice = { kind: 'error', text: errorText(r, 'create your outline') }; render(); return; }
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

  function startWriting(ids) {
    if (run) return;
    var doc = state.doc;
    var targets = doc.sections.filter(function (s) {
      return ids ? ids.indexOf(s.id) !== -1 : (s.status !== 'written' || s.dirty);
    });
    if (!targets.length) { save(); render(); return; }
    targets.forEach(function (s) { s.status = 'queued'; s.error = null; });
    run = { controller: new AbortController(), queue: targets.map(function (s) { return s.id; }) };
    state.busy = 'writing';
    save(); render();
    var payload = outlinePayload();
    var current = run;
    function worker() {
      if (current !== run || !current.queue.length) return Promise.resolve();
      var id = current.queue.shift();
      var sec = doc.sections.filter(function (s) { return s.id === id; })[0];
      if (!sec) return worker();
      sec.status = 'writing'; render();
      return api('section', { document: payload, sectionId: id }, current.controller.signal).then(function (r) {
        if (r.code === 'aborted') { if (sec.status === 'writing') sec.status = 'outlined'; return; }
        if (r.ok) { sec.blocks = r.blocks; sec.status = 'written'; sec.dirty = false; sec.error = null; }
        else { sec.status = 'error'; sec.error = errorText(r, 'write this section'); }
        save(); render();
        return worker();
      });
    }
    var workers = [];
    for (var i = 0; i < Math.min(config.concurrency, targets.length); i++) workers.push(worker());
    Promise.all(workers).then(function () {
      if (current !== run) return;
      run = null; state.busy = null; save(); render();
    });
  }
  function stopWriting() {
    if (!run) return;
    run.controller.abort();
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

    root.appendChild(h('header', { class: 'lmg-head' }, [
      h('h2', { class: 'lmg-title', text: 'Create a lead magnet in minutes' }),
      h('p', { class: 'lmg-lede', text: 'Pick a format, describe your audience, and get a ready-to-edit ebook, guide or checklist written for you.' })
    ]));
    root.appendChild(renderStepper());

    els.aside = h('aside', { class: 'lmg-aside', 'aria-label': 'Your lead magnet' });
    var main = h('section', { class: 'lmg-main' });
    var panels = { 1: panelFormat, 2: panelDetails, 3: panelOutline, 4: panelWriting, 5: panelDesign };
    main.appendChild((panels[state.step] || panelFormat)());
    root.appendChild(h('div', { class: 'lmg-body' }, [main, els.aside]));
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
          : button(busy ? 'Creating your outline…' : (hasOutline ? 'Create a new outline' : 'Create outline'), { busy: busy, disabled: busy, onClick: createOutline }),
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
      var st = s.dirty && s.status === 'written' ? 'outlined' : s.status;
      var icon = st === 'written' ? 'done' : st === 'error' ? 'error' : 'wait';
      var status = st === 'written' ? fmtNum(words(s)) + ' words'
        : st === 'writing' ? 'Writing…'
        : st === 'queued' ? 'Waiting'
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

    var label = busy ? 'Writing your ' + FORMATS[d.format].name.toLowerCase() + '…'
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

  // ---- Step 5: design (templates and PDF arrive in the next version)
  function panelDesign() {
    var d = state.doc;
    var copyBtn = button('Copy text', { kind: 'ghost', small: true, onClick: function () {
      var text = docToText(d);
      var done = function () { copyBtn.lastChild.textContent = 'Copied'; setTimeout(function () { copyBtn.lastChild.textContent = 'Copy text'; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    } });
    return panel('Design and download', null, [
      notice(state.notice),
      notice({ kind: 'info', text: 'Design templates and PDF download are coming in the next update. Your content is saved in this browser until then.' }),
      h('div', { class: 'lmg-preview' }, [
        h('div', { class: 'lmg-preview-head' }, [h('span', { class: 'lmg-preview-title', text: 'Content preview' }), copyBtn]),
        renderDoc(d)
      ]),
      h('div', { class: 'lmg-actions' }, [
        button('Back to writing', { kind: 'ghost', onClick: function () { goTo(4); } }),
        h('span', { class: 'lmg-actions-spacer' }),
        confirmButton('Start a new lead magnet', 'Click again to delete this one', startOver, { kind: 'quiet' })
      ])
    ]);
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
        var st = s.dirty && s.status === 'written' ? 'outlined' : s.status;
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

  // ------------------------------------------------------------------ mock API (data-mock="1")
  function mockApi(path, body, signal) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(path === 'outline' ? mockOutline(body) : mockSection(body)); }, path === 'outline' ? 1400 : 700 + Math.random() * 1600);
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
  root.lmg = { version: VERSION, state: function () { return state; }, reset: startOver };
})();
