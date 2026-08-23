/**
 * Drives the real app over the DevTools protocol.
 *
 * The playtest covers logic and ffmpeg-check covers encoding, but neither
 * touches the wiring in between: an IPC handler that was never bridged, or a
 * bridge nothing calls, passes both suites and still ships broken. This walks
 * every method on window.rom and then clicks a real button to prove the event
 * path works, not just that the pixels are in the right place.
 *
 *   npm run ipccheck
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PORT = 9333;
const ROOT = path.resolve(__dirname, "..");

/** A small real video for the round-trip conversion, in its own temp folder. */
function makeSample(): Promise<string> {
  const dir = path.join(os.tmpdir(), `rom-convert-ipc-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "sample.mp4");
  const ffmpeg = path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe");

  return new Promise((resolve, reject) => {
    const c = spawn(
      ffmpeg,
      [
        "-hide_banner", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        out,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    c.on("close", (code) =>
      code === 0 && fs.existsSync(out)
        ? resolve(out)
        : reject(new Error(`could not build a sample video (exit ${code})`)),
    );
  });
}

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Target {
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function findPage(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = (await res.json()) as Target[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // devtools endpoint is not up yet
    }
    await sleep(500);
  }
  throw new Error("The app never exposed a DevTools page target.");
}

class Cdp {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  /** Evaluates an expression in the page and returns its resolved value. */
  async eval<T>(expression: string): Promise<T> {
    const res = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "eval failed",
      );
    }
    return res.result.value as T;
  }

  async click(selector: string): Promise<boolean> {
    const box = await this.eval<{ x: number; y: number } | null>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) return false;

    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
    }
    return true;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

async function main(): Promise<void> {
  console.log("\n== app IPC and UI wiring ==");

  // Point ROM_APP_EXE at release/win-unpacked/ROM Convert.exe to run this
  // whole suite against the packaged build instead of the dev tree. That is
  // the only way to catch asar problems: ffmpeg resolves fine from a loose
  // node_modules and then cannot be executed once it is inside app.asar.
  const packaged = process.env.ROM_APP_EXE;
  // The .bin/electron.cmd shim cannot be spawned without a shell on Node 20+,
  // so address the executable itself.
  const electron = packaged ?? path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  const args = packaged
    ? [`--remote-debugging-port=${PORT}`]
    : [".", `--remote-debugging-port=${PORT}`];
  console.log(`  target: ${packaged ? "packaged build" : "dev tree"}`);

  const child: ChildProcess = spawn(electron, args, {
    cwd: ROOT,
    windowsHide: true,
    stdio: "ignore",
  });

  let cdp: Cdp | null = null;
  try {
    cdp = await Cdp.connect(await findPage());
    await cdp.send("Runtime.enable");

    // Wait for React to finish its first paint.
    for (let i = 0; i < 40; i++) {
      const ready = await cdp.eval<boolean>(`!!document.querySelector(".fmt")`);
      if (ready) break;
      await sleep(400);
    }

    check("the bridge is exposed", await cdp.eval<boolean>(`typeof window.rom === "object"`));

    // --- every bridged method must exist and round-trip
    const groups: Record<string, string[]> = {
      queue: ["get", "add", "start", "cancel", "cancelAll", "remove", "clearFinished", "onState"],
      files: ["pick", "describe", "pickFolder", "reveal", "openFolder", "pathFor"],
      presets: ["list", "for"],
      settings: ["get", "set"],
      app: ["version", "dataDir", "ffmpeg"],
      update: ["get", "check", "install", "onState"],
      window: ["minimize", "maximize", "close", "isMaximized", "onMaximizeChange"],
    };
    for (const [group, methods] of Object.entries(groups)) {
      const missing = await cdp.eval<string[]>(`(() => {
        const g = window.rom[${JSON.stringify(group)}];
        if (!g) return ${JSON.stringify(methods)};
        return ${JSON.stringify(methods)}.filter((m) => typeof g[m] !== "function");
      })()`);
      check(`rom.${group} exposes every method`, missing.length === 0, missing.join(", "));
    }

    // --- handlers actually answer (a bridge with no handler rejects here)
    const version = await cdp.eval<string>(`window.rom.app.version()`);
    check("app.version answers", /^\d+\.\d+\.\d+$/.test(version), version);

    const ff = await cdp.eval<{ ok: boolean; path: string | null; error: string | null }>(
      `window.rom.app.ffmpeg()`,
    );
    check("app.ffmpeg reports a usable binary", ff.ok === true, ff.error ?? "");
    check("app.ffmpeg returns a path", typeof ff.path === "string" && ff.path.length > 0);
    check(
      "the ffmpeg it found exists on disk",
      !!ff.path && fs.existsSync(ff.path),
      ff.path ?? "no path",
    );
    if (process.env.ROM_APP_EXE) {
      // Inside app.asar the file is readable but not executable, so resolving
      // to that path would mean every conversion fails with ENOENT.
      check(
        "the packaged build uses the unpacked ffmpeg, not the one inside app.asar",
        !!ff.path && ff.path.includes("app.asar.unpacked"),
        ff.path ?? "no path",
      );
    }

    const dir = await cdp.eval<string>(`window.rom.app.dataDir()`);
    check("app.dataDir answers", typeof dir === "string" && dir.length > 0);

    const presets = await cdp.eval<{ id: string }[]>(`window.rom.presets.list()`);
    check("presets.list returns the catalogue", presets.length >= 10, `${presets.length}`);

    const forAudio = await cdp.eval<{ kind: string }[]>(`window.rom.presets.for("audio")`);
    check("presets.for filters by kind", forAudio.every((p) => p.kind !== "video"));

    const qs = await cdp.eval<{ jobs: unknown[] }>(`window.rom.queue.get()`);
    check("queue.get answers", Array.isArray(qs.jobs));

    const described = await cdp.eval<unknown[]>(
      `window.rom.files.describe(["C:\\\\definitely\\\\not\\\\real.txt"])`,
    );
    check("files.describe drops unsupported paths", described.length === 0);

    const upd = await cdp.eval<{ currentVersion: string }>(`window.rom.update.get()`);
    check("update.get answers", typeof upd.currentVersion === "string");

    const maxed = await cdp.eval<boolean>(`window.rom.window.isMaximized()`);
    check("window.isMaximized answers", typeof maxed === "boolean");

    // --- the UI event path, not just the pixels
    const before = await cdp.eval<string>(`window.rom.settings.get().then(s => s.presetId)`);
    const cards = await cdp.eval<number>(`document.querySelectorAll(".fmt").length`);
    check("format cards are rendered", cards >= 10, `${cards}`);

    // Click a card that is not the current one.
    const targetIndex = await cdp.eval<number>(`(() => {
      const cards = [...document.querySelectorAll(".fmt")];
      return cards.findIndex((c) => !c.classList.contains("on"));
    })()`);
    const clicked = await cdp.click(`.fmt:nth-of-type(${targetIndex + 1})`);
    check("a format card can be clicked", clicked);
    await sleep(700);

    const after = await cdp.eval<string>(`window.rom.settings.get().then(s => s.presetId)`);
    check("clicking a format persists the choice", after !== before, `${before} -> ${after}`);
    check(
      "the clicked card is the one now selected",
      await cdp.eval<boolean>(
        `document.querySelectorAll(".fmt")[${targetIndex}].classList.contains("on")`,
      ),
    );

    // Quality is the other control that writes settings.
    const q0 = await cdp.eval<string>(`window.rom.settings.get().then(s => s.quality)`);
    await cdp.click(`.seg button:last-child`);
    await sleep(600);
    const q1 = await cdp.eval<string>(`window.rom.settings.get().then(s => s.quality)`);
    check("quality can be changed by clicking", q1 === "high" && q1 !== q0, `${q0} -> ${q1}`);

    // Restore the defaults this test trampled.
    await cdp.eval(`window.rom.settings.set({ presetId: "mp4", quality: "balanced" })`);

    // --- the options dialog opens and closes
    await cdp.click(`.linkish`);
    await sleep(500);
    check("More options opens the dialog", await cdp.eval<boolean>(`!!document.querySelector(".modal")`));
    await cdp.click(`.modal .btn.primary`);
    await sleep(500);
    check("the dialog closes again", await cdp.eval<boolean>(`!document.querySelector(".modal")`));

    // --- dragging files in, the way almost everyone will actually use this
    //
    // Electron removed the non-standard File.path, so a drop handler can no
    // longer read where a file came from; the preload has to resolve it with
    // webUtils. That is easy to get wrong and impossible to notice in a unit
    // test, and it is the app's headline interaction, so it gets a real drop.
    {
      const dropped = await makeSample();

      const target = await cdp.eval<{ x: number; y: number }>(`(() => {
        const r = document.querySelector(".drop").getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);

      const dragData = {
        items: [{ mimeType: "text/uri-list", data: `file:///${dropped.replace(/\\/g, "/")}` }],
        files: [dropped],
        dragOperationsMask: 1,
      };
      for (const type of ["dragEnter", "dragOver", "drop"] as const) {
        await cdp.send("Input.dispatchDragEvent", { type, x: target.x, y: target.y, data: dragData });
        await sleep(200);
      }
      await sleep(1200);

      const staged = await cdp.eval<string[]>(
        `[...document.querySelectorAll(".job-name")].map(n => n.textContent.trim())`,
      );
      check(
        "a dropped file appears in the staged list",
        staged.some((n) => n.includes("sample.mp4")),
        staged.join(" | ") || "nothing staged",
      );
      check(
        "the drop resolved a real path, not an empty one",
        await cdp.eval<boolean>(
          `[...document.querySelectorAll(".job-name")].some(n => n.getAttribute("title") && n.getAttribute("title").includes("sample.mp4"))`,
        ),
      );

      // Clear it again so the conversion case below starts from a clean tray.
      const cleared = await cdp.click(`.linkish`);
      if (cleared) await sleep(400);
      await cdp.eval(`(() => {
        const btns = [...document.querySelectorAll("button")];
        const clear = btns.find(b => b.textContent.trim() === "Remove all");
        if (clear) clear.click();
      })()`);
      await sleep(400);
      fs.rmSync(path.dirname(dropped), { recursive: true, force: true });
    }

    // --- a real conversion, driven through main's own handlers
    //
    // ffmpeg-check drives ConvertQueue directly, so it never exercises the
    // queue:add handler that reads settings and decides the output folder.
    {
      const source = await makeSample();
      await cdp.eval(`window.rom.settings.set({ presetId: "mp3", outputMode: "custom", outputDir: ${JSON.stringify(
        path.dirname(source),
      )} })`);
      await cdp.eval(`window.rom.queue.add([${JSON.stringify(source)}])`);
      await cdp.eval(`window.rom.queue.start()`);

      let job: { status: string; output: string | null; outputSize: number } | null = null;
      for (let i = 0; i < 60; i++) {
        job = await cdp.eval<typeof job>(
          `window.rom.queue.get().then(s => { const j = s.jobs[0]; return j ? { status: j.status, output: j.output, outputSize: j.outputSize } : null; })`,
        );
        if (job && (job.status === "done" || job.status === "failed")) break;
        await sleep(500);
      }

      check("a conversion started from the UI finishes", job?.status === "done", job?.status ?? "no job");
      check(
        "it wrote to the folder the settings chose",
        !!job?.output && path.dirname(job.output) === path.dirname(source),
        job?.output ?? "no output",
      );
      check("the converted file has content", (job?.outputSize ?? 0) > 0);
      check(
        "the file really is on disk",
        !!job?.output && fs.existsSync(job.output),
        job?.output ?? "",
      );

      await cdp.eval(`window.rom.queue.clearFinished()`);
      await cdp.eval(`window.rom.settings.set({ outputMode: "source", outputDir: "" })`);
      fs.rmSync(path.dirname(source), { recursive: true, force: true });
    }

    // --- nothing threw into the console while all that happened
    const errors = await cdp.eval<number>(`window.__romErrors ?? 0`);
    check("no uncaught renderer errors", errors === 0, `${errors}`);
  } finally {
    cdp?.close();
    child.kill();
    await sleep(700);
  }

  console.log(`\n${"=".repeat(52)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
