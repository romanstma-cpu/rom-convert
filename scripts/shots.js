"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/shots.ts
var import_node_child_process = require("node:child_process");
var fs = __toESM(require("node:fs"));
var os = __toESM(require("node:os"));
var path = __toESM(require("node:path"));
var PORT = 9444;
var ROOT = path.resolve(__dirname, "..");
var OUT = path.join(ROOT, "shots");
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var FFMPEG = path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe");
function ff(args) {
  return new Promise((resolve2, reject) => {
    const c = (0, import_node_child_process.spawn)(FFMPEG, ["-hide_banner", "-nostdin", "-y", ...args], {
      windowsHide: true,
      stdio: "ignore"
    });
    c.on("close", (code) => code === 0 ? resolve2() : reject(new Error(`ffmpeg exit ${code}`)));
  });
}
async function makeSamples(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    { name: "holiday-clip.mov", seconds: 90, size: "1920x1080" },
    { name: "drone-pass.mp4", seconds: 60, size: "1920x1080" },
    { name: "interview-raw.mkv", seconds: 75, size: "1280x720" }
  ];
  const made = [];
  for (const f of files) {
    const p = path.join(dir, f.name);
    await ff([
      "-f",
      "lavfi",
      "-i",
      `testsrc=duration=${f.seconds}:size=${f.size}:rate=30`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${f.seconds}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      p
    ]);
    made.push(p);
  }
  return made;
}
async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
    }
    await sleep(500);
  }
  throw new Error("no DevTools page target");
}
var Cdp = class _Cdp {
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === void 0) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  id = 0;
  pending = /* @__PURE__ */ new Map();
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("socket failed")), { once: true });
    });
    return new _Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} timed out`)), 3e4);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    return r.result.value;
  }
  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false
    });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(data, "base64"));
    console.log(`  wrote ${name} (${fs.statSync(p).size} bytes)`);
  }
  async clickText(text) {
    return this.eval(`(() => {
      const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!b) return false;
      b.click();
      return true;
    })()`);
  }
};
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sampleDir = path.join(os.tmpdir(), `rom-shots-${Date.now()}`);
  console.log("building sample media\u2026");
  const samples = await makeSamples(sampleDir);
  const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  const child = (0, import_node_child_process.spawn)(exe, [".", `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    windowsHide: true,
    stdio: "ignore"
  });
  try {
    const cdp = await Cdp.connect(await findPage());
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval(`!!document.querySelector(".fmt")`)) break;
      await sleep(400);
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1180,
      height: 800,
      deviceScaleFactor: 2,
      mobile: false
    });
    await sleep(600);
    const at = await cdp.eval(`(() => {
      const r = document.querySelector(".drop").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const data = {
      items: samples.map((s) => ({ mimeType: "text/uri-list", data: `file:///${s.replace(/\\/g, "/")}` })),
      files: samples,
      dragOperationsMask: 1
    };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await cdp.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data });
      await sleep(250);
    }
    await sleep(1200);
    await cdp.eval(`(() => {
      const card = [...document.querySelectorAll(".fmt")]
        .find(c => c.querySelector(".fmt-label").textContent.trim().startsWith("MP4 ."));
      if (card) card.click();
    })()`);
    await sleep(900);
    await cdp.shot("convert-staged.png");
    await cdp.clickText("Convert 3 files");
    await sleep(7e3);
    await cdp.eval(`(() => {
      const q = [...document.querySelectorAll(".card")].find(c => {
        const l = c.querySelector(".label");
        return l && l.textContent.trim() === "Queue";
      });
      if (q) q.scrollIntoView({ block: "end", behavior: "instant" });
    })()`);
    await sleep(900);
    await cdp.shot("convert-queue.png");
    await cdp.eval(`window.rom.queue.cancelAll()`);
    await sleep(800);
  } finally {
    child.kill();
    await sleep(600);
    fs.rmSync(sampleDir, { recursive: true, force: true });
  }
}
void main();
