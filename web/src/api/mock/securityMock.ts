// Mock security deep scan: a running, a capped and a done scan, and findings in several states.
import type { Api } from "../client";
import type { FindingAction, FindingCall, FindingState, FindingView, ScanView, User } from "../types";
import { NOW } from "./fixtures";

const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const wait = <T>(v: T, ms = 60) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const SHA = "3b9d0e51c7a24f68d1e0b9a47c2f5d8e6a1b0c93";

const call = (id: string, minAgo: number, step: string, summary: string, costUsd: number | null): FindingCall => ({ id, at: iso(minAgo), step, model: "Opus", summary, costUsd });

function scans(): ScanView[] {
  const base = { startedBy: "kiri-n", error: null, endedAt: null };
  return [
    { ...base, id: 3, repo: "designcraft", commitSha: "a41f9c02d7e8", state: "scanning", capUsd: 15, costUsd: 6.42, estimateUsd: 13.5, areasTotal: 9, areasDone: 4, startedAt: iso(38) },
    { ...base, id: 2, repo: "designcraft", commitSha: "9c7e41b0a3d5", state: "capped", capUsd: 5, costUsd: 5.03, estimateUsd: 13.2, areasTotal: 9, areasDone: 3, startedAt: iso(3 * 1440), endedAt: iso(3 * 1440 - 41) },
    { ...base, id: 1, repo: "designcraft", commitSha: SHA.slice(0, 12), state: "done", capUsd: null, costUsd: 11.87, estimateUsd: 12.4, areasTotal: 8, areasDone: 8, startedAt: iso(9 * 1440), endedAt: iso(9 * 1440 - 74) },
  ];
}

function findings(): FindingView[] {
  const f = (number: number, p: Partial<FindingView> & Pick<FindingView, "title" | "severity" | "state" | "area">): FindingView => ({
    repo: "designcraft", number, scanId: 1, urgent: false, createdAt: iso(9 * 1440 - 60), updatedAt: iso(9 * 1440 - 60 + number * 700), commitSha: SHA,
    refs: [{ path: "crates/doc-io/src/open.rs", line: 212 }],
    reach: "The file is opened from the Open dialog, a recent-files entry or a double click in the file manager. The reader passes the length field of each chunk straight to the allocator.",
    impact: "A crafted document makes the reader write outside its buffer while the file opens.",
    verification: { kind: "reasoning", result: "Confirmed by reading the code path", notes: "No bound check between the chunk header and the copy at open.rs:218." },
    reason: null, decidedBy: null, fixCommit: null, fixPr: null, ghsaId: null, fixDiff: null,
    timeline: [call(`a${number}`, 9 * 1440 - 20, "Area scan", `Scanned ${p.area}: reported this finding`, 1.34), call(`v${number}`, 9 * 1440 - 40, "Verify", "Tried to disprove it and kept it, score 9 of 10", 0.61)],
    ...p,
  });
  return [
    f(1, {
      title: "Chunk length in document files is trusted when copying into the read buffer", severity: "critical", urgent: true, state: "new", area: "doc-io",
      refs: [{ path: "crates/doc-io/src/open.rs", line: 212 }, { path: "crates/doc-io/src/chunk.rs", line: 57 }, { path: "crates/doc-io/src/open.rs", line: 218 }],
      verification: { kind: "test", result: "A failing test reproduces it", notes: "open_rejects_oversize_chunk writes 4 GiB of chunk length and aborts in the reader." },
    }),
    f(2, { title: "Plugin loader runs scripts from a document's embedded folder", severity: "high", state: "new", area: "plugins", refs: [{ path: "crates/plugins/src/load.rs", line: 88 }], reach: "A document can ship a plugins folder. The loader scans it on open and runs every script it finds.", impact: "Opening a document runs code from it with the user's rights." }),
    f(3, { title: "Font parser accepts table offsets past the end of the file", severity: "high", state: "fixing", area: "fonts", decidedBy: "kiri-n", refs: [{ path: "crates/fonts/src/sfnt.rs", line: 143 }] }),
    f(4, {
      title: "Update check follows redirects to any host", severity: "medium", state: "ready", area: "updater", decidedBy: "kiri-n", refs: [{ path: "crates/updater/src/check.rs", line: 61 }],
      fixCommit: "e07a91c35b2d", fixDiff: "--- a/crates/updater/src/check.rs\n+++ b/crates/updater/src/check.rs\n@@ -58,4 +58,6 @@\n-    let client = Client::new();\n+    let client = Client::builder()\n+        .redirect(Policy::none())\n+        .build()?;\n",
      verification: { kind: "test", result: "The regression test fails before the fix and passes after", notes: "update_check_ignores_redirects" },
    }),
    f(5, { title: "Image decoder copies palette entries without a count check", severity: "medium", state: "backlog", area: "images", decidedBy: "ana-p", refs: [{ path: "crates/images/src/png.rs", line: 301 }] }),
    f(6, { title: "Deep link handler passes the path query to the file opener", severity: "low", state: "dismissed", area: "ipc", reason: "Needs a local attacker who can already write to the user's files.", decidedBy: "kiri-n", refs: [{ path: "crates/ipc/src/deeplink.rs", line: 39 }] }),
    f(7, { title: "Release workflow checks out pull request code with write token", severity: "high", state: "advisory", area: "ci", decidedBy: "kiri-n", ghsaId: "GHSA-xxxx-xxxx-xxxx", fixPr: 2418, fixCommit: "5d20be8f91aa", refs: [{ path: ".github/workflows/release.yml", line: 14 }] }),
    f(8, { title: "Cloud sync client does not verify the server certificate chain length", severity: "low", state: "landed", area: "cloud", decidedBy: "kiri-n", fixPr: 2402, fixCommit: "c3a8d77e0412", refs: [{ path: "crates/cloud/src/tls.rs", line: 120 }] }),
  ];
}

const NEXT: Record<FindingAction, FindingState | null> = { fix: "fixing", dismiss: "dismissed", backlog: "backlog", reopen: "new", land: "landing", advisory: "awaiting-admin", publish: "published" };

export function createSecurityMock(me: User, changed: () => void): Pick<Api, "security"> {
  const forbidden = () => {
    if (me.role === "viewer") throw new Error("Not found");
  };
  const operator = () => {
    if (me.role !== "operator") throw new Error("only operators act on security findings");
  };
  const sc = scans();
  const fs = findings();
  const summary = ({ commitSha: _c, refs: _r, reach: _a, impact: _i, verification: _v, reason: _n, decidedBy: _d, fixCommit: _f, fixPr: _p, ghsaId: _g, fixDiff: _x, timeline: _t, ...s }: FindingView) => s;
  const find = (repo: string, n: number) => {
    const f = fs.find((x) => x.repo === repo && x.number === n);
    if (!f) throw new Error("Not found");
    return f;
  };
  return {
    security: {
      overview: async (repo) => {
        forbidden();
        return wait({ scans: sc.filter((s) => s.repo === repo).sort((a, b) => b.id - a.id), findings: fs.filter((f) => f.repo === repo).map(summary) });
      },
      startScan: async (repo, capUsd) => {
        operator();
        if (sc.some((s) => s.repo === repo && ["modeling", "scanning", "verifying"].includes(s.state))) throw new Error("A scan is already running for this repo");
        const s: ScanView = { id: Math.max(...sc.map((x) => x.id)) + 1, repo, commitSha: SHA.slice(0, 12), state: "modeling", capUsd, costUsd: 0, estimateUsd: null, areasTotal: 0, areasDone: 0, startedBy: me.login, startedAt: new Date(NOW).toISOString(), endedAt: null, error: null };
        sc.push(s);
        changed();
        return wait(s);
      },
      stopScan: async (id) => {
        operator();
        const s = sc.find((x) => x.id === id);
        if (s) Object.assign(s, { state: "stopped", endedAt: new Date(NOW).toISOString() });
        changed();
        return wait(undefined);
      },
      finding: async (repo, n) => {
        forbidden();
        return wait(find(repo, n));
      },
      act: async (repo, n, action, reason) => {
        operator();
        const f = find(repo, n);
        if (action === "land" || action === "advisory" || action === "publish") throw new Error("Not implemented yet");
        f.state = NEXT[action]!;
        f.reason = action === "dismiss" ? (reason ?? null) : null;
        f.decidedBy = me.login;
        f.updatedAt = new Date(NOW).toISOString();
        changed();
        return wait(undefined);
      },
    },
  };
}
