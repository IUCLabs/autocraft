// The project picker at the top of the navigation: narrows every list in the app to one repo.
import { useLocation, useNavigate } from "react-router-dom";
import { setScope, useScope } from "../api/scope";
import { RepoSelect } from "../ui/molecules/RepoSelect";
import { cn } from "../ui/cn";

export const projectPath = (repo: string | null) => (repo ? `/projects/${encodeURIComponent(repo)}` : "/");

export function ScopePicker({ className }: { className?: string }) {
  const scope = useScope();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pick = (repo: string | null) => {
    setScope(repo);
    // On the projects pages the picker also moves to the picked project; elsewhere the page stays and reloads scoped.
    if (pathname === "/" || pathname.startsWith("/projects/")) navigate(projectPath(repo));
  };
  return <RepoSelect value={scope} onChange={pick} allLabel="All projects" align="start" className={cn("w-full max-w-none justify-between", scope && "border-accent-ink/50", className)} />;
}
