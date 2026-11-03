import { ago } from "../../lib/format";
import { useNow } from "../../lib/useNow";

/** "3m" or "3 minutes ago"; re-renders as time passes. The tooltip shows the UTC time. */
export function TimeAgo({ iso, short = true, className }: { iso: string; short?: boolean; className?: string }) {
  useNow();
  return (
    <time dateTime={iso} title={`${iso.slice(0, 16).replace("T", " ")} UTC`} className={className}>
      {short ? ago(iso) : ago(iso, false)}
    </time>
  );
}
