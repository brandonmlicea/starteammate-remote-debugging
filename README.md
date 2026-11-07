# Starteammate remote-debugging

A Chromium extension that lets [Starteammate Desktop](https://starteammate.com) work in the tabs of your own browser, with your sign-ins, without Chrome's **"Allow remote debugging?"** prompt.

Recent versions of Chrome only let a program drive your everyday profile after you turn on *Allow remote debugging for this browser instance* at `chrome://inspect/#remote-debugging`, and then they ask you to click **Allow** for every new connection. This extension replaces that path. It speaks the Chrome DevTools Protocol through the extension `chrome.debugger` API instead, which needs no flag, no port on the browser and no prompt.

```
Starteammate's browser driver ──CDP── ws://127.0.0.1:47820/cdp/<browser>?t=<token> ── relay ── ws://127.0.0.1:47820/extension ── extension ── chrome.debugger ── your tab
```

## Install

Works in Chrome, Edge, Brave, Opera, Vivaldi, Thorium and Chromium, version 125 or newer.

1. Download this repository (**Code → Download ZIP**, then unzip it) or clone it.
2. Open `chrome://extensions` (`edge://extensions` in Edge), turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder.
3. Keep Starteammate Desktop running. The extension's toolbar button says **Connected to Starteammate Desktop** within a few seconds.

Do it once in each browser and profile you want Starteammate to use. The toolbar switch pauses it at any time.

While Starteammate works in a tab, Chrome shows its standard bar: *"Starteammate remote-debugging started debugging this browser"*. The extension lets go of a tab after a minute without work, and the bar goes away.

## How it works

- **The relay** (`relay.mjs`, no dependencies, Node 20 or newer) listens on the first free port from 47820 to 47823, on `127.0.0.1` only. Starteammate Desktop runs it for you. To run it yourself, use `node relay.mjs`. It prints the address for CDP clients.
  - `/extension` accepts only the extension's own origin, `chrome-extension://cdihkdjlidbcoboapfhoelhkeiniffko`, which the `key` in its manifest fixes. A web page cannot connect.
  - `/cdp/<app>?t=<token>` accepts a CDP client that holds the relay's random token. `<app>` is the browser: `chrome`, `msedge`, `brave`, `opera`, `vivaldi`, `thorium` or `chromium`. Requests that carry a web page's `Origin` header are refused.
  - `/status` lists the connected browsers. It needs the token in an `x-star-driver` header.
- **The extension** dials those ports, sends a heartbeat every 20 seconds and answers browser-level CDP for tabs:
  - `Target.getTargets`, `attachToTarget`, `detachFromTarget`, `createTarget` (in the background, without taking focus), `closeTarget`, `activateTarget` and `getTargetInfo`, plus `Browser.getVersion`.
  - Session commands (`Page`, `Runtime`, `Input`, `DOM`, `Network`, `Emulation` and the rest) go straight to `chrome.debugger.sendCommand`, and their events come back on the same session.
  - The page's own protocol does the work, so a client written for a normal CDP socket runs unchanged. Starteammate's driver does.
- **Nothing leaves your computer.** There is no account, no server and no analytics.

## Test

```sh
CHROME=/path/to/chromium PLAYWRIGHT_DIR=/path/to/node_modules node test/e2e.mjs
```

The test loads the extension into Chromium with Playwright, starts a relay, connects a raw CDP client and checks each step:

- listing, attaching, evaluating, clicking, navigating, page events and screenshots
- opening and closing a background window
- refusing a client without the token
- refusing unsupported methods

## License

MIT
