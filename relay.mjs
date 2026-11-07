#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const PORTS = [47820, 47821, 47822, 47823];
export const EXTENSION_ID = process.env.STARTEAMMATE_REMOTE_DEBUGGING_ID || "cdihkdjlidbcoboapfhoelhkeiniffko";

function frame(text, op = 1) {
	const payload = Buffer.from(text);
	const n = payload.length;
	const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
	if (n >= 126) {
		head[0] = 0x80 | op;
		head[1] = n < 65536 ? 126 : 127;
		n < 65536 ? head.writeUInt16BE(n, 2) : head.writeBigUInt64BE(BigInt(n), 2);
	}
	return Buffer.concat([head, payload]);
}

function frames(socket, onText) {
	let buf = Buffer.alloc(0);
	let parts = [];
	socket.on("data", (chunk) => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
		for (;;) {
			if (buf.length < 2) return;
			let len = buf[1] & 127;
			let at = 2;
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				at = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				len = Number(buf.readBigUInt64BE(2));
				at = 10;
			}
			const masked = buf[1] & 128;
			if (buf.length < at + (masked ? 4 : 0) + len) return;
			const mask = masked ? buf.subarray(at, at + 4) : null;
			if (masked) at += 4;
			const op = buf[0] & 15;
			const fin = buf[0] & 128;
			const data = Buffer.from(buf.subarray(at, at + len));
			if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
			buf = buf.subarray(at + len);
			if (op === 8) return void socket.end(frame("", 8));
			if (op === 9) socket.write(frame(data, 10));
			if (op > 2) continue;
			parts.push(data);
			if (fin) {
				onText(Buffer.concat(parts).toString("utf8"));
				parts = [];
			}
		}
	});
}

export function relay({ token = randomBytes(16).toString("hex"), log = () => {} } = {}) {
	const extensions = new Map();
	const clients = new Map();
	let seq = 0;
	const send = (socket, text) => !socket.destroyed && socket.write(frame(text));

	const fromExtension = (ext, socket) => {
		frames(socket, (text) => {
			let m;
			try {
				m = JSON.parse(text);
			} catch {
				return;
			}
			if (m.hello) {
				Object.assign(ext, { app: String(m.hello.app ?? ""), name: String(m.hello.name ?? ""), version: String(m.hello.version ?? ""), paused: !!m.hello.paused });
				extensions.set(ext.id, ext);
				log(`extension ${ext.name} (${ext.app}) connected`);
				return;
			}
			if (m.c != null && m.m) {
				const client = clients.get(m.c);
				if (client) send(client.socket, JSON.stringify(m.m));
			}
		});
		socket.on("close", () => {
			extensions.delete(ext.id);
			for (const client of clients.values()) if (client.ext === ext) client.socket.end(frame("", 8));
			log(`extension ${ext.name || ext.id} left`);
		});
	};

	const fromClient = (client, socket) => {
		frames(socket, (text) => send(client.ext.socket, `{"c":${client.id},"m":${text}}`));
		socket.on("close", () => {
			clients.delete(client.id);
			send(client.ext.socket, `{"c":${client.id},"gone":true}`);
		});
	};

	const pick = (app) => [...extensions.values()].filter((ext) => !ext.paused && (!app || ext.app === app)).sort((a, b) => b.at - a.at)[0];

	const status = () => ({ extensions: [...extensions.values()].map(({ app, name, version, paused }) => ({ app, name, version, paused })) });

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const allowed = req.headers["x-star-driver"] === token || url.searchParams.get("t") === token;
		if (url.pathname === "/status" && allowed && !req.headers.origin) {
			const body = JSON.stringify(status());
			res.writeHead(200, { "content-length": Buffer.byteLength(body), "content-type": "application/json" }).end(body);
			return;
		}
		res.writeHead(allowed ? 404 : 403).end();
	});

	server.on("upgrade", (req, socket) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
		const origin = req.headers.origin;
		const refuse = (code) => socket.end(`HTTP/1.1 ${code}\r\n\r\n`);
		if (!["127.0.0.1", "localhost"].includes(host)) return refuse("403 Forbidden");
		const isExtension = url.pathname === "/extension" && origin === `chrome-extension://${EXTENSION_ID}`;
		const app = url.pathname.startsWith("/cdp/") ? decodeURIComponent(url.pathname.slice(5)) : null;
		const isClient = app !== null && !origin && url.searchParams.get("t") === token;
		if (!isExtension && !isClient) return refuse("403 Forbidden");
		const ext = isClient ? pick(app) : null;
		if (isClient && !ext) return refuse("404 Not Found");
		const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
		socket.setNoDelay(true);
		socket.on("error", () => {});
		const id = ++seq;
		if (isExtension) fromExtension({ id, socket, at: Date.now(), app: "", name: "", version: "", paused: false }, socket);
		else {
			const client = { id, socket, ext };
			clients.set(id, client);
			fromClient(client, socket);
		}
	});

	const listen = () =>
		new Promise((resolve, reject) => {
			const tryPort = (i) => {
				if (i >= PORTS.length) return reject(new Error(`Ports ${PORTS[0]} to ${PORTS.at(-1)} are all in use.`));
				server.once("error", () => tryPort(i + 1));
				server.listen(PORTS[i], "127.0.0.1", () => resolve(PORTS[i]));
			};
			tryPort(0);
		});

	return { listen, status, token, close: () => server.close() };
}

const arg = (name) => {
	const at = process.argv.indexOf(`--${name}`);
	return at > 0 ? process.argv[at + 1] : undefined;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const state = arg("state");
	const parent = Number(arg("parent") ?? 0);
	const r = relay({ log: (line) => !state && console.log(line) });
	const port = await r.listen();
	if (state) writeFileSync(state, JSON.stringify({ port, token: r.token, pid: process.pid }));
	else console.log(`Starteammate remote-debugging relay on 127.0.0.1:${port}\nCDP clients: ws://127.0.0.1:${port}/cdp/<app>?t=${r.token}`);
	const quit = () => {
		if (state) rmSync(state, { force: true });
		process.exit(0);
	};
	if (parent)
		setInterval(() => {
			try {
				process.kill(parent, 0);
			} catch {
				quit();
			}
		}, 3000);
	process.on("SIGINT", quit);
	process.on("SIGTERM", quit);
}
