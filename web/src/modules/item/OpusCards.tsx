import { useApi } from "../../api/client";
import type { ConversationCard } from "../../api/types";
import { OpusCard } from "../../ui/organisms/OpusCard";

export function ActionCard({ a, operator, className = "ml-7 mt-2" }: { a: ConversationCard; operator: boolean; className?: string }) {
  const api = useApi();
  return (
    <OpusCard
      card={a}
      operator={operator}
      className={className}
      onRun={async (edit) => {
        if (edit) await api.conversations.editCard(a.id, edit);
        await api.conversations.doCard(a.id);
      }}
      onDismiss={() => api.conversations.dismissCard(a.id)}
    />
  );
}

/** What Opus did last, in a quiet line; the few before it show on hover or focus. Plain text only: the lines come from model-written tool inputs. */
export function Progress({ lines }: { lines?: string[] }) {
  if (!lines?.length) return null;
  const last = lines[lines.length - 1]!;
  return (
    <div className="group ml-[28px] mt-0.5 text-xs text-ink/40" tabIndex={0} aria-live="off">
      <p className="truncate" title={lines.join("\n")}>{last}</p>
      {lines.length > 1 && (
        <ul className="hidden group-hover:block group-focus:block">
          {lines.slice(0, -1).reverse().map((l, i) => (
            <li key={`${lines.length - 2 - i}:${l}`} className="truncate text-ink/30">{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
