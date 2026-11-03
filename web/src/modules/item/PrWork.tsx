// Review, Verify, Fix-ups and Actions sections of the Item page.
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { Item, ItemAction, ItemFixup, ItemPatchCheck, ItemReviews, ItemVerification, ReleaseAction, ReviewSide, ReviewVerdictName, TaskResult } from "../../api/types";
import { useApi } from "../../api/client";
import { Badge, type Tone } from "../../ui/Badge";
import { useUser } from "../../shell/UserContext";
import { ConfirmButton, ErrorLine, useWrite } from "../admin/parts";
import { ago, span } from "../../lib/format";
import { useNow } from "../../lib/useNow";

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
  error: ["Error", "warn"], "ci-enough": ["CI is enough", "ok"], stale: ["Stale", "neutral"], unavailable: ["Not verified", "warn"],
};
const KIND: Record<ItemVerification["kind"], string> = { "ci-enough": "CI is enough", tests: "Run tests", regression: "Regression test", error: "No plan", unavailable: "Cannot build here" };
const T_TONE: Record<string, Tone> = { queued: "neutral", claimed: "accent", running: "accent", done: "ok", failed: "bad", cancelled: "neutral", lost: "bad" };

const stepText = (r: TaskResult) => `${r.timedOut ? "timed out" : `exit ${r.exitCode ?? "none"}`} · ${r.durationMs < 60_000 ? `${(r.durationMs / 1000).toFixed(1)} s` : span(r.durationMs)}`;

function Verify({ v }: { v: ItemVerification }) {
  useNow();
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

const R_VERDICT: Record<ReviewVerdictName, [string, Tone]> = { take: ["Take", "ok"], "take-fix": ["Take with fixes", "ok"], hold: ["Hold", "warn"], close: ["Close", "bad"] };

function ReviewCard({ title, side, isFinal, extra, children }: { title: string; side: ReviewSide | null; isFinal: boolean; extra?: ReactNode; children?: ReactNode }) {
  useNow();
  const v = side && R_VERDICT[side.verdict];
  return (
    <div className="min-w-0 rounded-md border border-line px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        {v && <Badge tone={v[1]}>{v[0]}</Badge>}
        {isFinal && <Badge tone="accent">Final</Badge>}
        {side && <span className="ml-auto text-xs text-ink/50">{ago(side.at)} ago</span>}
      </div>
      {extra}
      {side ? (
        <>
          <p className="mt-2 text-ink/80">{side.reason}</p>
          {side.fixes.length > 0 && (
            <div className="mt-2">
              <h3 className="text-xs font-medium text-ink/55">Fixes</h3>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                {side.fixes.map((f, i) => (
                  <li key={i}>
                    <span className="code break-all text-xs">{f.file}</span> {f.change}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {side.risks.length > 0 && (
            <div className="mt-2">
              <h3 className="text-xs font-medium text-ink/55">Risks</h3>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                {side.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        children
      )}
    </div>
  );
}

function Reviews({ r }: { r: ItemReviews }) {
  const o = r.opus;
  const [fv, ftone] = R_VERDICT[r.final.verdict];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink/55">Final verdict</span>
        <Badge tone={ftone}>{r.final.decided ? fv : "Waiting for the Opus review"}</Badge>
        <span className="code text-xs text-ink/50" title={r.head}>{r.head.slice(0, 7)}</span>
        {!r.current && <Badge tone="warn">Older head</Badge>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ReviewCard title="Sonnet, first pass" side={r.sonnet} isFinal={r.final.decided && r.final.source !== "opus"}>
          <p className="mt-2 text-ink/60">No review</p>
        </ReviewCard>
        <ReviewCard
          title="Opus, final review"
          side={o}
          isFinal={r.final.decided && r.final.source === "opus"}
          extra={
            o && (
              <p className="mt-1 text-xs text-ink/60">
                {o.sure ? "Sure" : "Unsure"} · {o.mode === "delta" ? `changes since ${(o.baseHead ?? "").slice(0, 7)}` : "full diff"}
              </p>
            )
          }
        >
          <p className="mt-2 text-ink/80">{r.skipReason ? `Skipped: ${r.skipReason}` : r.final.decided ? "No review" : "Waiting for the Opus review"}</p>
        </ReviewCard>
      </div>
    </div>
  );
}

function PatchChecks({ rows }: { rows: ItemPatchCheck[] }) {
  useNow();
  return (
    <ul className="divide-y divide-line rounded-md border border-line text-sm">
      {rows.map((c, i) => (
        <li key={i} className="px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={c.verdict === "approve" ? "ok" : "bad"}>{c.verdict === "approve" ? "Approved" : "Rejected"}</Badge>
            <span className="text-xs text-ink/55">Opus check · round {c.round}</span>
            <span className="code text-xs text-ink/55" title={c.subject}>{c.subject.slice(0, 7)}</span>
            <span className="ml-auto text-xs text-ink/50">{ago(c.createdAt)} ago</span>
          </div>
          {c.reasons && <p className="mt-1 text-ink/75">{c.reasons}</p>}
          {c.problems.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink/75">
              {c.problems.map((p, j) => (
                <li key={j}>{p}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

const F_STATE: Record<ItemFixup["state"], [string, Tone]> = {
  pushed: ["Pushed", "ok"], failed: ["Failed", "bad"], refused: ["Refused", "warn"], rejected: ["Rejected by Opus", "warn"], "cannot-push": ["Cannot push", "warn"], "too-large": ["Too large", "warn"], asked: ["Asked for changes", "neutral"],
};

function Fixups({ rows }: { rows: ItemFixup[] }) {
  useNow();
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
  useNow();
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

const RELEASES: { key: keyof Item["releases"]; action: ReleaseAction; label: string; confirm: string; help: string }[] = [
  { key: "reviewAgain", action: "review-again", label: "Review again at this head", confirm: "Delete the hold, review again", help: "Removes the hold review of the current head; the Review stage reviews it again." },
  { key: "verifyAgain", action: "verify-again", label: "Verify again", confirm: "Plan Verify again", help: "Plans the verification of the current head again, with new build tasks." },
  { key: "fixAgain", action: "fix-again", label: "Try the fix again", confirm: "Forget the attempt, try again", help: "Forgets the skipped or failed fix attempt, so the issue is eligible for Fix once more with a fresh attempt count." },
  { key: "batchAgain", action: "batch-again", label: "Try the batch again", confirm: "Release the PR, try the batch again", help: "Releases the PR from its failed batch, so the merge queue considers it again and puts it in a new batch." },
];

/** Operator releases for an item that waits for a person. They change the pipeline's tables only; nothing is written to GitHub. */
function Releases({ it }: { it: Item }) {
  const api = useApi();
  const write = useWrite();
  const shown = RELEASES.filter((r) => it.releases[r.key]);
  if (!shown.length) return null;
  return (
    <Box title="Release" aside="nothing is written to GitHub; the pipeline picks the item up on its next pass">
      <ErrorLine error={write.error} />
      <ul className="divide-y divide-line rounded-md border border-line text-sm">
        {shown.map((r) => (
          <li key={r.action} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <span className="min-w-0 flex-1 text-ink/75">{r.help}</span>
            <ConfirmButton
              label={r.label}
              confirmLabel={r.confirm}
              loading={write.busy === r.action}
              onConfirm={() => void write.run(r.action, () => api.release(it.repo, it.number, r.action))}
            />
          </li>
        ))}
      </ul>
    </Box>
  );
}

export function PrWork({ it }: { it: Item }) {
  const operator = useUser().role === "operator";
  const fixupChecks = (it.patchChecks ?? []).filter((c) => c.kind === "fixup");
  const fixChecks = (it.patchChecks ?? []).filter((c) => c.kind === "fixissue");
  return (
    <>
      {operator && <Releases it={it} />}
      {it.reviews && (
        <Box title="Review">
          <Reviews r={it.reviews} />
        </Box>
      )}
      {it.verification && (
        <Box title="Verify" aside="builds and tests of this PR">
          <Verify v={it.verification} />
        </Box>
      )}
      {(it.fixups.length > 0 || fixupChecks.length > 0) && (
        <Box title="Fix-ups" aside={it.fixups.length > 0 ? `${it.fixups.length} ${it.fixups.length === 1 ? "try" : "tries"}` : undefined}>
          {it.fixups.length > 0 && <Fixups rows={it.fixups} />}
          {fixupChecks.length > 0 && (
            <div className={it.fixups.length > 0 ? "mt-3" : ""}>
              <PatchChecks rows={fixupChecks} />
            </div>
          )}
        </Box>
      )}
      {fixChecks.length > 0 && (
        <Box title="Fix">
          <PatchChecks rows={fixChecks} />
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
