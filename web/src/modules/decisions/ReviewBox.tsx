import { useState } from "react";
import { useApi } from "../../api/client";
import type { Decision } from "../../api/types";
import { Button } from "../../ui/Button";

/**
 * Feedback for everyone signed in, like a GitHub review: text and an optional suggested
 * answer. A suggestion is stored as an opinion; text alone goes to the thread. It never answers.
 */
export function ReviewBox({ d, className }: { d: Decision; className?: string }) {
  const api = useApi();
  const [body, setBody] = useState("");
  const [option, setOption] = useState("");
  const [busy, setBusy] = useState(false);
  const canSuggest = !d.answer;
  const ready = !!body.trim() || (canSuggest && !!option);
  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      if (canSuggest && option) await api.decisions.opine(d.id, { option, note: body.trim() || undefined });
      else await api.decisions.comment(d.id, body.trim());
      setBody("");
      setOption("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={className}>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        rows={3}
        placeholder="Leave a comment"
        aria-label="Comment"
        className="block w-full resize-none rounded border border-line bg-sunken px-2.5 py-2 text-sm outline-none placeholder:text-ink/40 focus:border-accent/60"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canSuggest && (
          <label className="flex min-w-0 items-center gap-1.5 text-xs text-ink/60">
            Suggested answer
            <select value={option} onChange={(e) => setOption(e.target.value)} className="h-8 min-w-0 rounded border border-line bg-sunken px-1.5 text-xs text-ink max-md:h-11">
              <option value="">None</option>
              {d.options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button size="sm" variant="secondary" className="ml-auto max-md:h-11" loading={busy} disabled={!ready} onClick={() => void send()}>
          Comment
        </Button>
      </div>
    </div>
  );
}
