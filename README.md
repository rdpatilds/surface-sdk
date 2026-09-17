# surface-sdk

Elijah's MVP tooltip engine for Canvas. A JSON file on a CDN lists the rules. A client SDK loaded
as Canvas Theme JavaScript reads that file, matches the current URL, waits for the element to
appear, renders a tooltip in a Shadow DOM host positioned by Floating UI, and records a dismissal
in the learner's Canvas custom data. No Canvas code changes, no plugin, no LTI launch.

The whole engine is one browser script with no runtime dependencies beyond the two Floating UI UMD
builds that ship inside the bundle.

```
src/surface-sdk.js   the client SDK
rules.json           the source of truth, copied to the CDN by the build
build.py             validates rules.json and writes the bundle
```

## The rule schema

`rules.json` has three top-level fields. `version` is an int and the build puts it in the bundled
rules URL as `?v=<version>`. `kill_switch` is a bool and a true value stops the SDK before it reads
any rule. `rules` is the list.

| Field | Type | What it does |
| --- | --- | --- |
| `id` | string | Identifies the rule. Lowercase letters, digits and hyphens only. It becomes the host element id, the `data-surface-rule` attribute, and the key under `dismissed`. |
| `version` | int | The rule's own version. Bump it when you change the content. |
| `enabled` | bool | A false value makes the SDK ignore the rule. |
| `url_pattern` | string | A glob matched against `location.pathname`. `*` matches any characters, including `/`. Both ends are anchored. |
| `element_selector` | string | The CSS selector for the anchor element. |
| `content` | string | The tooltip text. It is written with `textContent`, so markup in it is shown, not parsed. |
| `placement` | string | One of `top`, `bottom`, `left`, `right`. Floating UI flips it when there is no room. |
| `audience.roles` | array | Every role listed must be in `ENV.current_user_roles`. |
| `audience.course_code_prefix` | string | Optional. The learner must hold an active student or teacher enrollment in a course whose code starts with this prefix. |
| `dismissible` | bool | A true value adds the Dismiss button and lets Escape close the tooltip. |

A rule that fails any gate is skipped in silence. A rule whose id is already in the learner's
`dismissed` map never renders again.

## How to add a rule

1. Add the rule object to `rules.json`.
2. Bump the top-level `version`.
3. Run `python build.py`, or `uv run build.py`.
4. Reload the Canvas page.

The build writes `rules.json` and `kaplan-theme.js` into the directory the static server already
serves, so the server picks both up with no restart. The theme does not need to be re-applied. Canvas
stores one Theme JS URL and that URL does not change when the file behind it changes. Re-apply the
theme only when you move the bundle to a different URL.

`build.py` rejects a rule file it does not understand before it writes anything. It checks the types
of every field, the placement value, the id spelling, and duplicate ids, then prints every problem it
found rather than stopping at the first. A rule file that reaches the browser has already been
validated, so the SDK trusts it.

Use `--rules-base` to point the bundled rules URL somewhere other than `http://localhost:3101`, and
`--out-dir` to write somewhere other than the local theme directory.

## The selectors, and why these

Canvas gives some elements stable ids and generates others from a CSS-in-JS build. Anything matching
`css-*` is generated. Those names change when Instructure rebuilds the front end, so a rule built on
one breaks on an upgrade with no warning.

| Rule | Selector | Why |
| --- | --- | --- |
| `modules-nav` | `#modules-link` | Canvas builds course navigation ids from the tab name. The id is stable across releases. |
| `performance-dashboard-nav` | `#context_external_tool_6-link` | Canvas builds an external tool's nav id from its tool id. The 6 is the Performance Dashboard tool in this instance and it changes per install. |
| `assignment-submit` | `button.submit_assignment_link` | The submit button carries no id and no `data-testid`. `submit_assignment_link` is a long-lived semantic Canvas class that the submission JavaScript itself binds to, so it is as stable as an id. |

The order of preference is an id first, a semantic class second, and a generated class never.

## How the bundle is registered

A Canvas account holds exactly one Theme JS URL. Every script the account wants has to live in that
one file. `build.py` therefore concatenates four parts into `kaplan-theme.js`:

1. `nudges.js`, the existing dashboard sidebar block.
2. The `@floating-ui/core` UMD build.
3. The `@floating-ui/dom` UMD build.
4. `src/surface-sdk.js`, with `__RULES_URL__` replaced by the real rules URL.

The parts are joined with a newline, a semicolon and a newline, so a part with no trailing semicolon
cannot merge its last statement into the next part.

The two Floating UI parts are each wrapped in `(function(){var define,exports,module; ... })()`. A
UMD build checks for an AMD loader first, and a Canvas page can carry one. Without the wrapper the
build would register as an anonymous AMD module and never set `window.FloatingUIDOM`, which leaves
the SDK unable to position anything.

Point Canvas at the bundle:

```
cd D:\Canvas\test\canvas\cplatform\nudges
python apply_theme.py --js-url http://localhost:3101/kaplan-theme.js
```

Serve the theme folder with `serve.py`, not Python's plain `http.server`. The page on port 3100 fetches `rules.json` from port 3101, which is a cross-origin request, and only `serve.py` adds `Access-Control-Allow-Origin` (a real CDN does the same). Run it in its own terminal:

```
uv run serve.py --directory D:/Canvas/test/canvas/cplatform/nudges/theme --port 3101
```

## What a hosted Canvas account needs

Upload `kaplan-theme.js` through the Theme Editor, or host it on a CDN and give the Theme Editor that
URL. Either works. A CDN is better because a rules change then ships without touching Canvas at all.

Host `rules.json` on a CDN as well. Two settings on the account matter.

If the account has Content Security Policy enabled, add the CDN domain to the allowed domains list.
The SDK fetches `rules.json` at runtime and CSP blocks the request otherwise.

The CDN must send `Access-Control-Allow-Origin` for the Canvas origin. The page runs on the Canvas
domain and `rules.json` lives on the CDN domain, so that fetch is cross-origin and the browser
requires the header. `serve.py` sends it locally, standing in for a real CDN.

## The CSRF note

Canvas accepts a same-origin request that carries an `X-CSRF-Token` header equal to the URL-decoded
value of the `_csrf_token` cookie. The SDK reads that cookie and sends the header on the dismiss
`PUT`, which is why a learner can write their own custom data straight from the page. An API token
would also pass the check, but a browser page has no token and should never be given one, so the
cookie is the right source.

## What the SDK does at runtime

It fetches the rules with `cache: 'no-store'` and stops if `kill_switch` is true. It reads
`/api/v1/users/self/custom_data/surface?ns=kaplan` once to learn which ids the learner already
dismissed, and treats the 400 Canvas returns before anything is stored as an empty map. It fetches
the learner's active courses at most once per page load, and only if a rule that already passed the
URL and role gates asks for a course code prefix.

One `MutationObserver` on `document.body` serves every waiting rule. Canvas mounts much of its UI
after load, so a rule whose element is not there yet keeps waiting. After ten seconds the SDK logs
`[surface-sdk] no element for rule <id>: <selector>` once and keeps watching.

Canvas navigates without a full page load in places, so the SDK wraps `history.pushState` and
`history.replaceState` and listens for `popstate`. On each of those it removes the tooltips whose
rules no longer match the path and starts waiting for the ones that now do.

Each tooltip lives in its own Shadow DOM host, so Canvas CSS cannot reach the tooltip and the
tooltip's CSS cannot reach Canvas. The text is set with `textContent` and the file contains no
`innerHTML`.

`window.__kaplanSurface` is the only global. It holds the rules version and the list of rule ids that
have rendered, for tests to read.

## Known limits

Two nav rules anchored to adjacent course-navigation links overlap on the course pages, and the lower tooltip covers the upper one's Dismiss button. The engine renders every matching rule; a per-page priority with one tooltip at a time is the next step.


The course code prefix gate asks whether the learner holds an active SAT enrollment, not whether the
course they are looking at is an SAT course. A learner enrolled in both SAT-101 and a biology course
sees the SAT tooltips on the biology course pages too. Narrowing the gate to the current course means
reading `ENV.COURSE_ID` and matching it against the courses response. The Nudges block has the same
behaviour and the MVP keeps them the same.

Escape dismisses the tooltip that holds focus, and the most recently rendered one when none does.
Rendering is in rule order, so with several tooltips on a page the reader has to tab to the one they
mean before pressing Escape.

A rule id is a plain object key in the SDK, which is why `build.py` restricts it to lowercase
letters, digits and hyphens rather than letting the client defend itself.
