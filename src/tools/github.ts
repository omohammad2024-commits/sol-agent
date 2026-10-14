import type { Config } from "../config";
import type { Tool } from "../types";
import { HttpError, httpJson, truncate } from "../util";

const API = "https://api.github.com";

async function gh<T = any>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  return httpJson<T>(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "sol-agent",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const MUTATING = new Set(["create_repo", "write_file", "create_issue", "comment_issue", "close_issue", "create_pr", "merge_pr", "create_release"]);
const need = (a: any, ...keys: string[]) => {
  for (const k of keys) if (a[k] === undefined || a[k] === "") throw new Error(`"${k}" is required for action ${a.action}`);
};

export const github: Tool = {
  name: "github",
  description:
    "GitHub operations via the REST API. Actions: list_repos, get_repo, create_repo, list_files, read_file, write_file, list_issues, create_issue, comment_issue, close_issue, list_prs, create_pr, merge_pr, list_releases, create_release. Repo = owner + repo.",
  level: "admin",
  untrusted: true,
  enabled: (c: Config) => !!c.GITHUB_TOKEN,
  risky: (a) => MUTATING.has(a.action),
  taints: true,
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list_repos", "get_repo", "create_repo", "list_files", "read_file", "write_file", "list_issues", "create_issue", "comment_issue", "close_issue", "list_prs", "create_pr", "merge_pr", "list_releases", "create_release"] },
      owner: { type: "string" }, repo: { type: "string" }, name: { type: "string", description: "repo name for create_repo / release name" },
      path: { type: "string", description: "file or directory path in the repo" }, ref: { type: "string", description: "branch/tag/sha (reads)" }, branch: { type: "string", description: "target branch (write_file)" },
      content: { type: "string", description: "UTF-8 file content (write_file)" }, message: { type: "string", description: "commit message" },
      title: { type: "string" }, body: { type: "string" }, number: { type: "integer", description: "issue / PR number" },
      state: { type: "string", enum: ["open", "closed", "all"] }, head: { type: "string" }, base: { type: "string" },
      merge_method: { type: "string", enum: ["merge", "squash", "rebase"] }, tag: { type: "string" },
      draft: { type: "boolean" }, prerelease: { type: "boolean" }, private: { type: "boolean" }, description: { type: "string" },
    },
    required: ["action"],
  },
  async run(a, ctx) {
    const t = ctx.config.GITHUB_TOKEN!;
    const rp = () => { need(a, "owner", "repo"); return `/repos/${a.owner}/${a.repo}`; };
    const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
    switch (a.action) {
      case "list_repos": {
        const d = await gh<any[]>(t, "GET", a.owner ? `/users/${a.owner}/repos?per_page=30&sort=updated` : "/user/repos?per_page=30&sort=updated");
        return d.map((r) => ({ full_name: r.full_name, private: r.private, stars: r.stargazers_count, updated: r.updated_at, description: r.description }));
      }
      case "get_repo": {
        const r = await gh(t, "GET", rp());
        return { full_name: r.full_name, description: r.description, default_branch: r.default_branch, private: r.private, stars: r.stargazers_count, forks: r.forks_count, open_issues: r.open_issues_count, language: r.language, pushed_at: r.pushed_at, url: r.html_url };
      }
      case "create_repo": {
        need(a, "name");
        const r = await gh(t, "POST", "/user/repos", { name: a.name, private: a.private ?? true, description: a.description, auto_init: true });
        return { url: r.html_url, full_name: r.full_name };
      }
      case "list_files": {
        const d = await gh<any>(t, "GET", `${rp()}/contents/${enc(a.path ?? "")}${a.ref ? `?ref=${encodeURIComponent(a.ref)}` : ""}`);
        return (Array.isArray(d) ? d : [d]).map((f) => ({ name: f.name, path: f.path, type: f.type, size: f.size }));
      }
      case "read_file": {
        need(a, "path");
        const d = await gh<any>(t, "GET", `${rp()}/contents/${enc(a.path)}${a.ref ? `?ref=${encodeURIComponent(a.ref)}` : ""}`);
        if (Array.isArray(d) || d.type !== "file") throw new Error("Path is not a file; use list_files");
        return { path: d.path, sha: d.sha, size: d.size, content: truncate(Buffer.from(d.content ?? "", "base64").toString("utf8"), 20000) };
      }
      case "write_file": {
        need(a, "path", "content", "message");
        let sha: string | undefined;
        try {
          const cur = await gh<any>(t, "GET", `${rp()}/contents/${enc(a.path)}${a.branch ? `?ref=${encodeURIComponent(a.branch)}` : ""}`);
          sha = cur.sha;
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 404)) throw e;
        }
        const r = await gh(t, "PUT", `${rp()}/contents/${enc(a.path)}`, { message: a.message, content: Buffer.from(a.content, "utf8").toString("base64"), sha, branch: a.branch });
        return { committed: true, commit: r.commit?.sha, url: r.content?.html_url, created: !sha };
      }
      case "list_issues": {
        const d = await gh<any[]>(t, "GET", `${rp()}/issues?state=${a.state ?? "open"}&per_page=30`);
        return d.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, state: i.state, user: i.user?.login, labels: i.labels?.map((l: any) => l.name), url: i.html_url }));
      }
      case "create_issue": {
        need(a, "title");
        const r = await gh(t, "POST", `${rp()}/issues`, { title: a.title, body: a.body });
        return { number: r.number, url: r.html_url };
      }
      case "comment_issue": {
        need(a, "number", "body");
        const r = await gh(t, "POST", `${rp()}/issues/${a.number}/comments`, { body: a.body });
        return { url: r.html_url };
      }
      case "close_issue": {
        need(a, "number");
        const r = await gh(t, "PATCH", `${rp()}/issues/${a.number}`, { state: "closed" });
        return { number: r.number, state: r.state };
      }
      case "list_prs": {
        const d = await gh<any[]>(t, "GET", `${rp()}/pulls?state=${a.state ?? "open"}&per_page=30`);
        return d.map((p) => ({ number: p.number, title: p.title, state: p.state, user: p.user?.login, head: p.head?.ref, base: p.base?.ref, draft: p.draft, url: p.html_url }));
      }
      case "create_pr": {
        need(a, "title", "head", "base");
        const r = await gh(t, "POST", `${rp()}/pulls`, { title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft });
        return { number: r.number, url: r.html_url };
      }
      case "merge_pr": {
        need(a, "number");
        const r = await gh(t, "PUT", `${rp()}/pulls/${a.number}/merge`, { merge_method: a.merge_method ?? "squash" });
        return { merged: r.merged, message: r.message };
      }
      case "list_releases": {
        const d = await gh<any[]>(t, "GET", `${rp()}/releases?per_page=15`);
        return d.map((r) => ({ tag: r.tag_name, name: r.name, draft: r.draft, prerelease: r.prerelease, published: r.published_at, url: r.html_url }));
      }
      case "create_release": {
        need(a, "tag");
        const r = await gh(t, "POST", `${rp()}/releases`, { tag_name: a.tag, name: a.name ?? a.tag, body: a.body, draft: a.draft ?? false, prerelease: a.prerelease ?? false, target_commitish: a.base });
        return { url: r.html_url, id: r.id };
      }
      default:
        throw new Error(`Unknown action ${a.action}`);
    }
  },
};
