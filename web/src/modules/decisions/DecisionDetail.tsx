import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRightIcon, ChevronLeftIcon, ChevronRightIcon, CheckIcon, Undo2Icon, MessageSquareIcon, XIcon } from "lucide-react";
import { Avatar } from "../../ui/Avatar";
import { useApi } from "../../api/client";
import type { Decision, User } from "../../api/types";
import type { ViewProps } from "../../registry/types";
import { decisionAccess, type DecisionAccess } from "../../registry/permissions";
import { Hud, RegMarks } from "../../ui/Hud";
import { Kbd } from "../../ui/Kbd";
import { Button, IconButton } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { ago } from "../../lib/format";
import { ClaimPill, ClassifierLines, Disclosure, Facts, KindTag, OptionButtons, RelatedList } from "./parts";
import { localActions, ordered, refOf, useAnswer, useDecisionList, useLocal, useSelection, useUndo } from "./state";
import { Thread } from "./Thread";

export const accessFor = (user: User, ds: Decision[]): DecisionAccess =>
  decisionAccess(user, ds.flatMap((d) => (d.items.length ? d.items.map((i) => i.repo) : [d.repo])));

/** Desktop detail panel: the selected decision, or the batch answer for checked rows. */
export function DetailPanel({ user }: ViewProps) {
  const { data } = useDecisionList();
  const { id, go } = useSelection();
  const loc = useLocal();
  const list = ordered(data?.decisions ?? []);
  const checked = list.filter((d) => loc.checked.has(d.id));

  if (checked.length > 1) return <MultiAnswer ds={checked} user={user} />;
  const d = list.find((x) => x.id === id) ?? null;
  const idx = d ? list.indexOf(d) : -1;
  const just = loc.justAnswered.find((x) => x.id === id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10">
        <Hud>Decision</Hud>
        {data && d && (
          <span className="font-mono text-2xs text-ink/45">
            {idx + 1} / {list.length}
          </span>
        )}
        <div className="ml-auto flex items-center">
          <IconButton size="sm" icon={ChevronLeftIcon} label="Previous (k)" disabled={idx <= 0} onClick={() => go(list[idx - 1]?.id)} />
          <IconButton size="sm" icon={ChevronRightIcon} label="Next (j)" disabled={idx < 0 || idx >= list.length - 1} onClick={() => go(list[idx + 1]?.id)} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {just && !d ? (
          <AnsweredNotice entry={just} />
        ) : d ? (
          <div className="mx-auto max-w-[760px] px-6 pb-10 pt-6">
            <DecisionBody key={d.id} d={d} user={user} onAnswered={() => go(list[idx + 1]?.id ?? list[idx - 1]?.id)} />
          </div>
        ) : (
          <EmptyDetail count={list.length} />
        )}
      </div>
    </div>
  );
}

function EmptyDetail({ count }: { count: number }) {
  return (
    <div className="bg-dots flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {count === 0 ? (
        <>
          <p className="font-serif text-3xl italic text-ink/80">Nothing waiting.</p>
          <p className="text-sm text-ink/55">Every decision in this view has an answer.</p>
        </>
      ) : (
        <>
          <Hud>Pick a decision</Hud>
          <p className="text-sm text-ink/55">
            <Kbd keys="j" /> and <Kbd keys="k" /> move through the list.
          </p>
        </>
      )}
    </div>
  );
}

function AnsweredNotice({ entry }: { entry: { id: string; label: string; ref: string } }) {
  const undo = useUndo();
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex items-center gap-3 border border-line px-4 py-3 text-sm">
        <CheckIcon className="text-ok" />
        <span className="ref">{entry.ref}</span>
        <span className="text-ink/70">→ {entry.label}</span>
        <Button size="sm" variant="ghost" icon={Undo2Icon} onClick={() => undo(entry.id)}>
          Undo
        </Button>
      </div>
    </div>
  );
}

/** The decision itself; shared by the desktop detail panel and the phone pager. */
export function DecisionBody({ d, user, onAnswered, phone }: { d: Decision; user: User; onAnswered?: () => void; phone?: boolean }) {
  const api = useApi();
  const answer = useAnswer();
  const loc = useLocal();
  const noteRef = useRef<HTMLInputElement>(null);
  const access = accessFor(user, [d]);
  const isBatch = d.number === null;
  const pendingProps = d.proposals.filter((p) => p.status === "pending");
  const mine = pendingProps.find((p) => p.login === user.login);
  // Options are live for an operator, and for a maintainer who has no pending proposal here.
  const live = !d.answer && (access.mode === "answer" || (access.mode === "propose" && !mine));

  useEffect(() => {
    if (access.mode !== "read" && !d.answer) void api.decisions.claim(d.id);
  }, [api, d.id, d.answer, access.mode]);

  const pick = async (key: string) => {
    if (access.mode === "propose") {
      await api.decisions.propose(d.id, { answer: key, note: loc.notes[d.id] || undefined });
      localActions.setNote(d.id, "");
      return;
    }
    await answer([d], key);
    onAnswered?.();
  };

  // Number keys answer; n focuses the note. Bound here so they always target the decision on screen.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (live && n >= 1 && n <= d.options.length) {
        e.preventDefault();
        void pick(d.options[n - 1].key);
      }
      if (e.key === "n" && noteRef.current) {
        e.preventDefault();
        noteRef.current.focus();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  return (
    <article className="animate-rise">
      <div className="flex flex-wrap items-center gap-2">
        <KindTag kind={d.kind} batch={isBatch ? d.items.length : undefined} />
        {isBatch ? (
          <span className="ref text-ink/70">{d.repo}</span>
        ) : (
          <Link to={`/item/${d.repo}/${d.number}`} className="ref inline-flex items-center gap-0.5 text-accent-ink hover:underline">
            {d.repo}#{d.number}
            <ArrowUpRightIcon className="text-[10px]" />
          </Link>
        )}
        <span className="font-mono text-2xs text-ink/45">asked {ago(d.askedAt)} ago</span>
        <ClaimPill claim={d.claim} />
        {!phone && d.commentCount > 0 && (
          <span className="inline-flex items-center gap-1 font-mono text-2xs text-ink/45">
            <MessageSquareIcon className="text-[10px]" /> {d.commentCount}
          </span>
        )}
      </div>
      <p className={cn("mt-3 text-ink/60", phone ? "line-clamp-2 text-sm" : "text-sm")}>{d.title}</p>
      <h1 className={cn("mt-1.5 text-balance font-display text-ink", phone ? "text-[22px] leading-[26px]" : "text-xl")}>{d.question}</h1>

      <div className="relative mt-5">
        {!phone && <RegMarks />}
        <Facts facts={d.facts} compact={phone} />
      </div>

      {!d.answer && pendingProps.length > 0 && <Proposals d={d} user={user} access={access} phone={phone} />}

      {d.answer ? (
        <AnsweredState d={d} canUndo={access.mode === "answer"} />
      ) : mine ? null : phone && access.mode === "answer" && pendingProps.length > 0 ? (
        <div className="mt-4">
          <Disclosure title="Answer differently" count={d.options.length}>
            <OptionButtons options={d.options} recommended={d.recommended} onPick={pick} phone />
          </Disclosure>
        </div>
      ) : (
        <div className="mt-5">
          {access.mode === "propose" && (
            <p className="mb-2 flex items-center gap-2 font-mono text-2xs uppercase tracking-[0.1em] text-ink/55">
              <span className="size-1.5 bg-accent-ink" /> Your pick goes to an operator as a proposal
            </p>
          )}
          <OptionButtons options={d.options} recommended={d.recommended} onPick={pick} readOnly={access.mode === "read" ? access.reason : null} verb={access.mode === "propose" ? "Propose" : undefined} phone={phone} />
          {access.mode !== "read" && (
            <label className="mt-2 flex h-9 items-center gap-2 border border-line bg-sunken/40 px-2.5 focus-within:border-line-strong">
              <Hud className="shrink-0 text-2xs">Note</Hud>
              <input
                ref={noteRef}
                value={loc.notes[d.id] ?? ""}
                onChange={(e) => localActions.setNote(d.id, e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
                placeholder={access.mode === "propose" ? "optional, for the operator" : "optional, kept with the answer"}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink/35"
              />
              {!phone && <Kbd keys="n" className="opacity-60" />}
            </label>
          )}
        </div>
      )}

      <div className={!phone ? "mt-6" : phone && access.mode === "answer" && pendingProps.length > 0 && !d.answer ? "" : "mt-4"}>
        {isBatch && (
          <Disclosure title="Items" count={d.items.length} defaultOpen={!phone}>
            <BatchItems d={d} />
          </Disclosure>
        )}
        {d.context.length > 0 && (
          <Disclosure title="Context" defaultOpen={!phone}>
            <div className="space-y-1.5 text-sm leading-6 text-ink/80">
              {d.context.map((c, i) => (
                <p key={i}>{c}</p>
              ))}
            </div>
          </Disclosure>
        )}
        {d.publicText && (
          <Disclosure title="Posted publicly">
            <blockquote className="border-l-2 border-line-strong pl-3 text-sm italic leading-6 text-ink/75">{d.publicText}</blockquote>
          </Disclosure>
        )}
        <Disclosure title="Classifiers" count={d.classifications.length}>
          <ClassifierLines d={d} />
        </Disclosure>
        {d.related.length > 0 && (
          <Disclosure title="Related" count={d.related.length}>
            <RelatedList d={d} />
          </Disclosure>
        )}
        {phone && (
          <Disclosure title="Discussion" count={d.commentCount}>
            <Thread decisionId={d.id} compact />
          </Disclosure>
        )}
      </div>
    </article>
  );
}

function AnsweredState({ d, canUndo }: { d: Decision; canUndo: boolean }) {
  const undo = useUndo();
  const label = d.options.find((o) => o.key === d.answer)?.label ?? d.answer;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3 border border-ok/40 bg-ok/[0.06] px-4 py-3">
      <CheckIcon className="text-ok" />
      <span className="text-sm font-semibold">{label}</span>
      <span className="font-mono text-2xs text-ink/55">
        {d.proposedBy ? `proposed by ${d.proposedBy}, approved by ${d.answeredBy}` : d.answeredBy} · {ago(d.answeredAt!)} ago · {d.appliedAt ? "applied" : "not applied yet"}
      </span>
      {d.answerNote && <span className="w-full text-sm italic text-ink/70">“{d.answerNote}”</span>}
      {!d.appliedAt && canUndo && (
        <Button size="sm" variant="ghost" icon={Undo2Icon} className="ml-auto" onClick={() => undo(d.id)}>
          Undo
        </Button>
      )}
    </div>
  );
}

function BatchItems({ d }: { d: Decision }) {
  const loc = useLocal();
  const ov = loc.overrides[d.id] ?? {};
  return (
    <ul className="border border-line">
      {d.items.map((it) => {
        const ref = `${it.repo}#${it.number}`;
        return (
          <li key={ref} className="flex min-h-[36px] items-center gap-3 border-b border-line px-3 last:border-0">
            <Link to={`/item/${it.repo}/${it.number}`} className="ref w-[118px] shrink-0 text-accent-ink hover:underline">
              {ref}
            </Link>
            <span className="min-w-0 flex-1 truncate text-sm text-ink/80">{it.title}</span>
            <select
              aria-label={`Answer for ${ref}`}
              value={ov[ref] ?? ""}
              onChange={(e) => localActions.setOverride(d.id, ref, e.target.value || null)}
              className={cn("h-7 shrink-0 border border-line bg-transparent px-1.5 font-mono text-2xs uppercase tracking-[0.08em]", ov[ref] ? "text-warn" : "text-ink/45")}
            >
              <option value="">same as batch</option>
              {d.options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </li>
        );
      })}
    </ul>
  );
}

/** Several checked rows of one kind: one answer for all of them. */
function MultiAnswer({ ds, user }: { ds: Decision[]; user: User }) {
  const answer = useAnswer();
  const kinds = new Set(ds.map((d) => d.kind));
  const optionSig = new Set(ds.map((d) => d.options.map((o) => o.key).join()));
  const same = kinds.size === 1 && optionSig.size === 1;
  const api = useApi();
  const access = accessFor(user, ds);
  const recs = ds.map((d) => d.recommended);
  const rec = recs.every((r) => r === recs[0]) ? recs[0] : "";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 pr-10">
        <Hud>Answer together</Hud>
        <span className="font-mono text-2xs text-ink/45">{ds.length} selected</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={localActions.clearChecked}>
          Clear <Kbd keys="esc" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 pb-10 pt-6">
          <h1 className="font-display text-xl">{same ? ds[0].question.replace(/ for [a-z-]+\?$/, "?") : "These decisions ask different questions"}</h1>
          <p className="mt-2 text-sm text-ink/60">{same ? `One answer for all ${ds.length}. Change single items afterwards from their own page.` : "Check decisions of one kind to answer them together."}</p>
          <ul className="mt-5 border border-line">
            {ds.map((d) => (
              <li key={d.id} className="flex h-9 items-center gap-3 border-b border-line px-3 last:border-0">
                <span className="ref w-[150px] shrink-0 truncate text-ink/70">{refOf(d)}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{d.title}</span>
                <span className="shrink-0 font-mono text-2xs text-ink/45">rec: {d.options.find((o) => o.key === d.recommended)?.label}</span>
              </li>
            ))}
          </ul>
          {same && (
            <div className="mt-5">
              <OptionButtons
                options={ds[0].options}
                recommended={rec}
                readOnly={access.mode === "read" ? access.reason : null}
                verb={access.mode === "propose" ? "Propose" : undefined}
                onPick={(k) =>
                  void (access.mode === "propose" ? Promise.all(ds.map((d) => api.decisions.propose(d.id, { answer: k }))).then(localActions.clearChecked) : answer(ds, k))
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Pending maintainer proposals. Operators approve or reject; the proposer can withdraw. */
function Proposals({ d, user, access, phone }: { d: Decision; user: User; access: DecisionAccess; phone?: boolean }) {
  const api = useApi();
  const pending = d.proposals.filter((p) => p.status === "pending");
  const label = (k: string) => d.options.find((o) => o.key === k)?.label ?? k;
  const operator = access.mode === "answer";

  useEffect(() => {
    if (!operator) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "a") (e.preventDefault(), void api.decisions.approve(d.id, pending[0].id));
      if (e.key === "r") (e.preventDefault(), void api.decisions.reject(d.id, pending[0].id));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  return (
    <div className="mt-5 border border-accent-ink/40 bg-accent/[0.06]">
      <div className="flex h-8 items-center gap-2 border-b border-accent-ink/25 px-3">
        <span className="size-1.5 bg-accent-ink" />
        <Hud className="text-2xs text-accent-ink">{pending.length === 1 ? "Proposal" : `${pending.length} proposals`}</Hud>
        <span className="ml-auto font-mono text-2xs text-ink/45">{operator ? "needs your approval" : "waiting for an operator"}</span>
      </div>
      {pending.map((p, i) => {
        const own = p.login === user.login;
        return (
          <div key={p.id} className={cn("flex gap-3 px-3 py-3", i > 0 && "border-t border-accent-ink/20", phone ? "flex-col" : "items-center")}>
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <Avatar login={p.login} size={22} />
              <div className="min-w-0">
                <div className="text-sm">
                  <span className="font-semibold">{own ? "You" : p.login}</span> <span className="text-ink/60">{own ? "propose" : "proposes"}</span>{" "}
                  <span className="font-semibold">{label(p.option)}</span>
                  {p.option === d.recommended && <span className="ml-1.5 border border-line px-1 align-[2px] font-mono text-[9px] uppercase tracking-[0.12em] text-ink/60">rec</span>}
                </div>
                {p.note && <p className="mt-0.5 text-sm italic text-ink/65">“{p.note}”</p>}
                <div className="mt-0.5 font-mono text-2xs text-ink/40">{ago(p.at)} ago</div>
              </div>
            </div>
            {operator && (
              <div className={cn("flex shrink-0 gap-2", phone && "grid grid-cols-2")}>
                <Button size={phone ? "lg" : "md"} variant="primary" icon={CheckIcon} onClick={() => void api.decisions.approve(d.id, p.id)}>
                  Approve {!phone && i === 0 && <Kbd keys="a" className="ml-1 [&_kbd]:border-inv/30 [&_kbd]:bg-inv/10 [&_kbd]:text-inv" />}
                </Button>
                <Button size={phone ? "lg" : "md"} variant="secondary" icon={XIcon} onClick={() => void api.decisions.reject(d.id, p.id)}>
                  Reject {!phone && i === 0 && <Kbd keys="r" className="ml-1" />}
                </Button>
              </div>
            )}
            {own && (
              <Button size="sm" variant="ghost" onClick={() => void api.decisions.withdraw(d.id, p.id)}>
                Withdraw
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
