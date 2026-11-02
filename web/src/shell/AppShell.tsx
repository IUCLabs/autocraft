import { useMemo, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate, useParams, Navigate } from "react-router-dom";
import { Dialog, DropdownMenu } from "radix-ui";
import {
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  SearchIcon,
  SunIcon,
  KeyboardIcon,
  XIcon,
} from "lucide-react";
import { modules } from "../registry";
import { can, roleLabel } from "../registry/permissions";
import { mockRole, setMockRole } from "../api/mock/mockApi";
import type { MockRole } from "../api/mock/fixtures";
import type { NavEntry, RouteDef } from "../registry/types";
import { useUser } from "./UserContext";
import { Workspace } from "./Workspace";
import { useIsPhone } from "./useMedia";
import { useTheme, type ThemePref } from "./theme";
import { usePref } from "./layoutStorage";
import { useHotkeys, useActiveShortcuts } from "./keyboard";
import { SearchBox } from "./SearchBox";
import { Avatar } from "../ui/Avatar";
import { Kbd } from "../ui/Kbd";
import { Hud } from "../ui/Hud";
import { cn } from "../ui/cn";
import { useApi, useQuery } from "../api/client";

const GROUPS: { id: NavEntry["group"]; label: string }[] = [
  { id: "work", label: "Work" },
  { id: "insight", label: "Insight" },
  { id: "operator", label: "Operator" },
];

export function AppShell() {
  const user = useUser();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [railOpen, setRailOpen] = usePref(user.login, "rail-open", true);
  const [help, setHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const visible = useMemo(() => modules.filter((m) => can(user, m.permission)), [user]);
  const nav = visible.flatMap((m) => (m.nav ? [m.nav] : [])).sort((a, b) => a.order - b.order);
  const routes = visible.flatMap((m) => m.routes);

  useHotkeys({
    "/": () => (phone ? setSearchOpen(true) : document.getElementById("global-search")?.focus()),
    "mod+k": () => (phone ? setSearchOpen(true) : document.getElementById("global-search")?.focus()),
    "?": () => setHelp(true),
    "[": () => setRailOpen(!railOpen),
    "g d": () => navigate("/decisions"),
    "g p": () => navigate("/progress"),
  });

  const content = (
    <Routes>
      <Route path="/" element={<Navigate to="/decisions" replace />} />
      {routes.map((r) => (
        <Route key={r.path} path={r.path} element={<RouteView route={r} />} />
      ))}
      <Route path="*" element={<div className="p-8 text-ink/60">Nothing here.</div>} />
    </Routes>
  );

  if (phone) {
    return (
      <div className="flex h-full flex-col bg-bg">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-4">
          <Wordmark />
          <div className="flex-1" />
          <button aria-label="Search" onClick={() => setSearchOpen(true)} className="flex size-11 items-center justify-center text-ink/70">
            <SearchIcon />
          </button>
          <UserMenu theme={theme} setTheme={setTheme} />
        </header>
        <main className="min-h-0 flex-1">{content}</main>
        <PhoneTabs nav={nav} />
        <Dialog.Root open={searchOpen} onOpenChange={setSearchOpen}>
          <Dialog.Portal>
            <Dialog.Content className="fixed inset-0 z-50 flex flex-col bg-bg animate-fadeIn" aria-describedby={undefined}>
              <Dialog.Title className="sr-only">Search</Dialog.Title>
              <div className="flex items-center gap-2 border-b border-line px-3 py-2">
                <SearchBox autoFocus onPick={() => setSearchOpen(false)} fullscreen />
                <Dialog.Close className="flex size-11 items-center justify-center text-ink/70" aria-label="Close search">
                  <XIcon />
                </Dialog.Close>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    );
  }

  return (
    <div className="flex h-full bg-bg">
      <aside className={cn("flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-base ease-out", railOpen ? "w-[212px]" : "w-[52px]")}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          {railOpen ? <Wordmark /> : <Mark />}
        </div>
        <nav className="flex-1 overflow-y-auto py-3" aria-label="Main">
          {GROUPS.map((g) => {
            const entries = nav.filter((n) => n.group === g.id);
            if (!entries.length) return null;
            return (
              <div key={g.id} className="mb-4">
                {railOpen && <Hud className="block px-4 pb-1.5 text-2xs text-ink/40">{g.label}</Hud>}
                {entries.map((n) => (
                  <RailLink key={n.to} entry={n} open={railOpen} />
                ))}
              </div>
            );
          })}
        </nav>
        <RunMeter open={railOpen} />
        <div className="flex items-center border-t border-line p-1.5">
          <button onClick={() => setRailOpen(!railOpen)} className="flex size-9 items-center justify-center text-ink/50 hover:bg-ink/5 hover:text-ink" aria-label={railOpen ? "Collapse navigation" : "Expand navigation"} title="Toggle navigation  [">
            <PanelLeftIcon className="text-sm" />
          </button>
          {railOpen && (
            <button onClick={() => setHelp(true)} className="ml-auto flex h-9 items-center gap-2 px-2 text-ink/50 hover:text-ink">
              <span className="hud text-2xs">Shortcuts</span>
              <Kbd keys="?" />
            </button>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-4 border-b border-line bg-panel pl-4 pr-2">
          <Breadcrumb routes={routes} />
          <div className="mx-auto w-full max-w-[460px]">
            <SearchBox />
          </div>
          <RoleChip />
          <LiveCounters />
          <ThemeSwitch theme={theme} setTheme={setTheme} />
          <UserMenu theme={theme} setTheme={setTheme} onHelp={() => setHelp(true)} />
        </header>
        <main className="min-h-0 flex-1">{content}</main>
      </div>
      <ShortcutSheet open={help} onOpenChange={setHelp} />
    </div>
  );
}

function RouteView({ route }: { route: RouteDef }) {
  const params = useParams();
  const user = useUser();
  if (route.permission && !can(user, route.permission)) return <div className="p-8 text-ink/60">You can't open this page.</div>;
  return <Workspace view={route.view} props={{ params, user }} />;
}

function Mark() {
  return (
    <span aria-hidden className="relative flex size-6 items-center justify-center border border-ink/80">
      <span className="size-1.5 bg-accent-ink" />
    </span>
  );
}

function Wordmark() {
  return (
    <NavLink to="/decisions" className="flex items-center gap-2" aria-label="Craft Triage home">
      <Mark />
      <span className="font-display text-md leading-none tracking-[-0.03em]">Craft</span>
      <span className="hud text-2xs text-ink/50">Triage</span>
    </NavLink>
  );
}

function RailLink({ entry, open }: { entry: NavEntry; open: boolean }) {
  const count = entry.useBadge?.();
  return (
    <NavLink
      to={entry.to}
      title={open ? undefined : entry.label}
      className={({ isActive }) =>
        cn(
          "relative mx-1.5 flex h-8 items-center gap-2.5 px-2.5 text-sm text-ink/65 transition-colors duration-fast hover:bg-ink/5 hover:text-ink",
          isActive && "bg-ink/[0.07] text-ink before:absolute before:inset-y-1 before:-left-1.5 before:w-0.5 before:bg-ink",
          !open && "justify-center px-0",
        )
      }
    >
      <entry.icon className="text-sm" />
      {open && <span className="flex-1 truncate">{entry.label}</span>}
      {open && count !== undefined && count > 0 && <span className="font-mono text-2xs text-warn">{count}</span>}
      {!open && count !== undefined && count > 0 && <span className="absolute right-1.5 top-1.5 size-1.5 bg-warn" />}
    </NavLink>
  );
}

function PhoneTabs({ nav }: { nav: NavEntry[] }) {
  const tabs = nav.filter((n) => n.phoneTab).slice(0, 3);
  const rest = nav.filter((n) => !n.phoneTab);
  const loc = useLocation();
  const moreActive = rest.some((n) => loc.pathname.startsWith(n.to));
  return (
    <nav aria-label="Main" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)` }} className="grid shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]">
      {tabs.map((n) => (
        <PhoneTab key={n.to} entry={n} />
      ))}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={cn("flex h-14 flex-col items-center justify-center gap-1 rounded-none text-ink/55", moreActive && "text-ink")}>
          <MoreHorizontalIcon className="text-md" />
          <span className="hud text-2xs">More</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="end" sideOffset={4} className="z-50 min-w-[220px] border border-line bg-raised py-1 animate-rise">
            {rest.map((n) => (
              <DropdownMenu.Item key={n.to} asChild>
                <NavLink to={n.to} className="flex h-11 items-center gap-3 px-4 text-sm outline-none data-[highlighted]:bg-ink/5">
                  <n.icon className="text-ink/60" /> {n.label}
                </NavLink>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </nav>
  );
}

function PhoneTab({ entry }: { entry: NavEntry }) {
  const count = entry.useBadge?.();
  return (
    <NavLink to={entry.to} className={({ isActive }) => cn("relative flex h-14 flex-col items-center justify-center gap-1 text-ink/55", isActive && "text-ink after:absolute after:inset-x-6 after:top-0 after:h-0.5 after:bg-ink")}>
      <span className="relative">
        <entry.icon className="text-md" />
        {count !== undefined && count > 0 && <span className="absolute -right-3 -top-1.5 bg-warn px-1 font-mono text-[9px] font-bold leading-[13px] text-black">{count}</span>}
      </span>
      <span className="hud text-2xs">{entry.label}</span>
    </NavLink>
  );
}

function Breadcrumb({ routes }: { routes: RouteDef[] }) {
  const loc = useLocation();
  const first = loc.pathname.split("/")[1] ?? "";
  const r = routes.find((x) => x.path.split("/")[0] === first);
  const rest = decodeURIComponent(loc.pathname.split("/").slice(2).join("/"));
  return (
    <div className="flex w-[220px] shrink-0 items-center gap-2 truncate">
      <Hud className="text-ink">{r?.view.title ?? ""}</Hud>
      {rest && first === "item" && <span className="ref truncate text-ink/50">/ {rest.replace("/", "#")}</span>}
    </div>
  );
}

function LiveCounters() {
  const { data } = useQuery("progress", (api) => api.progress());
  if (!data) return <div className="w-[190px]" />;
  const lastHour = data.perHour[data.perHour.length - 1];
  return (
    <div className="hidden shrink-0 items-center gap-4 xl:flex">
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 bg-warn" />
        <span className="font-mono text-xs text-ink">{data.decisionsOpen}</span>
        <span className="hud text-2xs">waiting</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 animate-pulse bg-ok" />
        <span className="font-mono text-xs text-ink">{lastHour}</span>
        <span className="hud text-2xs">done / h</span>
      </span>
    </div>
  );
}

const THEMES: { v: ThemePref; icon: typeof SunIcon; label: string }[] = [
  { v: "dark", icon: MoonIcon, label: "Dark" },
  { v: "light", icon: SunIcon, label: "Light" },
  { v: "system", icon: MonitorIcon, label: "System" },
];

function ThemeSwitch({ theme, setTheme }: { theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  return (
    <div role="radiogroup" aria-label="Theme" className="flex shrink-0 border border-line">
      {THEMES.map((t) => (
        <button
          key={t.v}
          role="radio"
          aria-checked={theme === t.v}
          aria-label={t.label}
          title={t.label}
          onClick={() => setTheme(t.v)}
          className={cn("flex size-7 items-center justify-center rounded-none text-ink/45 hover:text-ink", theme === t.v && "bg-ink text-inv hover:text-inv")}
        >
          <t.icon className="text-xs" />
        </button>
      ))}
    </div>
  );
}

function UserMenu({ theme, setTheme, onHelp }: { theme: ThemePref; setTheme: (t: ThemePref) => void; onHelp?: () => void }) {
  const user = useUser();
  const api = useApi();
  const navigate = useNavigate();
  const adminLinks = modules.filter((m) => m.nav?.group === "operator" && can(user, m.permission));
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex h-9 items-center gap-2 px-1.5 hover:bg-ink/5" aria-label={`Signed in as ${user.login}`}>
        <Avatar login={user.login} size={24} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className="z-50 w-[248px] border border-line bg-raised py-1 shadow-[0_12px_40px_rgba(0,0,0,0.4)] animate-rise">
          <div className="flex items-center gap-2.5 border-b border-line px-3 pb-2.5 pt-2">
            <Avatar login={user.login} size={32} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{user.login}</div>
              <Hud className="text-2xs">
                {roleLabel(user)} · write on {user.writeRepos.length}
              </Hud>
            </div>
          </div>
          <DropdownMenu.Label className="hud px-3 pb-1 pt-2.5 text-2xs text-ink/40">Theme</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)} className="px-1">
            {THEMES.map((t) => (
              <DropdownMenu.RadioItem key={t.v} value={t.v} className="flex h-8 cursor-default items-center gap-2.5 px-2 text-sm outline-none data-[highlighted]:bg-ink/5">
                <t.icon className="text-ink/55" />
                <span className="flex-1">{t.label}</span>
                <DropdownMenu.ItemIndicator>
                  <span className="block size-1.5 bg-ink" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {adminLinks.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Label className="hud px-3 pb-1 pt-1.5 text-2xs text-ink/40">Admin</DropdownMenu.Label>
              {adminLinks.map((m) => {
                const Icon = m.nav!.icon;
                return (
                  <DropdownMenu.Item key={m.id} onSelect={() => navigate(m.nav!.to)} className="mx-1 flex h-8 cursor-default items-center gap-2.5 px-2 text-sm outline-none data-[highlighted]:bg-ink/5">
                    <Icon className="text-ink/55" /> {m.nav!.label}
                  </DropdownMenu.Item>
                );
              })}
            </>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Label className="hud px-3 pb-1 pt-1.5 text-2xs text-warn/80">Mock · view as</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={mockRole()} onValueChange={(v) => setMockRole(v as MockRole)} className="px-1">
            {MOCK_ROLES.map(([v, l]) => (
              <DropdownMenu.RadioItem key={v} value={v} className="flex h-8 cursor-default items-center gap-2.5 px-2 text-sm outline-none data-[highlighted]:bg-ink/5">
                <span className="flex-1">{l}</span>
                <DropdownMenu.ItemIndicator>
                  <span className="block size-1.5 bg-ink" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item onSelect={() => onHelp?.()} className="mx-1 flex h-8 cursor-default items-center gap-2.5 px-2 text-sm outline-none data-[highlighted]:bg-ink/5">
            <KeyboardIcon className="text-ink/55" /> <span className="flex-1">Keyboard shortcuts</span> <Kbd keys="?" />
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void api.signOut()} className="mx-1 flex h-8 cursor-default items-center gap-2.5 px-2 text-sm text-bad outline-none data-[highlighted]:bg-bad/10">
            <LogOutIcon /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ShortcutSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const local = useActiveShortcuts();
  const global = modules.flatMap((m) => m.commands ?? []);
  const all = [
    { id: "search", keys: "/", label: "Search", group: "Anywhere" },
    { id: "help", keys: "?", label: "This sheet", group: "Anywhere" },
    { id: "rail", keys: "[", label: "Collapse or expand navigation", group: "Anywhere" },
    ...global,
    ...local,
  ];
  const groups = [...new Set(all.map((c) => c.group))];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 animate-fadeIn" />
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 border border-line bg-panel animate-rise" aria-describedby={undefined}>
          <div className="flex h-11 items-center justify-between border-b border-line px-4">
            <Dialog.Title className="hud text-ink">Keyboard</Dialog.Title>
            <Dialog.Close className="text-ink/50 hover:text-ink" aria-label="Close">
              <XIcon />
            </Dialog.Close>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-5 p-5">
            {groups.map((g) => (
              <div key={g}>
                <Hud className="mb-2 block text-2xs">{g}</Hud>
                {all
                  .filter((c) => c.group === g)
                  .map((c) => (
                    <div key={c.id} className="flex h-7 items-center justify-between gap-3 text-sm">
                      <span className="text-ink/80">{c.label}</span>
                      <Kbd keys={c.keys} />
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RunMeter({ open }: { open: boolean }) {
  const { data } = useQuery("progress", (api) => api.progress());
  if (!data || !open) return null;
  const start = Date.parse(data.runStartedAt);
  const now = Date.parse(data.now);
  const days = (now - start) / 86400_000;
  const done = data.done.mergedByPipeline + data.done.closedByPipeline + data.done.closedByOthers;
  const pct = done / (done + data.funnel.open);
  return (
    <div className="mx-3 mb-3 border border-line p-2.5">
      <div className="flex items-baseline justify-between">
        <Hud className="text-2xs">Run · day {Math.ceil(days)}</Hud>
        <span className="font-mono text-2xs text-ink/60">{Math.round(pct * 100)}%</span>
      </div>
      <div className="mt-2 flex h-1 gap-px bg-ink/10">
        <div className="bg-c1" style={{ width: `${(data.done.mergedByPipeline / (done + data.funnel.open)) * 100}%` }} />
        <div className="bg-c2" style={{ width: `${(data.done.closedByPipeline / (done + data.funnel.open)) * 100}%` }} />
        <div className="bg-ink/40" style={{ width: `${(data.done.closedByOthers / (done + data.funnel.open)) * 100}%` }} />
      </div>
      <div className="mt-1.5 font-mono text-2xs text-ink/50">
        {done.toLocaleString("en")} done · {data.funnel.open.toLocaleString("en")} open
      </div>
    </div>
  );
}

const MOCK_ROLES: [MockRole, string][] = [
  ["operator", "Operator"],
  ["maintainer", "Maintainer, proposals on"],
  ["maintainer-off", "Maintainer, proposals off"],
  ["viewer", "Viewer"],
];

/** The reader's role and what it lets them do, always visible: it decides what every button means. */
function RoleChip() {
  const user = useUser();
  const tone = user.role === "operator" ? "border-ink text-ink" : user.role === "maintainer" && user.maintainerWrites ? "border-accent-ink/60 text-accent-ink" : "border-line text-ink/55";
  return (
    <span className={cn("hidden h-6 shrink-0 items-center border px-2 font-mono text-2xs uppercase tracking-[0.12em] lg:inline-flex", tone)} title="Your role on this dashboard">
      {roleLabel(user)}
    </span>
  );
}
