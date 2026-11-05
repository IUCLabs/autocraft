import { useRef, useState, type KeyboardEvent } from "react";
import { SpinnerIcon, XIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import type { ConversationCard, Decision, User } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { ErrorLine } from "../../ui/atoms/ErrorLine";
import { cn } from "../../ui/cn";
import { canActOn } from "../decisions/DecisionDetail";
import { localActions } from "../decisions/state";
import { useWorkflow } from "../decisions/Workflow";

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Choice = { id: string; card?: ConversationCard; option?: Decision["options"][number] };

/**
 * One pick-one group that settles an open question: Opus's resolutions first, then the decision's own options.
 * Nothing is preselected. The selected row opens in place and the one primary button under the group runs it.
 * Resolutions run through the conversation card calls, options through the workflow's own answer.
 */
export function AnswerGroup({ d, user, resolutions, onAnswered }: { d: Decision; user: User; resolutions: ConversationCard[]; onAnswered?: () => void }) {
  const api = useApi();
  const wf = useWorkflow([d], onAnswered);
  const [cardSel, setCardSel] = useState<number | null>(null);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState(false);
  const [cardArmed, setCardArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!canActOn(user, [d]) || d.answer) return null;

  const live = resolutions.filter((c) => c.state === "proposed" || c.state === "running");
  const failed = resolutions.filter((c) => c.state === "failed" && c.error);
  const rec = d.recommended;
  const choices: Choice[] = [
    ...live.map((card): Choice => ({ id: `c:${card.id}`, card })),
    ...d.options.map((option): Choice => ({ id: `o:${option.key}`, option })),
  ];
  const card = wf.picked ? undefined : live.find((c) => c.id === cardSel);
  const option = wf.option;
  const selectedId = card ? `c:${card.id}` : option ? `o:${option.key}` : null;

  const select = (c: Choice) => {
    setError(undefined);
    setCardArmed(false);
    setEditing(false);
    if (c.card) {
      wf.clear();
      setCardSel(c.card.id);
    } else {
      setCardSel(null);
      wf.choose(c.option!.key);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const cur = choices.findIndex((c) => c.id === (selectedId ?? choices[0]!.id));
    const next = (cur + step + choices.length) % choices.length;
    select(choices[next]!);
    refs.current[next]?.focus();
  };

  const text = card ? (texts[card.id] ?? card.text) : undefined;
  const run = async () => {
    if (card) {
      if (card.writes && !cardArmed) return setCardArmed(true);
      setCardArmed(false);
      setBusy(true);
      setError(undefined);
      try {
        if (text !== undefined && text !== card.text) await api.conversations.editCard(card.id, text);
        await api.conversations.doCard(card.id);
        onAnswered?.();
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    } else void wf.submit();
  };
  const armed = card ? cardArmed : wf.isArmed;
  const writes = card ? card.writes : wf.writes;
  const running = !!card && card.state === "running";
  const dismiss = async (c: ConversationCard) => {
    setError(undefined);
    try {
      await api.conversations.dismissCard(c.id);
      if (cardSel === c.id) setCardSel(null);
    } catch (e) {
      setError(message(e));
    }
  };

  const row = (c: Choice, i: number) => {
    const on = c.id === selectedId;
    const k = c.card;
    const o = c.option;
    return (
      <div key={c.id} className={cn("rounded-md", on && "bg-accent/[0.07]")}>
        <div className="flex items-start">
          <button
            ref={(el) => void (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (!selectedId && i === 0) ? 0 : -1}
            onClick={() => select(c)}
            className="flex min-h-9 min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-ink/[0.04] max-md:min-h-11"
          >
            <span className={cn("mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-accent" : "border-line-strong")}>
              {on && <span className="size-2 rounded-full bg-accent" />}
            </span>
            <span className="min-w-0 flex-1 text-sm font-medium">
              {k ? k.title : o!.label}
              {o && o.key === rec && <span className="ml-2 text-2xs font-normal text-accent-ink">Recommended</span>}
              {k?.state === "running" && <SpinnerIcon className="ml-2 inline animate-spin text-ink/50" />}
            </span>
          </button>
          {k && (
            <button
              type="button"
              aria-label={`Dismiss: ${k.title}`}
              title="Dismiss"
              disabled={busy || k.state === "running"}
              onClick={() => void dismiss(k)}
              className="flex size-9 shrink-0 items-center justify-center rounded text-ink/45 hover:bg-ink/[0.06] hover:text-ink disabled:opacity-40 max-md:size-11"
            >
              <XIcon />
            </button>
          )}
        </div>
        {on && k && (
          <div className="space-y-2 pb-2.5 pl-9 pr-2 text-sm">
            {k.steps.length > 0 && (
              <ol className="list-decimal space-y-0.5 pl-4 leading-5 text-ink/80 marker:text-ink/40">
                {k.steps.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ol>
            )}
            {k.settles && <p className="text-xs text-ink/60">{k.settles}</p>}
            {text !== undefined &&
              (editing ? (
                <textarea
                  value={text}
                  onChange={(e) => setTexts((t) => ({ ...t, [k.id]: e.target.value }))}
                  rows={5}
                  aria-label="Comment text"
                  className="block w-full resize-none rounded border border-line bg-sunken px-2.5 py-2 text-sm leading-5 outline-none focus:border-accent/60"
                />
              ) : (
                <blockquote className="whitespace-pre-wrap border-l-2 border-line-strong pl-3 leading-5 text-ink/75">{text}</blockquote>
              ))}
            {text !== undefined && (
              <Button
                size="sm"
                variant="ghost"
                className="max-md:h-11"
                disabled={busy}
                onClick={() => {
                  if (editing) setTexts((t) => ({ ...t, [k.id]: k.text ?? "" }));
                  setEditing(!editing);
                }}
              >
                {editing ? "Cancel edit" : "Edit"}
              </Button>
            )}
          </div>
        )}
        {on && o && (
          <div className="space-y-2 pb-2.5 pl-9 pr-2">
            {(o.hint || o.writes) && (
              <p className="text-xs text-ink/55">
                {o.hint}
                {o.hint && o.writes ? " · " : ""}
                {o.writes && cap(o.writes)}
              </p>
            )}
            <label className="flex h-8 min-w-0 items-center rounded border border-line bg-sunken px-2.5 focus-within:border-accent/60 max-md:h-11">
              <input
                value={wf.notes[d.id] ?? ""}
                onChange={(e) => localActions.setNote(d.id, e.target.value)}
                placeholder="Note, kept with the answer (optional)"
                aria-label="Note"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
              />
            </label>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mt-3">
      <div role="radiogroup" aria-label={d.question} onKeyDown={onKey} className="grid gap-0.5">
        {choices.map((c, i) => (
          <div key={c.id} className="contents">
            {i === live.length && live.length > 0 && <div role="separator" className="my-1 border-t border-line" />}
            {row(c, i)}
          </div>
        ))}
      </div>
      {selectedId && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            className={cn("max-md:h-11", armed && "border-bad bg-bad text-white hover:bg-bad/90")}
            loading={busy}
            disabled={running}
            onClick={() => void run()}
          >
            {armed ? `Confirm: ${writes}` : card ? card.label : `Answer "${option!.label}"`}
          </Button>
          {armed && (
            <Button variant="ghost" className="max-md:h-11" onClick={() => (card ? setCardArmed(false) : wf.setArmed(null))}>
              Cancel
            </Button>
          )}
        </div>
      )}
      <ErrorLine error={error} className="mt-2" />
      {failed.map((c) => (
        <ErrorLine key={c.id} error={`${c.title}: ${c.error}`} className="mt-2" />
      ))}
    </div>
  );
}
