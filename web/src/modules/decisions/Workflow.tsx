import { useEffect, useRef } from "react";
import type { Decision, User } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { Kbd } from "../../ui/atoms/Kbd";
import { cn } from "../../ui/cn";
import { canActOn } from "./DecisionDetail";
import { RecommendationLine } from "../../ui/molecules/RecommendationLine";
import { localActions, useAnswer, useArmed, useLocal, userSelection } from "./state";

/** Key under which the picked option of one decision, or of a batch of checked decisions, is kept. */
const pickKey = (ds: Decision[]) => ds.map((d) => d.id).join("+");

/**
 * The operator's explicit decision for the next step, at the end of the decision content.
 * Like GitHub's "Finish your review": a radio list, a note and one submit button. Shown only
 * to people who can act. Selecting an option never submits.
 */
export function WorkflowBox({
  ds,
  user,
  phone,
  onAnswered,
  compact,
}: {
  ds: Decision[];
  user: User;
  phone?: boolean;
  onAnswered?: () => void;
  /** The item thread's "Answer directly" row: options as a wrapping row of buttons, same pick, note and confirmation. */
  compact?: boolean;
}) {
  const answer = useAnswer();
  const loc = useLocal();
  const [armed, setArmed] = useArmed();
  const noteRef = useRef<HTMLInputElement>(null);
  const d = ds[0];
  const many = ds.length > 1;
  const rec = ds.every((x) => x.recommended === d.recommended) ? d.recommended : "";
  const key = pickKey(ds);
  const picked = loc.picks[key] ?? "";
  const option = d.options.find((o) => o.key === picked);
  const operator = canActOn(user, ds);

  // The GitHub write a pick causes: the option's own, or that of a per-item exception in a batch.
  const effect = (k: string): string | null =>
    d.options.find((o) => o.key === k)?.writes ??
    Object.values(loc.overrides[d.id] ?? {}).map((x) => d.options.find((o) => o.key === x)?.writes).find(Boolean) ??
    null;
  const choose = (k: string) => {
    setArmed(null);
    localActions.setPick(key, k);
  };
  const submit = async () => {
    if (!option) return;
    if (effect(option.key) && armed !== option.key) return setArmed(option.key);
    setArmed(null);
    await answer(ds, option.key);
    localActions.setPick(key, null);
    onAnswered?.();
  };

  // Digits select an option on a decision the user opened themselves; they never submit.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!operator || d.answer || e.repeat || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName) || t.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape" && armed) return setArmed(null);
      const n = Number(e.key);
      if ((many || userSelection.id === d.id) && n >= 1 && n <= d.options.length) {
        e.preventDefault();
        choose(d.options[n - 1].key);
      }
      if (e.key === "n" && noteRef.current) {
        e.preventDefault();
        noteRef.current.focus();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  if (!operator) return null;
  if (d.answer && !many) return null;
  const title = compact ? "Answer directly" : "Workflow";

  const isArmed = !!option && armed === option.key;
  const writes = option ? effect(option.key) : null;
  const suffix = many ? ` for ${ds.length} decisions` : "";
  return (
    <section className={cn("scroll-mt-3", compact ? "mt-3" : "mt-8 rounded-md border border-line-strong bg-raised")}>
      <h2 className={cn("text-sm font-semibold", compact ? "mb-1.5 text-xs text-ink/60" : "border-b border-line px-3 py-2")}>{title}</h2>
      <div className={compact ? undefined : "px-3 py-2.5"}>
        {!many && !compact && <div className="mb-2 px-2"><RecommendationLine d={d} /></div>}
        <div role="radiogroup" aria-label={title} className={compact ? "flex flex-wrap gap-1.5" : "grid gap-0.5"}>
          {d.options.map((o, i) => {
            const on = o.key === picked;
            if (compact)
              return (
                <button
                  key={o.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={o.hint ?? (o.writes ? cap(o.writes) : undefined)}
                  onClick={() => choose(o.key)}
                  className={cn(
                    "inline-flex min-h-8 items-center gap-1.5 rounded border px-2.5 py-1 text-left text-sm transition-colors duration-fast max-md:min-h-11",
                    on ? "border-accent bg-accent/[0.1] text-ink" : "border-line-strong bg-raised text-ink/85 hover:bg-ink/[0.06]",
                  )}
                >
                  {o.label}
                  {o.key === rec && <span className="text-2xs font-normal text-accent-ink">Recommended</span>}
                </button>
              );
            return (
              <label
                key={o.key}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 hover:bg-ink/[0.04]",
                  on && "bg-accent/[0.07]",
                  phone && "min-h-11",
                )}
              >
                <input
                  type="radio"
                  name={`workflow-${key}`}
                  value={o.key}
                  checked={on}
                  onChange={() => choose(o.key)}
                  aria-keyshortcuts={String(i + 1)}
                  className="mt-1 accent-[var(--accent,theme(colors.accent))]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
                    {o.label}
                    {o.key === rec && <span className="text-2xs font-normal text-accent-ink">Recommended</span>}
                  </span>
                  {o.hint && <span className="block text-xs text-ink/55">{o.hint}</span>}
                  {o.writes && <span className="block text-xs text-ink/55">{cap(o.writes)}</span>}
                </span>
                {!phone && <Kbd keys={String(i + 1)} />}
              </label>
            );
          })}
        </div>
        <label className={cn("mt-2 flex h-8 min-w-0 items-center gap-2 rounded border border-line bg-sunken px-2.5 focus-within:border-accent/60 max-md:h-11", compact && !option && "hidden")}>
          <input
            ref={noteRef}
            value={loc.notes[d.id] ?? ""}
            onChange={(e) => localActions.setNote(d.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
            }}
            placeholder="Note, kept with the answer (optional)"
            aria-label="Note"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink/40"
          />
          {!phone && <Kbd keys="n" />}
        </label>
        <Button
          variant="primary"
          className={cn("mt-3 w-full max-md:h-11", compact && !option && "hidden", isArmed && "border-bad bg-bad text-white hover:bg-bad/90")}
          disabled={!option}
          onClick={() => void submit()}
        >
          {isArmed ? `Confirm: ${writes}${suffix}` : option ? `Submit: ${option.label}${suffix}` : "Submit"}
        </Button>
      </div>
    </section>
  );
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
