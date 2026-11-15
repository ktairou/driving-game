// Loads the game (the dev server must be running: npm run dev) in a hidden
// Chrome, and reports what a tester needs: load time, console errors, frame
// costs, graphics memory by group, and screenshots from chosen spots.
//
//   node tools/check.mjs [--level low|medium|high] [--car id] [--hour 12]
//                        [--shots spots.json] [--script extra.js] [--out dir]
//                        [--url http://localhost:5173/] [--timeout 240]
//
// spots.json: [{ "name": "kingsford", "x": -560, "z": -3, "yaw": 1.57,
//                "mode": "chase" | "cam", "h": 3, "dist": 8, "ty": 1,
//                "hour": 22, "wait": 1500 }, ...]
//   chase: puts your vehicle at (x, z) facing yaw and uses the game's own camera.
//   cam:   a free camera `dist` metres from (x, z) on bearing `yaw`, `h` above
//          the ground there, looking at a point `ty` above (x, z).
// --script: a file whose text is run in the page after loading, as the body
//   of an async function with `g` = window.__game; its return value is printed.
//
// Prints one JSON report and writes it (and the PNGs) to --out
// (default tools/.cache/check).
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const LEVEL = opt("level", "medium");
const CAR = opt("car", null);
const HOUR = opt("hour", "12");
const URL0 = opt("url", "http://localhost:5173/");
const TIMEOUT = +opt("timeout", "240") * 1000;
const OUT = path.resolve(opt("out", path.join(root, "tools", ".cache", "check")));
const SHOTS = opt("shots", null);
const SCRIPT = opt("script", null);
const SOFTWARE = argv.includes("--software");
const PORT = 9333 + Math.floor(Math.random() * 400);

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });
  const profile = path.join(tmpdir(), `dg-check-${PORT}`);
  const flags = [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1024,768",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--enable-precise-memory-info",
    "--ignore-gpu-blocklist",
    ...(SOFTWARE ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : []),
    "about:blank",
  ];
  const chrome = spawn(CHROME[0], flags, { stdio: "ignore" });
  let ws;
  try {
    let pages;
    for (let i = 0; i < 60; i++) {
      try {
        pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        if (pages.some((p) => p.type === "page")) break;
      } catch {}
      await sleep(250);
    }
    const page = pages.find((p) => p.type === "page");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    let id = 0;
    const waiting = new Map();
    const errors = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) {
        waiting.get(m.id)(m);
        waiting.delete(m.id);
      } else if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        errors.push(`exception: ${d.exception?.description ?? d.text}`.slice(0, 600));
      } else if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning" && /couldn|failed/i.test(JSON.stringify(m.params.args)))) {
        errors.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 600));
      } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
        errors.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ""}`.slice(0, 600));
      }
    };
    const send = (method, params = {}) =>
      new Promise((r) => {
        const mid = ++id;
        waiting.set(mid, r);
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    const evaluate = async (expression, timeout = TIMEOUT) => {
      const res = await Promise.race([
        send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout }),
        sleep(timeout + 5000).then(() => ({ result: { result: { value: "__timeout__" } } })),
      ]);
      if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
      return res.result?.result?.value;
    };
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });

    // Settings first (same origin), then a fresh load.
    await send("Page.navigate", { url: URL0 });
    await sleep(1500);
    await evaluate(`(() => {
      const key = "drivingGame.settings.v1";
      let s = {}; try { s = JSON.parse(localStorage.getItem(key) || "{}"); } catch {}
      s.graphics = ${JSON.stringify(LEVEL)}; s.hour = ${+HOUR}; s.kmhSwitched = true;
      ${CAR ? `s.car = ${JSON.stringify(CAR)};` : ""}
      localStorage.setItem(key, JSON.stringify(s));
      return true; })()`);
    errors.length = 0;
    const t0 = Date.now();
    await send("Page.reload", { ignoreCache: true });
    const loaded = await evaluate(`(async () => {
      for (let i = 0; i < ${Math.round(TIMEOUT / 250)}; i++) { if (window.__game && window.__game.traffic) return true; await new Promise(r => setTimeout(r, 250)); }
      return false; })()`);
    const loadMs = Date.now() - t0;
    const report = { level: LEVEL, car: CAR, loaded, loadMs, errors };
    if (!loaded) {
      report.page = await evaluate(`document.body.innerText.slice(0, 400)`).catch(() => null);
      return finish(report);
    }
    await sleep(3000);
    const stats = await evaluate(`(async () => {
      const g = window.__game;
      const gl = g.engine._gl; const px = new Uint8Array(4);
      g.daynight.hour = ${+HOUR}; g.daynight.update(0);
      let t = performance.now(); g.step(60); const msTick = (performance.now() - t) / 60;
      for (let i = 0; i < 3; i++) g.scene.render();
      t = performance.now(); for (let i = 0; i < 10; i++) { g.scene.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
      const msRender = (performance.now() - t) / 10;
      const seen = new Set(); let total = 0; const groups = {};
      for (const tex of g.scene.textures) {
        const it = tex.getInternalTexture && tex.getInternalTexture(); if (!it || seen.has(it)) continue; seen.add(it);
        const faces = it.isCube ? 6 : 1;
        const bpp = it._compression ? 1 : (it.type === 1 || it.type === 2 ? 16 : 4);
        const mb = it.width * it.height * bpp * faces * (it.generateMipMaps ? 1.33 : 1) / 1e6;
        total += mb;
        const u = String(it.url || tex.url || tex.name || "");
        const m = u.match(/assets\\/(landmarks|vehicles|car|people|textures|sky)\\b/);
        const k = m ? m[1] : /shadow/i.test(tex.name) ? "shadow" : "drawn-in-code";
        groups[k] = (groups[k] || 0) + mb;
      }
      for (const k in groups) groups[k] = Math.round(groups[k]);
      let tris = 0; for (const mesh of g.scene.getActiveMeshes().data) { const n = mesh.getTotalIndices ? mesh.getTotalIndices() : 0; tris += (n / 3) * Math.max(1, mesh.thinInstanceCount || 0); }
      return {
        msTick: +msTick.toFixed(2), msRender: +msRender.toFixed(1), textures: seen.size, textureMB: Math.round(total), groups,
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
        activeMeshes: g.scene.getActiveMeshes().length, activeTris: Math.round(tris),
        traffic: g.traffic.types.map(t => t.id).length, stations: g.stations.length,
        webgl: g.engine.webGLVersion,
      };
    })()`);
    Object.assign(report, stats);

    if (SCRIPT) {
      const body = await readFile(SCRIPT, "utf8");
      report.script = await evaluate(`(async (g) => { ${body} })(window.__game)`).catch((e) => `script error: ${e.message}`);
    }

    if (SHOTS) {
      const spots = JSON.parse(await readFile(SHOTS, "utf8"));
      report.shots = [];
      for (const s of spots) {
        const file = path.join(OUT, `${s.name}.png`);
        const url = await evaluate(`(async () => {
          const g = window.__game; const s = ${JSON.stringify(s)};
          if (s.hour !== undefined) { g.daynight.hour = s.hour; g.daynight.update(0); }
          const cam = g.chase.camera; const V = cam.position.constructor;
          if (!g.__realChase) g.__realChase = g.chase.update.bind(g.chase);
          if (s.mode === "cam") {
            g.chase.update = () => {};
            const gy = Math.max(g.world.getHeight(s.x, s.z), 0);
            const set = () => { cam.position.set(s.x + Math.sin(s.yaw || 0) * (s.dist ?? 20), gy + (s.h ?? 5), s.z + Math.cos(s.yaw || 0) * (s.dist ?? 20)); cam.setTarget(new V(s.x, gy + (s.ty ?? 1), s.z)); };
            set(); g.traffic.update(0, null, cam); g.landmarkModels.update(s.x, s.z);
            await new Promise(r => setTimeout(r, s.wait ?? 2500)); set(); g.traffic.update(0, null, cam);
          } else {
            g.chase.update = g.__realChase;
            g.vehicle.place(s.x, s.z, s.yaw || 0);
            if (s.view) while (g.chase.modeName !== s.view) g.chase.cycle();
            g.chase._first = true; g.landmarkModels.update(s.x, s.z); g.step(20);
            await new Promise(r => setTimeout(r, s.wait ?? 2500)); g.step(2);
          }
          g.scene.render();
          return g.engine.getRenderingCanvas().toDataURL("image/png");
        })()`);
        if (typeof url === "string" && url.startsWith("data:image/png")) {
          await writeFile(file, Buffer.from(url.split(",")[1], "base64"));
          report.shots.push(file);
        } else report.shots.push(`${s.name}: failed (${String(url).slice(0, 80)})`);
      }
    }
    return finish(report);
  } finally {
    try {
      ws?.close();
    } catch {}
    chrome.kill();
    await sleep(500);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function finish(report) {
  const text = JSON.stringify(report, null, 1);
  await writeFile(path.join(OUT, "report.json"), text);
  console.log(text);
}

main().catch((e) => {
  console.error("check failed:", e);
  process.exit(1);
});
