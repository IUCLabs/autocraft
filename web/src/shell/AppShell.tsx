import { lazy, Suspense, useMemo, useState } from "react";
import { Navigate, NavLink, Route, Routes, matchPath, useLocation, useNavigate, useParams } from "react-router-dom";
import { Dialog, DropdownMenu } from "radix-ui";
import { SignOutIcon, MonitorIcon, MoonIcon, DotsThreeIcon, SidebarSimpleIcon, MagnifyingGlassIcon, SunIcon, KeyboardIcon, XIcon, CheckIcon } from "@phosphor-icons/react";
import { modules } from "../registry";
import { can, roleLabel } from "../registry/permissions";
import type { NavEntry, Permission, RouteDef } from "../registry/types";
import { useUser } from "./UserContext";
import { Workspace } from "./Workspace";
import { useIsPhone } from "./useMedia";
import { useTheme, type ThemePref } from "./theme";
import { usePref } from "./layoutStorage";
import { useHotkeys, useActiveShortcuts } from "./keyboard";
import { SearchBox } from "./SearchBox";
import { Avatar } from "../ui/Avatar";
import { Kbd } from "../ui/Kbd";
import { Logo } from "../ui/Logo";
import { Badge, type Tone } from "../ui/Badge";
import { cn } from "../ui/cn";
import { useApi, useQuery } from "../api/client";
import { useLiveStatus, type LiveStatus } from "../api/live";
import { num } from "../lib/format";

// Mockup builds only; a normal build drops this branch and the fixture data with it.
const MockRoleMenu = import.meta.env.VITE_MOCK === "1" ? lazy(() => import("../api/mock/MockRoleMenu")) : null;

const GROUPS: { id: NavEntry["group"]; label: string }[] = [
  { id: "work", label: "" },
  { id: "insight", label: "Insight" },
  { id: "operator", label: "Operations" },
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
  const hiddenPaths = useMemo(() => modules.filter((m) => !can(user, m.permission)).flatMap((m) => m.routes.map((r) => ({ path: r.path, permission: m.permission }))), [user]);

  useHotkeys({
    "/": () => (phone ? setSearchOpen(true) : document.getElementById("global-search")?.focus()),
    "mod+k": () => (phone ? setSearchOpen(true) : document.getElementById("global-search")?.focus()),
    "?": () => setHelp(true),
    "[": () => setRailOpen(!railOpen),
    "g h": () => navigate("/"),
    "g d": () => navigate("/decisions"),
    "g p": () => navigate("/progress"),
    "g i": () => navigate("/items"),
    "g q": () => navigate("/queue"),
  });

  const content = (
    <Routes>
      {routes.map((r) => (
        <Route key={r.path} path={r.path} element={<RouteView route={r} />} />
      ))}
      <Route path="work" element={<RedirectTo to="/queue" />} />
      <Route path="merge-queue" element={<RedirectTo to="/queue/merge" />} />
      <Route path="*" element={<NoRoute hidden={hiddenPaths} />} />
    </Routes>
  );

  if (phone) {
    return (
      <div className="flex h-full flex-col bg-panel">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-bg pl-4 pr-1.5">
          <Wordmark />
          <div className="flex-1" />
          <LiveDot />
          <RoleChip />
          <button aria-label="Search" onClick={() => setSearchOpen(true)} className="flex size-11 items-center justify-center text-ink/70">
            <MagnifyingGlassIcon className="text-[18px]" />
          </button>
          <UserMenu theme={theme} setTheme={setTheme} onHelp={() => setHelp(true)} />
        </header>
        <main className="min-h-0 flex-1">{content}</main>
        <PhoneTabs nav={nav} />
        <Dialog.Root open={searchOpen} onOpenChange={setSearchOpen}>
          <Dialog.Portal>
            <Dialog.Content className="fixed inset-0 z-50 flex flex-col bg-panel animate-fadeIn" aria-describedby={undefined}>
              <Dialog.Title className="sr-only">Search</Dialog.Title>
              <div className="flex items-start gap-1 border-b border-line p-2">
                <SearchBox autoFocus onPick={() => setSearchOpen(false)} fullscreen />
                <Dialog.Close className="flex size-11 shrink-0 items-center justify-center text-ink/70" aria-label="Close search">
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
      <aside className={cn("flex shrink-0 flex-col border-r border-line bg-bg transition-[width] duration-base ease-out", railOpen ? "w-[220px]" : "w-[52px]")}>
        <div className={cn("flex h-11 shrink-0 items-center px-4", !railOpen && "justify-center px-0")}>{railOpen ? <Wordmark /> : <Logo size={20} />}</div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3 pt-1" aria-label="Main">
          {GROUPS.map((g) => {
            const entries = nav.filter((n) => n.group === g.id);
            if (!entries.length) return null;
            return (
              <div key={g.id} className="mb-3">
                {railOpen && g.label && <div className="px-2 pb-1 pt-2 text-2xs font-medium text-ink/45">{g.label}</div>}
                {entries.map((n) => (
                  <RailLink key={n.to} entry={n} open={railOpen} />
                ))}
              </div>
            );
          })}
        </nav>
        <RunMeter open={railOpen} />
        <div className={cn("flex items-center border-t border-line p-2", !railOpen && "justify-center")}>
          <button onClick={() => setRailOpen(!railOpen)} className="flex size-7 items-center justify-center text-ink/50 hover:bg-ink/[0.06] hover:text-ink" aria-label={railOpen ? "Collapse sidebar" : "Expand sidebar"} title="Toggle sidebar  [">
            <SidebarSimpleIcon className="text-[15px]" />
          </button>
          {railOpen && (
            <button onClick={() => setHelp(true)} className="ml-auto flex h-7 items-center gap-2 px-2 text-xs text-ink/50 hover:bg-ink/[0.06] hover:text-ink">
              Shortcuts <Kbd keys="?" />
            </button>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-bg pl-4 pr-2">
          <Breadcrumb routes={routes} />
          <div className="mx-auto w-full max-w-[440px]">
            <SearchBox />
          </div>
          <LiveDot />
          <LiveCounters />
          <RoleChip />
          <ThemeSwitch theme={theme} setTheme={setTheme} />
          <UserMenu theme={theme} setTheme={setTheme} onHelp={() => setHelp(true)} />
        </header>
        <main className="min-h-0 flex-1 bg-panel">{content}</main>
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

const LIVE_DOT: Record<LiveStatus, [label: string, color: string]> = {
  open: ["Live", "bg-[#22e05a]"],
  connecting: ["Reconnecting", "bg-warn"],
  down: ["Offline", "bg-bad"],
};

/** The state of the server's event stream, as a colour and a tooltip. */
function LiveDot() {
  const [label, color] = LIVE_DOT[useLiveStatus()];
  return <span role="img" aria-label={label} title={label} className={cn("inline-block size-2 shrink-0 rounded-full", color)} />;
}

function Wordmark() {
  return (
    <NavLink to="/" className="flex items-center gap-2" aria-label="AutoCraft home">
      <Logo size={20} />
      <span className="text-sm font-semibold">AutoCraft</span>
    </NavLink>
  );
}

function RailLink({ entry, open }: { entry: NavEntry; open: boolean }) {
  const count = entry.useBadge?.();
  const cls = (isActive: boolean) =>
    cn(
      "relative flex h-7 items-center gap-2 rounded px-2 text-sm text-ink/70 transition-colors duration-fast hover:bg-ink/[0.06] hover:text-ink",
      isActive && "bg-ink/[0.08] font-medium text-ink",
      !open && "justify-center px-0",
    );
  const inner = (
    <>
      <entry.icon className="text-[15px] opacity-80" />
      {open && <span className="flex-1 truncate">{entry.label}</span>}
      {open && count !== undefined && count > 0 && <span className="num text-xs text-ink/50">{count}</span>}
      {!open && count !== undefined && count > 0 && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />}
    </>
  );
  return (
    <NavLink to={entry.to} end={entry.to === "/"} title={open ? undefined : entry.label} className={({ isActive }) => cls(isActive)}>
      {inner}
    </NavLink>
  );
}

function PhoneTabs({ nav }: { nav: NavEntry[] }) {
  const tabs = nav.filter((n) => n.phoneTab).slice(0, 3);
  const rest = nav.filter((n) => !n.phoneTab);
  const loc = useLocation();
  const moreActive = rest.some((n) => (n.to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(n.to)));
  return (
    <nav aria-label="Main" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, 1fr)` }} className="grid shrink-0 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)]">
      {tabs.map((n) => (
        <PhoneTab key={n.to} entry={n} />
      ))}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={cn("flex h-14 flex-col items-center justify-center gap-0.5 rounded-none text-2xs font-medium text-ink/55", moreActive && "text-accent-ink")}>
          <DotsThreeIcon className="text-[20px]" />
          More
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="end" sideOffset={4} className={menuCls}>
            {rest.map((n) => (
              <DropdownMenu.Item key={n.to} asChild>
                <NavLink to={n.to} className={cn(itemCls, "h-11")}>
                  <n.icon className="text-ink/55" /> {n.label}
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
    <NavLink to={entry.to} end={entry.to === "/"} className={({ isActive }) => cn("relative flex h-14 flex-col items-center justify-center gap-0.5 text-2xs font-medium text-ink/55", isActive && "text-accent-ink")}>
      <span className="relative">
        <entry.icon className="text-[20px]" />
        {count !== undefined && count > 0 && <span className="num absolute -right-3.5 -top-1 rounded-full bg-accent px-1 text-[10px] font-semibold leading-[14px] text-white">{count}</span>}
      </span>
      {entry.label}
    </NavLink>
  );
}

function RedirectTo({ to }: { to: string }) {
  return <Navigate to={`${to}${useLocation().search}`} replace />;
}

function Breadcrumb({ routes }: { routes: RouteDef[] }) {
  const loc = useLocation();
  const first = loc.pathname.split("/")[1] ?? "";
  const r = routes.find((x) => x.path.split("/")[0] === first);
  const rest = decodeURIComponent(loc.pathname.split("/").slice(2).join("/"));
  const isItem = (first === "item" || first === "items") && rest.includes("/");
  return (
    <div className="flex w-[200px] shrink-0 items-center gap-1.5 truncate text-sm">
      <span className="font-medium">{isItem ? "Item" : (r?.view.title ?? "")}</span>
      {isItem && (
        <>
          <span className="text-ink/35">/</span>
          <span className="code truncate text-ink/60">{rest.replace("/", "#")}</span>
        </>
      )}
    </div>
  );
}

function LiveCounters() {
  const { data } = useQuery("progress", (api) => api.progress());
  if (!data) return null;
  const lastHour = data.perHourPipeline[data.perHourPipeline.length - 1] ?? 0;
  return (
    <div className="hidden shrink-0 items-center gap-3 whitespace-nowrap text-xs text-ink/60 xl:flex">
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-warn" />
        <span className="num font-medium text-ink">{data.decisionsOpen}</span> waiting
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-ok" />
        <span className="num font-medium text-ink">{lastHour}</span> done by the pipeline in the last hour
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
  const cur = THEMES.find((t) => t.v === theme)!;
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  return (
    <button onClick={() => setTheme(next.v)} className="flex size-8 shrink-0 items-center justify-center text-ink/60 hover:bg-ink/[0.06] hover:text-ink" aria-label={`Theme: ${cur.label}. Switch to ${next.label}`} title={`Theme: ${cur.label}`}>
      <cur.icon className="text-[15px]" />
    </button>
  );
}

const menuCls = "z-50 min-w-[220px] rounded-md border border-line-strong bg-raised p-1 shadow-[0_12px_32px_rgba(0,0,0,0.28)] animate-rise";
const itemCls = "flex h-8 cursor-default items-center gap-2.5 rounded px-2 text-sm outline-none data-[highlighted]:bg-ink/[0.07]";
const labelCls = "px-2 pb-1 pt-2 text-2xs font-medium text-ink/45";

function UserMenu({ theme, setTheme, onHelp }: { theme: ThemePref; setTheme: (t: ThemePref) => void; onHelp?: () => void }) {
  const user = useUser();
  const api = useApi();
  const navigate = useNavigate();
  const adminLinks = modules.filter((m) => m.nav?.group === "operator" && can(user, m.permission));
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="flex size-9 items-center justify-center rounded-full hover:bg-ink/[0.06]" aria-label={`Signed in as ${user.login}`}>
        <Avatar login={user.login} size={24} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={cn(menuCls, "w-[248px]")}>
          <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
            <Avatar login={user.login} size={32} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{user.login}</div>
              <div className="text-xs text-ink/55">
                {roleLabel(user)} · write on {user.writeRepos.length} repos
              </div>
            </div>
          </div>
          <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-line" />
          <DropdownMenu.Label className={labelCls}>Theme</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
            {THEMES.map((t) => (
              <DropdownMenu.RadioItem key={t.v} value={t.v} className={itemCls}>
                <t.icon className="text-ink/55" />
                <span className="flex-1">{t.label}</span>
                <DropdownMenu.ItemIndicator>
                  <CheckIcon className="text-accent-ink" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {adminLinks.length > 0 && (
            <>
              <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-line" />
              {adminLinks.map((m) => {
                const Icon = m.nav!.icon;
                return (
                  <DropdownMenu.Item key={m.id} onSelect={() => navigate(m.nav!.to)} className={itemCls}>
                    <Icon className="text-ink/55" /> {m.nav!.label}
                  </DropdownMenu.Item>
                );
              })}
            </>
          )}
          {MockRoleMenu && (
            <Suspense fallback={null}>
              <MockRoleMenu itemCls={itemCls} labelCls={labelCls} />
            </Suspense>
          )}
          <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-line" />
          <DropdownMenu.Item onSelect={() => onHelp?.()} className={itemCls}>
            <KeyboardIcon className="text-ink/55" /> <span className="flex-1">Keyboard shortcuts</span> <Kbd keys="?" />
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void api.signOut()} className={itemCls}>
            <SignOutIcon className="text-ink/55" /> Sign out
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
    { id: "help", keys: "?", label: "Keyboard shortcuts", group: "Anywhere" },
    { id: "rail", keys: "[", label: "Toggle sidebar", group: "Anywhere" },
    ...global,
    ...local,
  ];
  const groups = [...new Set(all.map((c) => c.group))];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 animate-fadeIn" />
        <Dialog.Content className="fixed left-1/2 top-[12vh] z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-line-strong bg-raised shadow-[0_24px_64px_rgba(0,0,0,0.35)] animate-rise" aria-describedby={undefined}>
          <div className="flex h-11 items-center justify-between border-b border-line px-4">
            <Dialog.Title className="text-sm font-semibold">Keyboard shortcuts</Dialog.Title>
            <Dialog.Close className="flex size-7 items-center justify-center text-ink/50 hover:text-ink" aria-label="Close">
              <XIcon />
            </Dialog.Close>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 p-4">
            {groups.map((g) => (
              <div key={g}>
                <div className="mb-1 text-xs font-semibold text-ink/55">{g}</div>
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
  const ours = data.done.mergedByPipeline + data.done.closedByPipeline;
  const f = data.funnel;
  return (
    <NavLink to="/progress" className="mx-2 mb-2 block rounded-md border border-line p-2.5 hover:border-line-strong">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-ink/80">Classified</span>
        <span className="num text-ink/55">{f.open ? Math.round((f.classified / f.open) * 100) : 0}%</span>
      </div>
      <div className="mt-2 flex h-1 gap-px overflow-hidden rounded-full bg-ink/10">
        <div className="bg-c1" style={{ width: `${f.open ? (f.classified / f.open) * 100 : 0}%` }} />
      </div>
      <div className="num mt-1.5 text-2xs text-ink/50">
        {num(f.open)} open · {ours ? `${num(ours)} done by the pipeline` : "pipeline not started yet"}
      </div>
    </NavLink>
  );
}

/** A page this reader's role doesn't open says so; anything else is unknown. */
function NoRoute({ hidden }: { hidden: { path: string; permission: Permission }[] }) {
  const { pathname } = useLocation();
  const found = hidden.find((h) => matchPath({ path: `/${h.path}`, end: false }, pathname));
  const text = !found ? "Nothing here." : found.permission === "staff" ? "Operators and maintainers only." : "Operators only.";
  return <div className="p-8 text-ink/60">{text}</div>;
}

/** The reader's role decides what every button means, so it stays visible. */
function RoleChip() {
  const user = useUser();
  const tone: Tone = user.role === "operator" ? "accent" : "neutral";
  return (
    <span className="inline-flex shrink-0" title="Your role on this dashboard">
      <Badge tone={tone}>{roleLabel(user)}</Badge>
    </span>
  );
}
