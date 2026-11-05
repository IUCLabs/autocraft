import { ArrowClockwiseIcon, HourglassIcon, KeyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useApi } from "../../api/client";
import type { Decision } from "../../api/types";
import { Button } from "../../ui/atoms/Button";
import { cn } from "../../ui/cn";
import { useWrite } from "../../lib/hooks";
import { useUser } from "../../shell/UserContext";

/** Starts the GitHub App user authorization for the signed-in operator and returns to this page. The session is not touched. */
export const authorizeHref = (): string => `/auth/authorize-app?${new URLSearchParams({ return_to: window.location.pathname + window.location.search })}`;

const TONE = { pending: "text-ink/55", "waiting-token": "text-warn", "waiting-permission": "text-warn", failed: "text-bad", done: "text-ink/55" } as const;

/**
 * Where the GitHub write of an answer stands while it is not done: why it waits, with the actions that unblock it.
 * Shown under the answer on the decision and the item, and under the row in the answered list.
 */
export function ExecLine({ d, canRetry, compact }: { d: Decision; canRetry: boolean; compact?: boolean }) {
  const api = useApi();
  const write = useWrite();
  const me = useUser();
  // The write runs as the operator who answered, so only they can authorize it.
  const answerer = me.role === "operator" && d.answeredBy?.toLowerCase() === me.login.toLowerCase();
  const exec = d.exec;
  if (!exec || exec.state === "done") return null;
  const Icon = exec.state === "pending" ? HourglassIcon : WarningCircleIcon;
  const text = exec.reason ?? "Waiting to run";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", compact ? "mt-1 text-xs" : "w-full text-sm", TONE[exec.state])} onClick={(e) => e.stopPropagation()}>
      <span className="inline-flex items-center gap-1.5">
        <Icon className="shrink-0" />
        <span>{text}</span>
      </span>
      {answerer && exec.state === "waiting-token" && (
        <a href={authorizeHref()} className="inline-flex items-center gap-1 text-accent-ink hover:underline">
          <KeyIcon />
          Authorize AutoCraft to act as you
        </a>
      )}
      {canRetry && exec.state !== "pending" && (
        <Button size="sm" variant="ghost" icon={ArrowClockwiseIcon} loading={write.busy === "retry"} onClick={() => void write.run("retry", () => api.decisions.retry(d.id))}>
          Retry
        </Button>
      )}
      {write.error && <span className="text-bad">{write.error}</span>}
    </div>
  );
}
