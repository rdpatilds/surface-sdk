import { chromium } from "playwright";

const BASE_URL = (process.env.CANVAS_URL || "http://localhost:3100").replace(/\/$/, "");
const TIMEOUT_MS = 120000;
const SETTLE_MS = 12000;

function parseArgs(argv) {
  const args = { expect: [], absent: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--login") args.login = argv[++i];
    else if (flag === "--password") args.password = argv[++i];
    else if (flag === "--url") args.url = argv[++i];
    else if (flag === "--expect") args.expect.push(argv[++i]);
    else if (flag === "--absent") args.absent.push(argv[++i]);
    else if (flag === "--none") args.none = true;
    else if (flag === "--dismiss") args.dismiss = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else throw new Error("unrecognized argument: " + flag);
  }
  if (!args.login || !args.password || !args.url || !args.out) throw new Error("--login, --password, --url, --out required; --expect <rule id> repeatable, --absent <rule id>, --none, --dismiss <rule id>");
  return args;
}

async function logIn(page, login, password) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(`${BASE_URL}/login/canvas`, { waitUntil: "domcontentloaded" });
    if (await page.$("#pseudonym_session_unique_id")) break;
  }
  await page.fill("#pseudonym_session_unique_id", login);
  await page.fill("#pseudonym_session_password", password);
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), page.click("#login_form input[type='submit']")]);
}

function shadowText(page, ruleId) {
  return page.evaluate((id) => {
    const host = document.getElementById("kaplan-surface-" + id);
    if (!host || !host.shadowRoot) return null;
    const tip = host.shadowRoot.querySelector('[role="tooltip"]');
    return tip ? tip.textContent.replace(/\s+/g, " ").trim() : "";
  }, ruleId);
}

// The SDK runs rules, custom_data and courses fetches in series on a Canvas that answers in
// about 6 seconds each, so wait for the expected hosts rather than a fixed pause.
async function settle(page, expectedIds) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((ids) => ids.every((id) => !!document.getElementById("kaplan-surface-" + id)), expectedIds);
    if (ready && expectedIds.length) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(expectedIds.length ? 1500 : SETTLE_MS);
}

const checks = [];
const record = (name, ok, detail) => { checks.push({ name, ok, detail }); };

const args = parseArgs(process.argv.slice(2));
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.setDefaultTimeout(TIMEOUT_MS);
const logs = [];
page.on("console", (m) => { if (m.text().includes("[surface-sdk]")) logs.push(m.text()); });
await logIn(page, args.login, args.password);
await page.goto(`${BASE_URL}${args.url}`, { waitUntil: "domcontentloaded" });
await settle(page, args.expect);

for (const id of args.expect) {
  const text = await shadowText(page, id);
  record(`tooltip ${id}`, !!text, text ? `shadow root text: ${text}` : "no shadow host");
}
for (const id of args.absent) {
  const text = await shadowText(page, id);
  record(`absent ${id}`, text === null, text === null ? "no host" : `present: ${text}`);
}
if (args.none) {
  const hosts = await page.$$eval("[data-surface-rule]", (els) => els.map((e) => e.getAttribute("data-surface-rule")));
  record("no tooltips at all", hosts.length === 0, hosts.length ? `hosts: ${hosts.join(",")}` : "zero hosts");
}
await page.screenshot({ path: args.out, fullPage: false });
record("screenshot", true, args.out);

if (args.dismiss) {
  const responsePromise = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/custom_data/surface"), { timeout: TIMEOUT_MS });
  const clicked = await page.evaluate((id) => {
    const host = document.getElementById("kaplan-surface-" + id);
    const button = host && host.shadowRoot && host.shadowRoot.querySelector("button");
    if (!button) return false;
    button.click();
    return true;
  }, args.dismiss);
  record("dismiss click", clicked, clicked ? "clicked the shadow Dismiss button" : "no dismiss button");
  const response = await responsePromise;
  const request = response.request();
  const headers = await request.allHeaders();
  const csrf = headers["x-csrf-token"];
  record("dismiss PUT", response.status() >= 200 && response.status() < 300,
    `${request.method()} ${new URL(request.url()).pathname}${new URL(request.url()).search} status=${response.status()} x-csrf-token=${csrf ? "present (" + csrf.length + " chars)" : "MISSING"}`);
  await page.waitForTimeout(1500);
  const gone = await shadowText(page, args.dismiss);
  record("tooltip removed after dismiss", gone === null, gone === null ? "host removed" : "still present");
  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(page, args.expect.filter((id) => id !== args.dismiss));
  const afterReload = await shadowText(page, args.dismiss);
  record("absent after reload", afterReload === null, afterReload === null ? "not rendered" : `rendered: ${afterReload}`);
  await page.screenshot({ path: args.out.replace(/\.png$/, "") + "-after-dismiss.png", fullPage: false });
}

for (const line of logs) console.log("console:", line);
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}  ${c.detail}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed, ${failed} failed`);
await browser.close();
process.exit(failed ? 1 : 0);
