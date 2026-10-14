import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config";
import type { Tool, ToolContext } from "../types";
import { rid, truncate } from "../util";

interface ExecResult { output: string; exitCode: number | null; timedOut: boolean }

function collect(child: ReturnType<typeof spawn>, timeoutMs: number, onTimeout: () => void): Promise<ExecResult> {
  return new Promise((resolve) => {
    let out = "";
    const cap = 200_000;
    const add = (d: Buffer) => { if (out.length < cap) out += d.toString("utf8"); };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; onTimeout(); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(t); resolve({ output: out + `\n[spawn error: ${e.message}]`, exitCode: null, timedOut }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ output: out, exitCode: code, timedOut }); });
  });
}

/** Run a command line inside the sandbox (docker) or as a stripped-env local process. */
export async function execSandboxed(config: Config, ctx: ToolContext, script: string, timeoutMs = config.EXEC_TIMEOUT_MS): Promise<ExecResult> {
  if (config.SANDBOX_MODE === "off") throw new Error("Code execution is disabled (SANDBOX_MODE=off)");
  fs.mkdirSync(ctx.workdir, { recursive: true });
  if (config.SANDBOX_MODE === "docker") {
    const name = `sol-exec-${rid(5)}`;
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const args = [
      "run", "--rm", "--name", name,
      "--network", config.SANDBOX_NETWORK ? "bridge" : "none",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "256",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `${uid}:${gid}`, "-e", "HOME=/work",
      "-v", `${ctx.workdir}:/work`, "-w", "/work",
      config.SANDBOX_IMAGE!, "bash", "-lc", script,
    ];
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    return collect(child, timeoutMs, () => { spawn("docker", ["kill", name], { stdio: "ignore" }).on("error", () => {}); child.kill("SIGKILL"); });
  }
  // local mode: no env inheritance, so API keys / bot token are not visible to the child.
  const child = spawn("bash", ["-lc", script], {
    cwd: ctx.workdir,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: ctx.workdir, LANG: "C.UTF-8", TMPDIR: ctx.workdir },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  return collect(child, timeoutMs, () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } });
}

const DANGEROUS: [RegExp, string][] = [
  [/\brm\s+(?:-[a-zA-Z-]*\s+)*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\s+(?:-[^\s]*\s+)*(?:--no-preserve-root\s+)?(?:\/\*?|~\/?|\$HOME\/?|\.\.\/?\*?)(?=[\s"';)|&]|$)/, "recursive delete of / , ~ or parent directory"],
  [/:\(\)\s*\{[^}]*\|[^}]*&/, "fork bomb"],
  [/\bmkfs(\.\w+)?\b/, "formatting a filesystem"],
  [/\bdd\b[^\n]*\bof=\/dev\//, "writing to a block device"],
  [/>\s*\/dev\/(sd|nvme|vd|hd)/, "writing to a block device"],
  [/\b(shutdown|reboot|poweroff|halt)\b/, "shutting the machine down"],
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, "piping a download into a shell"],
  [/\/dev\/tcp\//, "reverse shell"],
  [/\bnc(at)?\b[^\n]*\s-e\b/, "reverse shell"],
  [/\b(xmrig|minerd|cpuminer|stratum\+tcp)\b/i, "crypto mining"],
  [/\/proc\/(self|\d+)\/environ/, "reading process environment"],
  [/(^|[\s"'\/])\.env\b/, "reading .env files"],
  [/sol\.db/, "touching the bot database"],
  [/\bchmod\s+-R\s+[0-7]*7\s+\//, "recursive chmod on /"],
];

/** Heuristic last line of defence (NOT a security boundary - the sandbox is). Returns a reason or null. */
export function checkDangerous(text: string): string | null {
  for (const [re, why] of DANGEROUS) if (re.test(text)) return why;
  return null;
}

function format(r: ExecResult): string {
  const head = r.timedOut ? "[timed out and was killed]\n" : "";
  return `${head}${truncate(r.output.trim() || "(no output)", 8000)}\n[exit code: ${r.exitCode}]`;
}

const enabled = (c: Config) => c.SANDBOX_MODE !== "off";

export const runShell: Tool = {
  name: "run_shell",
  description: "Run a shell command (bash) in the sandboxed workspace. Output is truncated. Admin only.",
  level: "admin",
  enabled,
  risky: true,
  untrusted: true,
  parameters: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "integer", description: "default 30, max 300" } }, required: ["command"] },
  async run({ command, timeout_seconds }, ctx) {
    const ms = Math.min(Math.max(timeout_seconds ?? 30, 1), 300) * 1000;
    const why = checkDangerous(command);
    if (why) throw new Error(`Refused: command looks dangerous (${why}).`);
    return format(await execSandboxed(ctx.config, ctx, command, ms));
  },
};

export const runPython: Tool = {
  name: "run_python",
  description: "Run Python 3 code in the sandboxed workspace and return stdout/stderr. Files written to the working directory persist and can be sent with send_file. Admin only.",
  level: "admin",
  enabled,
  risky: true,
  untrusted: true,
  parameters: { type: "object", properties: { code: { type: "string" }, timeout_seconds: { type: "integer", description: "default 30, max 300" } }, required: ["code"] },
  async run({ code, timeout_seconds }, ctx) {
    const ms = Math.min(Math.max(timeout_seconds ?? 30, 1), 300) * 1000;
    const why = checkDangerous(code);
    if (why) throw new Error(`Refused: code looks dangerous (${why}).`);
    fs.mkdirSync(ctx.workdir, { recursive: true });
    const file = `_run_${rid(4)}.py`;
    fs.writeFileSync(path.join(ctx.workdir, file), code);
    try {
      return format(await execSandboxed(ctx.config, ctx, `python3 ${file}`, ms));
    } finally {
      fs.rmSync(path.join(ctx.workdir, file), { force: true });
    }
  },
};

export const execTools: Tool[] = [runShell, runPython];
