import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { relay } from "../relay.mjs";

const require = createRequire(`${process.env.PLAYWRIGHT_DIR ?? process.cwd()}/`);
const { chromium } = require("playwright");
const extension = resolve(import.meta.dirname, "../extension");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "pass" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(req.url === "/two" ? "<title>Second</title>" : req.url === "/aside" ? "<title>Aside</title>" : "<title>Mine</title><button onclick=\"document.title='clicked'\">Go</button>")).listen(0, "127.0.0.1");
await new Promise((done) => site.once("listening", done));
const origin = `http://127.0.0.1:${site.address().port}`;
const r = relay();
const port = await r.listen();
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "srd-")), {
	executablePath: process.env.CHROME,
	headless: false,
	args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--window-position=-2400,0"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(`${origin}/`);

let ext;
for (let i = 0; i < 60 && !(ext = r.status().extensions[0]); i++) await sleep(250);
check("extension connects to the relay", !!ext, ext ? `${ext.name} (${ext.app})` : "");
if (!ext) process.exit(1);

const res = await fetch(`http://127.0.0.1:${port}/status`, { headers: { "x-star-driver": r.token } });
check("status needs the token", (await fetch(`http://127.0.0.1:${port}/status`)).status === 403 && res.status === 200);

const refused = await new Promise((done) => {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp/${ext.app}?t=wrong`);
	ws.onopen = () => done(false);
	ws.onerror = () => done(true);
});
check("a client without the token is refused", refused);

const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp/${ext.app}?t=${r.token}`);
await new Promise((done, fail) => ((ws.onopen = done), (ws.onerror = () => fail(new Error("relay refused the client")))));
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (event) => {
	const m = JSON.parse(event.data);
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)(m);
		pending.delete(m.id);
	} else if (m.method) events.push(m);
};
const send = (method, params = {}, sessionId) =>
	new Promise((done) => {
		const n = ++id;
		pending.set(n, done);
		ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
	});

const targets = (await send("Target.getTargets")).result?.targetInfos ?? [];
const mine = targets.find((t) => t.title === "Mine");
check("Target.getTargets lists the tab", !!mine, `${targets.length} targets`);
const { result: attached } = await send("Target.attachToTarget", { targetId: mine.targetId, flatten: true });
check("Target.attachToTarget gives a session", !!attached?.sessionId);
const s = attached.sessionId;
await send("Page.enable", {}, s);
await send("Runtime.enable", {}, s);
const evaluated = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, s);
check("Runtime.evaluate reads the page", evaluated.result?.result?.value === "Mine");
const box = (await send("Runtime.evaluate", { expression: "JSON.stringify(document.querySelector('button').getBoundingClientRect())", returnByValue: true }, s)).result.result.value;
const { x, y, width, height } = JSON.parse(box);
for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: x + width / 2, y: y + height / 2, button: "left", clickCount: 1 }, s);
check("Input.dispatchMouseEvent clicks", (await page.title()) === "clicked");
const nav = await send("Page.navigate", { url: `${origin}/two` }, s);
if (process.env.DEBUG) console.log("navigate", JSON.stringify(nav), events.map((e) => e.method).join(","));
for (let i = 0; i < 40 && !events.some((e) => e.method === "Page.loadEventFired"); i++) await sleep(100);
check("events come back with the session", events.some((e) => e.method === "Page.loadEventFired" && e.sessionId === s));
const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 50 }, s);
if (process.env.DEBUG) console.log("shot", JSON.stringify(shot).slice(0, 300));
check("Page.captureScreenshot works", (shot.result?.data ?? "").length > 1000);
const made = (await send("Target.createTarget", { url: `${origin}/aside`, newWindow: true, background: true })).result;
check("Target.createTarget opens a window", !!made?.targetId);
await sleep(500);
check("the new tab is listed", ((await send("Target.getTargets")).result.targetInfos ?? []).some((t) => t.targetId === made.targetId));
check("Target.closeTarget closes it", (await send("Target.closeTarget", { targetId: made.targetId })).result?.success === true);
const unknown = await send("Browser.crash");
check("unsupported browser methods answer an error", !!unknown.error);
ws.close();
await sleep(300);

await context.close();
r.close();
site.close();
console.log(failures.length ? `\n${failures.length} failed` : "\nall passed");
process.exit(failures.length ? 1 : 0);
