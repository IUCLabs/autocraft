import { useState } from "react";
import { CheckIcon, SpinnerIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ConversationCard } from "../../api/types";
import { Button } from "../atoms/Button";
import { TimeAgo } from "../atoms/TimeAgo";
import { cn } from "../cn";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * An action Opus proposed. A card with `settles` is a resolution (title, steps, what it settles, then the buttons);
 * a card without it is a smaller, quieter single action. Props only: the caller runs the calls.
 */
export function OpusCard({ card: a, operator, onRun, onDismiss, className }: {
  card: ConversationCard;
  operator: boolean;
  /** Runs the card; `text` is the edited comment when it differs from the proposed one. */
  onRun: (text?: string) => Promise<unknown>;
  onDismiss: () => Promise<unknown>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A card that writes to GitHub needs a second press, like the decision page.
  const [armed, setArmed] = useState(false);
  const proposed = a.state === "proposed";
  const resolution = a.settles !== undefined;

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
      setEditing(false);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const run = () => {
    if (a.writes && !armed) return setArmed(true);
    setArmed(false);
    return act(() => onRun(editing && text !== a.text ? text : undefined));
  };
  const btn = "max-md:h-11";

  return (
    <div
      className={cn(
        "rounded-md border",
        resolution ? "border-line-strong bg-raised px-3 py-3" : "border-line px-2.5 py-2",
        a.state === "dismissed" && "border-line bg-transparent",
        className,
      )}
    >
      <div className={cn("flex items-start gap-1.5 font-medium", resolution ? "text-sm" : "text-xs")}>
        {a.state === "done" && <CheckIcon className="mt-0.5 shrink-0 text-ok" />}
        {a.state === "failed" && <WarningCircleIcon className="mt-0.5 shrink-0 text-bad" />}
        {a.state === "running" && <SpinnerIcon className="mt-0.5 shrink-0 animate-spin text-ink/50" />}
        <span className={cn("min-w-0 flex-1 break-words", a.state === "dismissed" && "font-normal text-ink/45 line-through")}>{a.title}</span>
        {a.state === "done" && <span className="shrink-0 text-xs font-normal text-ok">Done</span>}
        {a.state === "failed" && <span className="shrink-0 text-xs font-normal text-bad">Failed</span>}
        {a.state === "running" && <span className="shrink-0 text-xs font-normal text-ink/55">Running…</span>}
        {a.state === "dismissed" && <span className="shrink-0 text-xs font-normal text-ink/45">Dismissed</span>}
      </div>
      {resolution && proposed && a.steps.length > 0 && (
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-sm leading-5 text-ink/80 marker:text-ink/40">
          {a.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )}
      {resolution && proposed && <p className="mt-2 text-xs text-ink/60">{a.settles}</p>}
      {a.text !== undefined && a.state !== "dismissed" &&
        (editing ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            aria-label="Comment text"
            className="mt-2 block w-full resize-none rounded border border-line bg-sunken px-2.5 py-2 text-sm leading-5 outline-none focus:border-accent/60"
          />
        ) : (
          <blockquote className={cn("mt-2 whitespace-pre-wrap border-l-2 border-line-strong pl-3 leading-5 text-ink/75", resolution ? "text-sm" : "text-xs")}>{a.text}</blockquote>
        ))}
      {a.state === "failed" && a.error && <p className="mt-2 text-xs text-bad">{a.error}</p>}
      {a.state === "done" && a.done && (
        <p className="mt-2 text-xs text-ink/55">
          {a.done.link ? (
            <a href={a.done.link} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
              {a.done.label}
            </a>
          ) : (
            a.done.label
          )}{" "}
          · <TimeAgo iso={a.done.at} />
          {a.by ? ` · ${a.by}` : ""}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-bad">{error}</p>}
      {proposed && operator && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={resolution ? "primary" : "secondary"}
            className={cn(btn, armed && "border-bad bg-bad text-white hover:bg-bad/90")}
            disabled={busy}
            onClick={() => void run()}
          >
            {armed ? `Confirm: ${a.writes}` : a.label}
          </Button>
          {armed && (
            <Button size="sm" variant="ghost" className={btn} disabled={busy} onClick={() => setArmed(false)}>
              Cancel
            </Button>
          )}
          {editing ? (
            <Button size="sm" variant="ghost" className={btn} disabled={busy} onClick={() => { setEditing(false); setText(a.text ?? ""); }}>
              Cancel
            </Button>
          ) : (
            a.text !== undefined && (
              <Button size="sm" variant="secondary" className={btn} disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </Button>
            )
          )}
          <Button size="sm" variant="ghost" className={btn} disabled={busy} onClick={() => void act(onDismiss)}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
