import type { ReactNode } from "react";

/** Scrolling page body with the app's content width. */
export function Page({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1180px] px-4 pb-12 pt-5 md:px-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-xl font-semibold">{title}</h1>
          {sub && <span className="text-sm text-ink/55">{sub}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}
