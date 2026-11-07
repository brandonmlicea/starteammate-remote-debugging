const $ = (id) => document.getElementById(id);

async function show() {
	const s = await chrome.runtime.sendMessage("state");
	$("state").textContent = s.paused ? "Paused." : s.connected ? "Connected to Starteammate Desktop." : "Waiting for Starteammate Desktop.";
	$("on").checked = !s.paused;
	$("counts").textContent = `${s.name} · ${s.tabs} tab${s.tabs === 1 ? "" : "s"} in use · ${s.commands} commands this session`;
}

$("on").addEventListener("change", (e) => chrome.storage.local.set({ paused: !e.target.checked }).then(show));
show();
setInterval(show, 1000);
