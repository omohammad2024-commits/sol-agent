# `bun test` on Windows: awaiting `expect(promise)` loses child-process stdout `data` events (dependency-free repro)

> اینجا دقیقاً همان متنی است که در `oven-sh/bun` ثبت می‌شود (عنوان بالا، متن زیر). پس از ثبت، لینک‌ها به انتهای همین فایل اضافه می‌شوند.

---

### What version of Bun is running?

`1.4.2` (744846f84), x64

### What platform is your computer?

Windows 11 Pro 10.0.28000 x64

### What steps can reproduce the bug?

Save this as `repro.test.ts` (dependency-free — uses `bun:test` and `node:child_process` only) and run `bun test repro.test.ts`:

```ts
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";

const CHILD = "let n=0; process.stdin.on('data', () => { n++; setTimeout(() => process.stdout.write('resp'+n+'\\n'), 5); });";

function start() {
  const proc = spawn(process.execPath, ["-e", CHILD], { stdio: ["pipe", "pipe", "ignore"] });
  proc.on("error", () => {});
  proc.on("spawn", () => {});
  proc.on("close", () => {});
  proc.stdin!.on("error", () => {});
  proc.stdout!.on("error", () => {});
  return proc;
}

function firstResponse(proc: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((res) => proc.stdout!.once("data", (d: Buffer) => res(d.toString().trim())));
}

function secondResponse(proc: ReturnType<typeof spawn>): Promise<never> {
  return new Promise((_res, rej) => {
    const t = setTimeout(() => rej(new Error("fallback: no data event within 5s")), 5000);
    proc.stdout!.once("data", (d: Buffer) => { clearTimeout(t); rej(new Error("boom " + d.toString().trim())); });
  });
}

test("1) expect(promise).rejects: 'data' event is NOT delivered", async () => {
  const proc = start();
  const f = firstResponse(proc);
  proc.stdin!.write("req1\n");
  expect(await f).toBe("resp1");

  const p = secondResponse(proc);
  proc.stdin!.write("req2\n");
  await expect(p).rejects.toThrow("boom resp2"); // FAILS: "fallback: no data event within 5s"
  proc.kill();
}, 15000);

test("2) control: same promise, plain await -> 'data' event IS delivered", async () => {
  const proc = start();
  const f = firstResponse(proc);
  proc.stdin!.write("req1\n");
  expect(await f).toBe("resp1");

  const p = secondResponse(proc);
  proc.stdin!.write("req2\n");
  let msg = "no-reject";
  try { await p; } catch (e) { msg = (e as Error).message; }
  expect(msg).toBe("boom resp2"); // PASSES
  proc.kill();
}, 15000);
```

### What is the expected behavior?

Both tests pass. The child process writes `resp2\n` to stdout about 5 ms after `req2` is written to its stdin, so in both tests the promise `p` should reject with `boom resp2`.

### What do you see instead?

```
(fail) 1) expect(promise).rejects: 'data' event is NOT delivered [5072.44ms]
Expected substring: "boom resp2"
Received message: "fallback: no data event within 5s"
1 pass
1 fail
Ran 2 tests across 1 file. [5.18s]
```

Test 2 passes: the exact same promise settles normally when awaited with a plain `await p` inside `try/catch`. Only the `expect(...)` matcher path loses the `'data'` event. The pass/fail split is stable across many runs of this file.

### Additional information

- **The child is not at fault.** With child-side logging (the child appends each stdin message and each stdout write to a file), the log shows the child receives `req2` and writes `resp2` in the failing test as well — e.g.:

  ```
  start 14588
  got req1
  write resp1
  got req2
  write resp2        <- child wrote the reply; the parent's 'data' listener never fires
  ```

  The bytes are written by the child, but the parent's `stdout.once("data")` callback never runs while the expectation is pending (the 5 s fallback timer beats it every time).
- **Without the fallback timer, the whole test run hangs forever.** Remove the `setTimeout` from `secondResponse` and the `await expect(p)...` never settles; `bun test` does not finish, does not respect the test's own timeout, and the process has to be killed externally.
- **Real-world impact (how this was found).** With `@modelcontextprotocol/sdk` 1.32.1 and a `StdioClientTransport` (JSON-RPC over a long-lived child process, same pipe setup), `await expect(client.callTool({ name: "...", arguments: {} }))` hangs until the SDK's own 60 s request timeout (`MCP error -32001: Request timed out`) even though the server process answers in about 1 ms. Rewriting the identical call as `try { await client.callTool(...) } catch` passes immediately. This makes it impossible to assert on stdio-subprocess responses with `expect(...).resolves/.rejects` in `bun test` on this platform.
- **Extra observations from a wider matrix of variants** (same machine, same child/parent shape; the only variable is how the promise is awaited):
  - With fallback timers present: `await expect(...)` on the *first* response of a freshly spawned child passed; `await expect(...)` on the *second* response failed consistently (>=5 runs, never flipped).
  - In an earlier variant without any fallback timer, the *first*-response `await expect(...)` hung indefinitely as well.
  - A plain `await` of the very same promises passed in every variant.
  - Adding/removing auxiliary listeners (`proc.on("error"/"spawn"/"close")`, `stdin.on("error")`, `stdout.on("error")`) or using a minimal `env` did not change the behavior in a consistent direction.
- **Related issues:** #44429 is the same symptom shape over a different transport (postgres.js TCP socket on Windows; the author shows `expect(second).rejects` hangs while `await second.catch(...)` passes). #14670 is the Bun shell flavor. #19130 looks related but is a different root cause (lazy thenables whose work only starts inside `.then()`, which the expect matcher bypasses) — not this report: here the promise is a plain `new Promise` whose executor attaches the listener immediately, the request is sent, and the child writes the reply.
- I could not narrow this to a specific Bun subsystem (test-runner matcher vs. stream delivery on child-process pipes). Scope of the observation is limited to `bun test` on Windows x64 with Bun 1.4.2; I had no Linux/macOS machine available to compare.

---

## وضعیت انتشار

- [x] تأیید هویت GitHub (device code)
- [x] ثبت issue جدید در `oven-sh/bun` → **https://github.com/oven-sh/bun/issues/45473**
- [x] کامنت کراس‌لینک روی #44429 → https://github.com/oven-sh/bun/issues/44429#issuecomment-6210180101

فایل آماده‌ی ارسال (body فقط): `C:\Users\omoha\AppData\Local\Temp\opencode\bun-repro\issue-body.md`
فایل ریپروی تأییدشده: `C:\Users\omoha\AppData\Local\Temp\opencode\bun-repro\repro.test.ts`
