import { useRef, useState, type KeyboardEvent } from "react";
import { BellIcon, BellSlashIcon, XIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import type { ConversationCard, Decision, User } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { cn } from "../../ui/cn";
import { canActOn } from "../decisions/DecisionDetail";
import { localActions, useAnswer } from "../decisions/state";
import { useWorkflow } from "../decisions/Workflow";

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const OTHER = "other";

/** The step that posts the card's comment: the first one that mentions a comment. */
const commentStep = (c: ConversationCard) => (c.text === undefined ? -1 : c.steps.findIndex((s) => /comment/i.test(s)));

/**
 * The outcomes of an open question as one pick-one list: the decision's options in order, outcomes only Opus offers
 * (close as completed, handled), then "Other…" with a note. Opus's draft for an option runs its steps after the option's
 * own effect; removing every step runs the plain option. Nothing is preselected.
 */
export function AnswerGroup({ d, user, resolutions, onAnswered }: { d: Decision; user: User; resolutions: ConversationCard[]; onAnswered?: () => void }) {
  const api = useApi();
  const answer = useAnswer();
  const wf = useWorkflow([d], onAnswered);
  const [sel, setSel] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [skips, setSkips] = useState<Record<number, number[]>>({});
  const [editing, setEditing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!canActOn(user, [d]) || d.answer) return null;

  const live = resolutions.filter((c) => c.state === "proposed" || c.state === "running");
  const failed = resolutions.filter((c) => c.state === "failed" && c.error);
  const draftOf = (key: string) => live.find((c) => c.option === key);
  const extras = live.filter((c) => !c.option || !d.options.some((o) => o.key === c.option));
  const suggested = live[0];
  const ids = [...d.options.map((o) => `o:${o.key}`), ...extras.map((c) => `c:${c.id}`), OTHER];

  const selected = wf.picked ? `o:${wf.picked}` : sel;
  const selOption = selected?.startsWith("o:") ? d.options.find((o) => o.key === selected.slice(2)) : undefined;
  const selExtra = selected?.startsWith("c:") ? extras.find((c) => `c:${c.id}` === selected) : undefined;
  const isOther = selected === OTHER;
  const draft = selOption ? draftOf(selOption.key) : undefined;
  const skipped = (c: ConversationCard) => skips[c.id] ?? [];
  const blocked = (c?: ConversationCard) => c?.stale === "pr-changed";
  // The card that will run: an extra row's own, or the draft of the selected option while some step remains and the PR has not changed.
  const card = selExtra ?? (draft && !blocked(draft) && skipped(draft).length < draft.steps.length ? draft : undefined);
  const plain = !!selOption && !card;
  const note = wf.notes[d.id] ?? "";

  const select = (id: string) => {
    setError(undefined);
    setArmed(false);
    setEditing(false);
    if (id.startsWith("o:")) {
      setSel(null);
      wf.choose(id.slice(2));
    } else {
      wf.clear();
      setSel(id);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (ids.indexOf(selected ?? ids[0]!) + step + ids.length) % ids.length;
    select(ids[next]!);
    refs.current[next]?.focus();
  };
  const toggleStep = (c: ConversationCard, i: number) => {
    setArmed(false);
    setSkips((s) => ({ ...s, [c.id]: skipped(c).includes(i) ? skipped(c).filter((x) => x !== i) : [...skipped(c), i] }));
  };

  const text = card ? (texts[card.id] ?? card.text) : undefined;
  const writes = card ? card.writes : plain ? wf.writes : null;
  const needsConfirm = !!writes;
  const label = isOther ? "Mark handled" : card ? card.label : plain ? `Answer "${selOption!.label}"` : "";
  const confirming = card ? armed : plain ? wf.isArmed : false;

  const run = async () => {
    setError(undefined);
    if (needsConfirm && !confirming) return card ? setArmed(true) : void wf.submit();
    setArmed(false);
    setBusy(true);
    try {
      if (card) {
        if (text !== undefined && text !== card.text) await api.conversations.editCard(card.id, text);
        const skip = skipped(card);
        await api.conversations.doCard(card.id, skip.length ? { skip } : undefined);
        onAnswered?.();
      } else if (isOther) {
        await answer([d], "handled");
        onAnswered?.();
      } else await wf.submit();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async (c: ConversationCard) => {
    setError(undefined);
    try {
      await api.conversations.dismissCard(c.id);
      if (sel === `c:${c.id}`) setSel(null);
    } catch (e) {
      setError(message(e));
    }
  };
  const snooze = async () => {
    setError(undefined);
    setBusy(true);
    try {
      await api.decisions.snooze(d.id, !d.snoozed);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const radio = (id: string, i: number, title: string, tags: ReactNodeLike, extra?: ReactNodeLike) => {
    const on = id === selected;
    return (
      <div className="flex items-start">
        <button
          ref={(el) => void (refs.current[i] = el)}
          type="button"
          role="radio"
          aria-checked={on}
          tabIndex={on || (!selected && i === 0) ? 0 : -1}
          onClick={() => select(id)}
          className="flex min-h-9 min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-ink/[0.04] max-md:min-h-11"
        >
          <span className={cn("mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-accent" : "border-line-strong")}>
            {on && <span className="size-2 rounded-full bg-accent" />}
          </span>
          <span className="min-w-0 flex-1 text-sm font-medium">
            {title}
            {tags}
          </span>
        </button>
        {extra}
      </div>
    );
  };
  const tag = (text: string) => <span className="ml-2 text-2xs font-normal text-accent-ink">{text}</span>;

  /** The drafted steps of a card: each can be removed, and the comment can be edited. */
  const steps = (c: ConversationCard) => {
    const ci = commentStep(c);
    const showText = text !== undefined && !skipped(c).includes(ci);
    return (
      <>
        {c.steps.length > 0 && (
          <ol className="space-y-0.5 leading-5">
            {c.steps.map((s, i) => {
              const off = skipped(c).includes(i);
              return (
                <li key={i} className="flex items-start gap-1.5">
                  <span className={cn("min-w-0 flex-1 pt-1", off && "text-ink/40 line-through")}>{s}</span>
                  <button
                    type="button"
                    aria-label={off ? `Restore step: ${s}` : `Remove step: ${s}`}
                    title={off ? "Restore step" : "Remove step"}
                    disabled={busy}
                    onClick={() => toggleStep(c, i)}
                    className="flex size-7 shrink-0 items-center justify-center rounded text-ink/45 hover:bg-ink/[0.06] hover:text-ink max-md:size-11"
                  >
                    {off ? <span className="text-xs">Undo</span> : <XIcon />}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {showText &&
          (editing ? (
            <textarea
              value={text}
              onChange={(e) => setTexts((t) => ({ ...t, [c.id]: e.target.value }))}
              rows={5}
              aria-label="Comment text"
              className="block w-full resize-none rounded border border-line bg-sunken px-2.5 py-2 text-sm leading-5 outline-none focus:border-accent/60"
            />
          ) : (
            <blockquote className="whitespace-pre-wrap border-l-2 border-line-strong pl-3 leading-5 text-ink/75">{text}</blockquote>
          ))}
        {showText && (
          <Button
            size="sm"
            variant="ghost"
            className="max-md:h-11"
            disabled={busy}
            onClick={() => {
              if (editing) setTexts((t) => ({ ...t, [c.id]: c.text ?? "" }));
              setEditing(!editing);
            }}
          >
            {editing ? "Cancel edit" : "Edit"}
          </Button>
        )}
      </>
    );
  };

  const noteField = (required: boolean) => (
    <label className="flex h-8 min-w-0 items-center rounded border border-line bg-sunken px-2.5 focus-within:border-accent/60 max-md:h-11">
      <input
        value={note}
        onChange={(e) => localActions.setNote(d.id, e.target.value)}
        placeholder={required ? "Note, kept with the answer" : "Note, kept with the answer (optional)"}
        aria-label="Note"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
      />
    </label>
  );

  return (
    <div className="mt-3">
      <div role="radiogroup" aria-label={d.question} onKeyDown={onKey} className="grid gap-0.5">
        {d.options.map((o, i) => {
          const id = `o:${o.key}`;
          const on = id === selected;
          const dr = draftOf(o.key);
          const opus = !!dr && dr === suggested;
          return (
            <div key={id} className={cn("rounded-md", on && "bg-accent/[0.07]")}>
              {radio(id, i, o.label, opus ? tag("Opus suggests") : o.key === d.recommended ? tag("Recommended") : null)}
              {on && (
                <div className="space-y-2 pb-2.5 pl-9 pr-2 text-sm">
                  {(o.hint || o.writes) && (
                    <p className="text-xs text-ink/55">
                      {o.hint}
                      {o.hint && o.writes ? " · " : ""}
                      {o.writes && cap(o.writes)}
                    </p>
                  )}
                  {dr && blocked(dr) && <p className="text-xs text-warn">The PR changed since Opus wrote this</p>}
                  {dr && !blocked(dr) && dr.stale === "new-comments" && <p className="text-xs text-ink/50">New comments since</p>}
                  {dr && !blocked(dr) && steps(dr)}
                  {(plain || !dr) && noteField(false)}
                </div>
              )}
            </div>
          );
        })}
        {extras.map((c, j) => {
          const id = `c:${c.id}`;
          const on = id === selected;
          const i = d.options.length + j;
          return (
            <div key={id} className={cn("rounded-md", on && "bg-accent/[0.07]")}>
              {radio(
                id,
                i,
                c.title,
                c === suggested ? tag("Opus suggests") : null,
                <button
                  type="button"
                  aria-label={`Dismiss: ${c.title}`}
                  title="Dismiss"
                  disabled={busy || c.state === "running"}
                  onClick={() => void dismiss(c)}
                  className="flex size-9 shrink-0 items-center justify-center rounded text-ink/45 hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40 max-md:size-11"
                >
                  <XIcon />
                </button>,
              )}
              {on && (
                <div className="space-y-2 pb-2.5 pl-9 pr-2 text-sm">
                  {c.settles && <p className="text-xs text-ink/55">{c.settles}</p>}
                  {c.stale === "new-comments" && <p className="text-xs text-ink/50">New comments since</p>}
                  {steps(c)}
                </div>
              )}
            </div>
          );
        })}
        <div className={cn("rounded-md", isOther && "bg-accent/[0.07]")}>
          {radio(OTHER, ids.length - 1, "Other…", null)}
          {isOther && <div className="space-y-2 pb-2.5 pl-9 pr-2">{noteField(true)}</div>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {selected && (card || plain || isOther) && (
          <>
            <Button
              variant="primary"
              className={cn("max-md:h-11", confirming && "border-bad bg-bad text-white hover:bg-bad/90")}
              loading={busy}
              disabled={(isOther && !note.trim()) || card?.state === "running"}
              onClick={() => void run()}
            >
              {confirming ? `Confirm: ${writes}` : label}
            </Button>
            {confirming && (
              <Button variant="ghost" className="max-md:h-11" onClick={() => (card ? setArmed(false) : wf.setArmed(null))}>
                Cancel
              </Button>
            )}
          </>
        )}
        {d.snoozed ? (
          <>
            <span className="text-sm text-ink/60">Snoozed until new activity</span>
            <Button variant="secondary" icon={BellIcon} className="max-md:h-11" disabled={busy} onClick={() => void snooze()}>
              Wake
            </Button>
          </>
        ) : (
          <Button variant="secondary" icon={BellSlashIcon} className="max-md:h-11" disabled={busy} onClick={() => void snooze()}>
            Snooze
          </Button>
        )}
      </div>
      <ErrorLine error={error} className="mt-2" />
      {failed.map((c) => (
        <ErrorLine key={c.id} error={`${c.title}: ${c.error}`} className="mt-2" />
      ))}
    </div>
  );
}

type ReactNodeLike = import("react").ReactNode;
