/**
 * Captures real screenshots of ROM Convert for the website.
 *
 * Drives the actual app over the DevTools protocol and grabs the renderer
 * directly, so what ships on the site is the running app rather than a mockup
 * — and the shots regenerate rather than going stale after a redesign.
 *
 *   npx esbuild scripts/shots.ts --bundle --platform=node --outfile=scripts/shots.js --format=cjs
 *   node scripts/shots.js
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PORT = 9444;
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "shots");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const FFMPEG = path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe");

function ff(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(FFMPEG, ["-hide_banner", "-nostdin", "-y", ...args], {
      windowsHide: true,
      stdio: "ignore",
    });
    c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
}

/** Believable-looking source files, long enough that the queue is visible. */
async function makeSamples(dir: string): Promise<string[]> {
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    { name: "holiday-clip.mov", seconds: 90, size: "1920x1080" },
    { name: "drone-pass.mp4", seconds: 60, size: "1920x1080" },
    { name: "interview-raw.mkv", seconds: 75, size: "1280x720" },
  ];
  const made: string[] = [];
  for (const f of files) {
    const p = path.join(dir, f.name);
    await ff([
      "-f", "lavfi", "-i", `testsrc=duration=${f.seconds}:size=${f.size}:rate=30`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${f.seconds}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", p,
    ]);
    made.push(p);
  }
  return made;
}

interface Target { type: string; webSocketDebuggerUrl?: string }

async function findPage(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Target[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("no DevTools page target");
}

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String((ev as MessageEvent).data)) as {
        id?: number; result?: unknown; error?: { message: string };
      };
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("socket failed")), { once: true });
    });
    return new Cdp(ws);
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} timed out`)), 30_000);
    });
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T } }>("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    return r.result.value as T;
  }
  async shot(name: string): Promise<void> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", {
      format: "png", captureBeyondViewport: false,
    });
    const p = path.join(OUT, name);
    fs.writeFileSync(p, Buffer.from(data, "base64"));
    console.log(`  wrote ${name} (${fs.statSync(p).size} bytes)`);
  }
  async clickText(text: string): Promise<boolean> {
    return this.eval<boolean>(`(() => {
      const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim().startsWith(${JSON.stringify(text)}));
      if (!b) return false;
      b.click();
      return true;
    })()`);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const sampleDir = path.join(os.tmpdir(), `rom-shots-${Date.now()}`);
  console.log("building sample media…");
  const samples = await makeSamples(sampleDir);

  const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  const child: ChildProcess = spawn(exe, [".", `--remote-debugging-port=${PORT}`], {
    cwd: ROOT, windowsHide: true, stdio: "ignore",
  });

  try {
    const cdp = await Cdp.connect(await findPage());
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    for (let i = 0; i < 40; i++) {
      if (await cdp.eval<boolean>(`!!document.querySelector(".fmt")`)) break;
      await sleep(400);
    }
    // A fixed size keeps the shots consistent between runs.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1180, height: 800, deviceScaleFactor: 2, mobile: false,
    });
    await sleep(600);

    // Drop the samples in, exactly as a person would.
    const at = await cdp.eval<{ x: number; y: number }>(`(() => {
      const r = document.querySelector(".drop").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const data = {
      items: samples.map((s) => ({ mimeType: "text/uri-list", data: `file:///${s.replace(/\\/g, "/")}` })),
      files: samples,
      dragOperationsMask: 1,
    };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await cdp.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data });
      await sleep(250);
    }
    await sleep(1200);

    // Click the card rather than writing the store directly: setting it behind
    // React's back leaves the UI showing the old choice in the screenshot.
    await cdp.eval(`(() => {
      const card = [...document.querySelectorAll(".fmt")]
        .find(c => c.querySelector(".fmt-label").textContent.trim().startsWith("MP4 ."));
      if (card) card.click();
    })()`);
    await sleep(900);
    await cdp.shot("convert-staged.png");

    // Start it, then catch the queue mid-flight where progress is visible.
    await cdp.clickText("Convert 3 files");
    await sleep(7000);
    // The queue card sits below the fold once the drop zone is back to full
    // height, and the progress bars are the whole point of the shot.
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
