// Verify, Fix-ups and Actions sections of the Item page.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Item, ItemAction, ItemFixup, ItemVerification, TaskResult } from "../../api/types";
import { Badge, type Tone } from "../../ui/Badge";
import { ago, span } from "../../lib/format";

function Box({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside && <span className="text-xs text-ink/50">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

const V_STATE: Record<ItemVerification["state"], [string, Tone]> = {
  planned: ["Planned", "neutral"], running: ["Running", "accent"], passed: ["Passed", "ok"], failed: ["Failed", "bad"],
  error: ["Error", "warn"], "ci-enough": ["CI is enough", "ok"], stale: ["Stale", "neutral"],
};
const KIND: Record<ItemVerification["kind"], string> = { "ci-enough": "CI is enough", tests: "Run tests", regression: "Regression test", error: "No plan" };
const T_TONE: Record<string, Tone> = { queued: "neutral", claimed: "accent", running: "accent", done: "ok", failed: "bad", cancelled: "neutral", lost: "bad" };

const stepText = (r: TaskResult) => `${r.timedOut ? "timed out" : `exit ${r.exitCode ?? "none"}`} · ${r.durationMs < 60_000 ? `${(r.durationMs / 1000).toFixed(1)} s` : span(r.durationMs)}`;

function Verify({ v }: { v: ItemVerification }) {
  const [label, tone] = V_STATE[v.state];
  const p = v.plan;
  return (
    <div className="rounded-md border border-line px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        <span className="font-medium">{KIND[v.kind]}</span>
        <span className="code text-xs text-ink/50" title={v.headSha}>{v.headSha.slice(0, 7)}</span>
        {!v.current && <Badge tone="warn">Older head</Badge>}
        <span className="ml-auto text-xs text-ink/50">{v.finishedAt ? `finished ${ago(v.finishedAt)} ago` : `planned ${ago(v.createdAt)} ago`}</span>
      </div>
      <p className="mt-2 text-ink/80">{v.reason}</p>
      {p && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
          {p.crates.length > 0 && (
            <>
              <dt className="text-ink/55">Crates</dt>
              <dd className="code break-words text-xs leading-5">{p.crates.join(", ")}</dd>
            </>
          )}
          {p.tests.length > 0 && (
            <>
              <dt className="text-ink/55">Tests</dt>
              <dd className="code break-words text-xs leading-5">{p.tests.join(", ")}</dd>
            </>
          )}
          {p.testLines !== null && (
            <>
              <dt className="text-ink/55">New test</dt>
              <dd className="num">{p.testLines} lines, run on the PR head and the base commit</dd>
            </>
          )}
        </dl>
      )}
      {v.tasks.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded border border-line">
          {v.tasks.map((t) => (
            <li key={t.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t.role === "head" ? "PR head" : "Base commit"}</span>
                <Badge tone={T_TONE[t.state] ?? "neutral"}>{t.state}</Badge>
                <Link to={`/envs/${t.id}`} className="num ml-auto text-xs text-accent-ink hover:underline max-md:py-2">
                  Task {t.id}
                </Link>
              </div>
              {t.results.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {t.results.map((r) => (
                    <li key={r.step} className="flex items-baseline gap-2 text-xs">
                      <span className={r.exitCode === 0 && !r.timedOut ? "text-ok" : "text-bad"} aria-hidden>
                        {r.exitCode === 0 && !r.timedOut ? "✓" : "✗"}
                      </span>
                      <span className="code">{r.step}</span>
                      <span className="num ml-auto text-ink/55">{stepText(r)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {v.summary && v.state !== "ci-enough" && v.state !== "planned" && <p className="mt-3 rounded border border-line bg-sunken px-3 py-2">{v.summary}</p>}
      {v.note && <p className="mt-2 text-xs text-warn">{v.note}</p>}
    </div>
  );
}

const F_STATE: Record<ItemFixup["state"], [string, Tone]> = {
  pushed: ["Pushed", "ok"], failed: ["Failed", "bad"], refused: ["Refused", "warn"], "cannot-push": ["Cannot push", "warn"], "too-large": ["Too large", "warn"],
};

function Fixups({ rows }: { rows: ItemFixup[] }) {
  return (
    <ol className="divide-y divide-line rounded-md border border-line text-sm">
      {rows.map((f, i) => {
        const [label, tone] = F_STATE[f.state];
        return (
          <li key={i} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone}>{label}</Badge>
              <span className="text-xs text-ink/55">try {f.attempt}</span>
              <span className="code text-xs text-ink/55">
                {f.fromHead.slice(0, 7)}
                {f.toHead && ` → ${f.toHead.slice(0, 7)}`}
              </span>
              <span className="ml-auto text-xs text-ink/50">{ago(f.createdAt)} ago</span>
            </div>
            {f.reason && <p className="mt-1 text-ink/75">{f.reason}</p>}
            {f.files.length > 0 && <p className="code mt-1 break-all text-xs leading-5 text-ink/65">{f.files.join(", ")}</p>}
          </li>
        );
      })}
    </ol>
  );
}

const A_STATE: Record<ItemAction["state"], [string, Tone]> = { done: ["Done", "ok"], skipped: ["Skipped", "neutral"], failed: ["Failed", "bad"] };

function Actions({ rows }: { rows: ItemAction[] }) {
  return (
    <ul className="divide-y divide-line rounded-md border border-line text-sm">
      {rows.map((a, i) => {
        const [label, tone] = A_STATE[a.state];
        return (
          <li key={i} className="px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone}>{label}</Badge>
              <span>{a.kind === "comment-close" ? "Comment and close" : a.kind}</span>
              {a.commentUrl && (
                <a href={a.commentUrl} target="_blank" rel="noreferrer" className="text-xs text-accent-ink hover:underline max-md:py-2">
                  Comment on GitHub
                </a>
              )}
              {a.state === "done" && <span className="text-xs text-ink/55">closed</span>}
              <Link to={`/decisions/${encodeURIComponent(a.decisionId)}`} className="code text-xs text-ink/50 hover:underline">
                {a.decisionId}
              </Link>
              <span className="ml-auto text-xs text-ink/50">{ago(a.createdAt)} ago</span>
            </div>
            {a.reason && <p className="mt-1 text-ink/75">{a.reason}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function PrWork({ it }: { it: Item }) {
  return (
    <>
      {it.verification && (
        <Box title="Verify" aside="builds and tests of this PR">
          <Verify v={it.verification} />
        </Box>
      )}
      {it.fixups.length > 0 && (
        <Box title="Fix-ups" aside={`${it.fixups.length} ${it.fixups.length === 1 ? "try" : "tries"}`}>
          <Fixups rows={it.fixups} />
        </Box>
      )}
      {it.actions.length > 0 && (
        <Box title="Actions" aside="GitHub writes after a decision">
          <Actions rows={it.actions} />
        </Box>
      )}
    </>
  );
}
