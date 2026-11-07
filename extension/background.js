const PORTS = [47820, 47821, 47822, 47823];
const IDLE_MS = 60_000;
const local = chrome.storage.local;
const sockets = new Map();
const owners = new Map();
const used = new Map();
const stats = { commands: 0, attaches: 0 };

const session = (tabId) => `tab-${tabId}`;
const tabOf = (sessionId) => Number(String(sessionId).slice(4));

function brand() {
	if (navigator.brave) return ["Brave", "brave"];
	const brands = (navigator.userAgentData?.brands ?? []).map((b) => b.brand);
	const known = [["Microsoft Edge", "msedge"], ["Opera", "opera"], ["Vivaldi", "vivaldi"], ["Thorium", "thorium"], ["Google Chrome", "chrome"], ["Chromium", "chromium"]];
	return known.find(([name]) => brands.includes(name)) ?? ["Chromium", "chromium"];
}

async function hello() {
	const [name, app] = brand();
	const { paused } = await local.get("paused");
	return { hello: { app, name, paused: !!paused, version: chrome.runtime.getManifest().version } };
}

const open = () => [...sockets.values()].filter((ws) => ws.readyState === WebSocket.OPEN);

async function badge() {
	const { paused } = await local.get("paused");
	const on = open().length > 0;
	await chrome.action.setBadgeBackgroundColor({ color: paused ? "#8a8a8a" : "#2061f5" });
	await chrome.action.setBadgeText({ text: paused ? "off" : owners.size ? "•" : "" });
	await chrome.action.setTitle({ title: paused ? "Starteammate remote-debugging: paused" : on ? "Starteammate remote-debugging: connected to Starteammate Desktop" : "Starteammate remote-debugging: waiting for Starteammate Desktop" });
}

function dial() {
	for (const port of PORTS) {
		if (sockets.has(port)) continue;
		const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
		sockets.set(port, ws);
		let beat;
		ws.onopen = async () => {
			ws.send(JSON.stringify(await hello()));
			beat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"ping":1}'), 20_000);
			badge();
		};
		ws.onmessage = (event) => {
			const message = JSON.parse(event.data);
			if (message.gone) return void drop(message.c);
			if (message.m) void handle(ws, message.c, message.m);
		};
		ws.onclose = () => {
			clearInterval(beat);
			sockets.delete(port);
			for (const c of [...new Set([...owners.values()].flatMap((set) => [...set]))]) drop(c);
			badge();
		};
	}
}

const clientsOf = (tabId) => owners.get(tabId) ?? new Set();
const post = (ws, c, m) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ c, m }));
const wsOf = new Map();

async function attach(tabId) {
	if (owners.has(tabId)) return;
	await chrome.debugger.attach({ tabId }, "1.3");
	owners.set(tabId, new Set());
	stats.attaches++;
}

async function detach(tabId, reason = "idle") {
	if (!owners.has(tabId)) return;
	const clients = clientsOf(tabId);
	owners.delete(tabId);
	used.delete(tabId);
	await chrome.debugger.detach({ tabId }).catch(() => {});
	for (const c of clients) post(wsOf.get(c), c, { method: "Target.detachedFromTarget", params: { sessionId: session(tabId), targetId: String(tabId), reason } });
	badge();
}

function drop(c) {
	wsOf.delete(c);
	for (const [tabId, clients] of owners) if (clients.delete(c) && clients.size === 0) void detach(tabId, "client_gone");
}

const info = (tab) => ({
	attached: owners.has(tab.id),
	browserContextId: "default",
	canAccessOpener: false,
	openerId: tab.openerTabId != null ? String(tab.openerTabId) : undefined,
	targetId: String(tab.id),
	title: tab.title ?? "",
	type: "page",
	url: tab.url || tab.pendingUrl || "about:blank",
});

const TARGET = {
	"Browser.getVersion": async () => ({ product: brand()[0], protocolVersion: "1.3", userAgent: navigator.userAgent, jsVersion: "", revision: "" }),
	"Target.setDiscoverTargets": async () => ({}),
	"Target.setAutoAttach": async () => ({}),
	"Target.getTargets": async () => ({ targetInfos: (await chrome.tabs.query({})).filter((tab) => tab.id != null).map(info) }),
	"Target.getTargetInfo": async ({ targetId }) => ({ targetInfo: info(await chrome.tabs.get(Number(targetId))) }),
	"Target.attachToTarget": async ({ targetId }, c) => {
		const tabId = Number(targetId);
		await attach(tabId);
		owners.get(tabId).add(c);
		used.set(tabId, Date.now());
		badge();
		return { sessionId: session(tabId) };
	},
	"Target.detachFromTarget": async ({ sessionId }, c) => {
		const tabId = tabOf(sessionId);
		const clients = clientsOf(tabId);
		clients.delete(c);
		if (!clients.size) await detach(tabId, "detached");
		return {};
	},
	"Target.createTarget": async ({ url = "about:blank", newWindow, background }) => {
		if (newWindow) {
			const front = background ? await chrome.windows.getLastFocused().catch(() => null) : null;
			const win = await chrome.windows.create({ url, focused: !background });
			if (front?.focused) await chrome.windows.update(front.id, { focused: true });
			return { targetId: String(win.tabs[0].id) };
		}
		return { targetId: String((await chrome.tabs.create({ url, active: !background })).id) };
	},
	"Target.closeTarget": async ({ targetId }) => {
		await chrome.tabs.remove(Number(targetId));
		return { success: true };
	},
	"Target.activateTarget": async ({ targetId }) => {
		const tab = await chrome.tabs.update(Number(targetId), { active: true });
		await chrome.windows.update(tab.windowId, { focused: true });
		return {};
	},
};

async function handle(ws, c, { id, method, params = {}, sessionId }) {
	wsOf.set(c, ws);
	stats.commands++;
	const reply = (body) => post(ws, c, { id, ...(sessionId ? { sessionId } : {}), ...body });
	try {
		if ((await local.get("paused")).paused) throw new Error("Starteammate remote-debugging is paused in this browser. Turn it back on from its toolbar button.");
		if (!sessionId) {
			if (!TARGET[method]) throw new Error(`${method} is not available through Starteammate remote-debugging.`);
			return reply({ result: await TARGET[method](params, c) });
		}
		const tabId = tabOf(sessionId);
		if (!owners.has(tabId)) throw new Error("That tab is no longer attached.");
		used.set(tabId, Date.now());
		reply({ result: (await chrome.debugger.sendCommand({ tabId }, method, params)) ?? {} });
	} catch (error) {
		reply({ error: { code: -32000, message: String(error?.message ?? error) } });
	}
}

chrome.debugger.onEvent.addListener((source, method, params) => {
	if (source.sessionId || source.tabId == null) return;
	for (const c of clientsOf(source.tabId)) post(wsOf.get(c), c, { method, params, sessionId: session(source.tabId) });
});

chrome.debugger.onDetach.addListener((source, reason) => {
	if (source.tabId == null || !owners.has(source.tabId)) return;
	const clients = clientsOf(source.tabId);
	owners.delete(source.tabId);
	used.delete(source.tabId);
	for (const c of clients) post(wsOf.get(c), c, { method: "Target.detachedFromTarget", params: { sessionId: session(source.tabId), targetId: String(source.tabId), reason } });
	badge();
});

setInterval(() => {
	for (const [tabId, at] of used) if (Date.now() - at > IDLE_MS) void detach(tabId);
	dial();
}, 5_000);

chrome.storage.onChanged.addListener(async (change) => {
	if (!change.paused) return;
	if (change.paused.newValue) for (const tabId of [...owners.keys()]) await detach(tabId, "paused");
	for (const ws of open()) ws.send(JSON.stringify(await hello()));
	badge();
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
	if (message !== "state") return;
	local.get("paused").then(({ paused }) => respond({ paused: !!paused, connected: open().length > 0, tabs: owners.size, name: brand()[0], ...stats }));
	return true;
});

chrome.alarms.create("dial", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(dial);
chrome.runtime.onStartup.addListener(dial);
chrome.runtime.onInstalled.addListener(dial);
dial();
badge();
