import type { RemoteVia as Via } from "../../api/types";
import { Avatar } from "../atoms/Avatar";
import { cn } from "../cn";

/** Who ran a model call in the user-local mode: "via @login · harness · reported model". */
export function RemoteVia({ via, className }: { via: Via; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-ink/65", className)}>
      <span>via</span>
      <Avatar login={via.login} size={14} />
      <span className="font-medium text-ink/80">@{via.login}</span>
      {(via.harness || via.model) && <span>· {[via.harness, via.model].filter(Boolean).join(" · ")}</span>}
    </span>
  );
}
