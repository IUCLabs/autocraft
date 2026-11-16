// "Queue items": a button on the Merge queue page that opens a dialog to add several PRs at once, one GitHub link or id per line. Each is
// pre-approved at its current head (it merges once the review there says take, the pre-merge review is clean and CI is green) and
// fast-tracked with the chosen weight. Operators only.
import { useState } from "react";
import { CheckCircleIcon, PlusIcon, XCircleIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import { useUser } from "../../shell/UserContext";
import { Button } from "../../ui/atoms/Button";
import { Textarea } from "../../ui/atoms/Textarea";
import { Dialog } from "../../ui/molecules/Dialog";
import { WeightSelect } from "./fastTrack";

type Result = { item: string; ok: boolean; text: string };

/** The non-empty lines, trimmed, each once. */
const linesOf = (text: string) => [...new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];

function QueueDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const [text, setText] = useState("");
  const [weight, setWeight] = useState(5);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const items = linesOf(text);

  const submit = async () => {
    setBusy(true);
    const out: Result[] = [];
    // One at a time, so each line gets its own answer and a refusal does not stop the rest.
    for (const item of items) {
      try {
        out.push({ item, ok: true, text: (await api.queueControl.add(item, weight)).label });
      } catch (e) {
        out.push({ item, ok: false, text: (e as Error).message });
      }
      setResults([...out]);
    }
    // What was refused stays in the box to fix and send again.
    setText(out.filter((r) => !r.ok).map((r) => r.item).join("\n"));
    setBusy(false);
  };

  return (
    <Dialog open onClose={onClose} title="Queue items">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (items.length && !busy) void submit();
        }}
      >
        <p className="text-xs text-ink/65">
          One pull request per line: a GitHub link, <span className="code">repo#123</span> or <span className="code">owner/repo#123</span>. Each merges once the review at its
          current head says take, the pre-merge review is clean and CI is green; its review, checks and merge go first by the weight.
        </p>
        <Textarea
          aria-label="Pull requests to queue, one per line"
          rows={7}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"https://github.com/storytold/designcraft/pull/1842\ndesigncraft#2122"}
          className="code text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-ink/65">
            Weight
            <WeightSelect value={weight} onChange={setWeight} />
          </label>
          <Button type="submit" size="sm" className="ml-auto max-md:h-11" loading={busy} disabled={!items.length}>
            Queue {items.length > 1 ? `${items.length} items` : "item"}
          </Button>
        </div>
        {results.length > 0 && (
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-line pt-2 text-xs">
            {results.map((r) => (
              <li key={r.item} className="flex items-start gap-1.5">
                {r.ok ? <CheckCircleIcon weight="fill" className="mt-0.5 shrink-0 text-ok" aria-label="Queued" /> : <XCircleIcon weight="fill" className="mt-0.5 shrink-0 text-bad" aria-label="Refused" />}
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="code">{r.item}</span> <span className={r.ok ? "text-ink/60" : "text-bad"}>{r.text}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </form>
    </Dialog>
  );
}

export function QueueItems() {
  const [open, setOpen] = useState(false);
  if (useUser().role !== "operator") return null;
  return (
    <>
      <Button size="sm" className="max-md:h-11" onClick={() => setOpen(true)}>
        <PlusIcon aria-hidden /> Queue items
      </Button>
      {open && <QueueDialog onClose={() => setOpen(false)} />}
    </>
  );
}
