// Kaplan Surface SDK. Uploaded as-is via Theme Editor custom JavaScript,
// concatenated after the Floating UI UMD builds. Plain browser JS, ES5 only.
(function () {
  'use strict';

  // The build rewrites this placeholder to the CDN URL plus ?v=<version>.
  var RULES_URL = '__RULES_URL__';
  var SCOPE = 'surface';
  var NAMESPACE = 'kaplan';
  var HOST_PREFIX = 'kaplan-surface-';
  var MISS_TIMEOUT_MS = 10000;

  // Canvas sets ENV.current_user_id on every page for a signed-in user. Without one
  // (the login page, error pages) there is no session to read rules for and nothing to render.
  if (!(window.ENV && window.ENV.current_user_id)) return;

  var states = {};
  var dismissed = null;
  var coursesPromise = null;
  var observer = null;

  function fetchJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (response) {
      return response.text().then(function (raw) {
        // Hosted Canvas has historically prefixed JSON API responses with
        // while(1); to block JSON hijacking; strip it defensively even
        // though this instance does not send it.
        var stripped = raw.replace(/^while\s*\(\s*1\s*\)\s*;/, '');
        var body = stripped ? JSON.parse(stripped) : null;
        return { status: response.status, body: body };
      });
    });
  }

  function coursesGrantAccess(courses, rule) {
    if (!Array.isArray(courses)) return false;
    for (var i = 0; i < courses.length; i++) {
      var course = courses[i];
      var code = course && course.course_code;
      if (typeof code !== 'string') continue;
      var upperCode = code.toUpperCase();
      var prefixMatches = false;
      for (var p = 0; p < rule.coursePrefixes.length; p++) {
        if (upperCode.indexOf(rule.coursePrefixes[p].toUpperCase()) === 0) { prefixMatches = true; break; }
      }
      if (!prefixMatches) continue;
      var enrollments = course.enrollments;
      if (!Array.isArray(enrollments)) continue;
      for (var e = 0; e < enrollments.length; e++) {
        if (rule.enrollmentTypes.indexOf(enrollments[e].type) !== -1) return true;
      }
    }
    return false;
  }

  function customDataUrl() {
    return '/api/v1/users/self/custom_data/' + SCOPE + '?ns=' + NAMESPACE;
  }

  function csrfToken() {
    var match = /(?:^|;\s*)_csrf_token=([^;]*)/.exec(document.cookie || '');
    return match ? decodeURIComponent(match[1]) : '';
  }

  function matchesPath(pattern) {
    if (typeof pattern !== 'string') return false;
    var escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\\\*/g, '.*') + '$').test(window.location.pathname);
  }

  function rolesMatch(rule) {
    var wanted = rule.audience && rule.audience.roles;
    if (!Array.isArray(wanted) || wanted.length === 0) return true;
    var held = window.ENV && window.ENV.current_user_roles;
    if (!Array.isArray(held)) return false;
    for (var i = 0; i < wanted.length; i++) {
      if (held.indexOf(wanted[i]) === -1) return false;
    }
    return true;
  }

  function loadCourses() {
    if (!coursesPromise) {
      coursesPromise = fetchJson('/api/v1/courses?enrollment_state=active&per_page=100').then(function (result) {
        return result.status === 200 ? result.body : [];
      });
    }
    return coursesPromise;
  }

  function loadDismissed() {
    return fetchJson(customDataUrl()).then(function (result) {
      // Canvas answers 400 "no data for scope" until something has been stored.
      if (result.status !== 200) return {};
      var data = result.body && result.body.data;
      var map = data && data.dismissed;
      return map && typeof map === 'object' ? map : {};
    }).catch(function () { return {}; });
  }

  function styleText() {
    return ':host { position: absolute; top: 0; left: 0; z-index: 10000; }' +
      '#tip { position: absolute; top: 0; left: 0; max-width: 260px; padding: 8px 10px;' +
      ' border-radius: 6px; background: #1f2933; color: #ffffff;' +
      ' font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;' +
      ' box-shadow: 0 4px 12px rgba(0, 0, 0, 0.32); }' +
      '#arrow { position: absolute; width: 8px; height: 8px; background: #1f2933; transform: rotate(45deg); }' +
      '#dismiss { display: block; margin-top: 8px; padding: 2px 8px; border: 1px solid rgba(255, 255, 255, 0.45);' +
      ' border-radius: 4px; background: transparent; color: #ffffff; font: inherit; font-size: 12px; cursor: pointer; }';
  }

  function positioner(rule, anchor, tip, arrowEl) {
    return function () {
      FloatingUIDOM.computePosition(anchor, tip, {
        placement: rule.placement,
        middleware: [
          FloatingUIDOM.offset(8),
          FloatingUIDOM.flip(),
          FloatingUIDOM.shift({ padding: 8 }),
          FloatingUIDOM.arrow({ element: arrowEl })
        ]
      }).then(function (placed) {
        tip.style.left = placed.x + 'px';
        tip.style.top = placed.y + 'px';
        var data = placed.middlewareData && placed.middlewareData.arrow;
        if (!data) return;
        var opposite = { top: 'bottom', right: 'left', bottom: 'top', left: 'right' };
        var staticSide = opposite[placed.placement.split('-')[0]];
        arrowEl.style.left = '';
        arrowEl.style.top = '';
        arrowEl.style.right = '';
        arrowEl.style.bottom = '';
        if (typeof data.x === 'number') arrowEl.style.left = data.x + 'px';
        if (typeof data.y === 'number') arrowEl.style.top = data.y + 'px';
        if (staticSide) arrowEl.style[staticSide] = '-4px';
      }).catch(function () {});
    };
  }

  function render(record, anchor) {
    var rule = record.rule;

    var host = document.createElement('div');
    host.id = HOST_PREFIX + rule.id;
    host.setAttribute('data-surface-rule', rule.id);
    document.body.appendChild(host);
    // Leave 'pending' before anything that can throw. A render that fails
    // partway (Floating UI missing, say) would otherwise be retried on every
    // mutation, appending another host each time.
    record.host = host;
    record.phase = 'rendered';
    var root = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = styleText();
    root.appendChild(style);

    var tip = document.createElement('div');
    tip.id = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('data-rule', rule.id);

    var text = document.createElement('span');
    text.textContent = rule.content;
    tip.appendChild(text);

    var arrowEl = document.createElement('div');
    arrowEl.id = 'arrow';
    arrowEl.setAttribute('aria-hidden', 'true');
    tip.appendChild(arrowEl);

    if (rule.dismissible) {
      var button = document.createElement('button');
      button.id = 'dismiss';
      button.setAttribute('type', 'button');
      button.setAttribute('aria-label', 'Dismiss');
      button.textContent = 'Dismiss';
      button.addEventListener('click', function () { dismiss(record); });
      tip.appendChild(button);
    }

    root.appendChild(tip);

    record.stop = FloatingUIDOM.autoUpdate(anchor, tip, positioner(rule, anchor, tip, arrowEl));

    if (!anchor.getAttribute('aria-describedby')) {
      anchor.setAttribute('aria-describedby', host.id);
      record.describedBy = true;
    }

    if (record.missTimer) {
      clearTimeout(record.missTimer);
      record.missTimer = null;
    }

    console.debug('[surface-sdk] rendered ' + rule.id + ' on ' + rule.element_selector);
    if (window.__kaplanSurface.rendered.indexOf(rule.id) === -1) window.__kaplanSurface.rendered.push(rule.id);
  }

  function teardown(record) {
    var host = record.host;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (record.stop) {
      record.stop();
      record.stop = null;
    }
    if (record.missTimer) {
      clearTimeout(record.missTimer);
      record.missTimer = null;
    }
    if (record.describedBy && host) {
      // Canvas may have swapped the anchor since render; find whatever now
      // carries the attribute we set rather than re-running the selector.
      var anchor = document.querySelector('[aria-describedby="' + host.id + '"]');
      if (anchor) anchor.removeAttribute('aria-describedby');
      record.describedBy = false;
    }
    record.host = null;
    record.phase = 'absent';
    delete states[record.rule.id];
  }

  function dismiss(record) {
    var rule = record.rule;
    teardown(record);
    dismissed[rule.id] = new Date().toISOString();
    var token = csrfToken();
    // Send the whole merged map, so a concurrent write is last-write-wins
    // and a retry after a failure converges instead of dropping ids.
    fetch(customDataUrl(), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-CSRF-Token': token
      },
      body: JSON.stringify({ ns: NAMESPACE, data: { dismissed: dismissed } })
    }).then(function (response) {
      console.info('[surface-sdk] dismiss ' + rule.id + ' csrf_header=' + (token ? 'present' : 'missing') + ' status=' + response.status);
    }).catch(function () {
      console.info('[surface-sdk] dismiss ' + rule.id + ' csrf_header=' + (token ? 'present' : 'missing') + ' status=0');
    });
  }

  function probe(record) {
    if (record.phase !== 'pending') return;
    try {
      var anchor = document.querySelector(record.rule.element_selector);
      if (anchor) render(record, anchor);
    } catch (error) {
      // One malformed selector or one failed render must not stop the rest.
    }
  }

  function probeAll() {
    var ids = Object.keys(states);
    for (var i = 0; i < ids.length; i++) {
      var record = states[ids[i]];
      if (record) probe(record);
    }
  }

  function ensureObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(probeAll);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function reportMiss(record) {
    record.missTimer = null;
    if (record.phase !== 'pending' || record.missLogged) return;
    record.missLogged = true;
    // Canvas mounts some regions long after load, so keep watching past the
    // timeout; the log only reports that the element was not there yet.
    console.debug('[surface-sdk] no element for rule ' + record.rule.id + ': ' + record.rule.element_selector);
  }

  function begin(rule) {
    if (states.hasOwnProperty(rule.id)) return;
    var record = {
      rule: rule,
      phase: 'pending',
      host: null,
      stop: null,
      missTimer: null,
      missLogged: false,
      describedBy: false
    };
    states[rule.id] = record;
    record.missTimer = setTimeout(function () { reportMiss(record); }, MISS_TIMEOUT_MS);
    ensureObserver();
    probe(record);
  }

  function consider(rule) {
    if (states.hasOwnProperty(rule.id)) return;
    if (dismissed.hasOwnProperty(rule.id)) return;
    if (!matchesPath(rule.url_pattern)) return;
    if (!rolesMatch(rule)) return;
    var prefix = rule.audience && rule.audience.course_code_prefix;
    if (!prefix) {
      begin(rule);
      return;
    }
    loadCourses().then(function (courses) {
      if (!matchesPath(rule.url_pattern)) return;
      if (!coursesGrantAccess(courses, { coursePrefixes: [prefix], enrollmentTypes: ['student', 'teacher'] })) return;
      begin(rule);
    }).catch(function () {});
  }

  function evaluate(rules) {
    var ids = Object.keys(states);
    var i;
    for (i = 0; i < ids.length; i++) {
      var record = states[ids[i]];
      if (record && !matchesPath(record.rule.url_pattern)) teardown(record);
    }
    for (i = 0; i < rules.length; i++) {
      consider(rules[i]);
    }
  }

  function dismissTarget(record) {
    return !!record && record.phase === 'rendered' && !!record.rule.dismissible && !!record.host && !!record.host.shadowRoot;
  }

  function focusedTarget() {
    var ids = Object.keys(states);
    for (var i = 0; i < ids.length; i++) {
      var record = states[ids[i]];
      if (dismissTarget(record) && record.host.shadowRoot.activeElement) return record;
    }
    return null;
  }

  function newestTarget() {
    var order = window.__kaplanSurface.rendered;
    for (var i = order.length - 1; i >= 0; i--) {
      if (!states.hasOwnProperty(order[i])) continue;
      var record = states[order[i]];
      if (dismissTarget(record)) return record;
    }
    return null;
  }

  function onKeydown(event) {
    // Keydown from inside a shadow root bubbles to document, so one listener
    // covers every tooltip.
    if (event.key !== 'Escape') return;
    var target = focusedTarget() || newestTarget();
    if (target) dismiss(target);
  }

  function watchNavigation(rules) {
    var push = history.pushState;
    var replace = history.replaceState;
    history.pushState = function () {
      var result = push.apply(history, arguments);
      evaluate(rules);
      return result;
    };
    history.replaceState = function () {
      var result = replace.apply(history, arguments);
      evaluate(rules);
      return result;
    };
    window.addEventListener('popstate', function () { evaluate(rules); });
  }

  fetch(RULES_URL, { cache: 'no-store' }).then(function (response) {
    return response.json();
  }).then(function (config) {
    if (!config) return;
    if (config.kill_switch) {
      console.debug('[surface-sdk] kill switch on');
      return;
    }
    var declared = Array.isArray(config.rules) ? config.rules : [];
    var rules = [];
    for (var i = 0; i < declared.length; i++) {
      if (declared[i] && declared[i].enabled) rules.push(declared[i]);
    }
    window.__kaplanSurface = { version: config.version, rendered: [] };
    return loadDismissed().then(function (map) {
      dismissed = map;
      watchNavigation(rules);
      document.addEventListener('keydown', onKeydown);
      evaluate(rules);
    });
  }).catch(function () {});
})();
