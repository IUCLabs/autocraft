import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, matchPath, useLocation, useNavigate, useParams } from "react-router-dom";
import { Dialog, DropdownMenu } from "radix-ui";
import { SignOutIcon, MonitorIcon, MoonIcon, ListIcon, SidebarSimpleIcon, MagnifyingGlassIcon, SunIcon, KeyboardIcon, XIcon, CheckIcon, HeartbeatIcon, PlugsConnectedIcon, LinkBreakIcon, LinkIcon } from "@phosphor-icons/react";
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
import { Avatar } from "../ui/atoms/Avatar";
import { Kbd } from "../ui/atoms/Kbd";
import { Logo } from "../ui/atoms/Logo";
import { Badge, type Tone } from "../ui/atoms/Badge";
import { cn } from "../ui/cn";
import { MAIN_CI_DOT, MAIN_CI_LABEL } from "../ui/atoms/MainCiBadge";
import type { MainCiState, MainCiSummary } from "../api/types";
import { useApi, useQuery } from "../api/client";
import { HealthMenu } from "../ui/organisms/HealthMenu";
import { useLiveStatus, type LiveStatus } from "../api/live";
import { num, zoneName } from "../lib/format";
import { UnlinkDiscordDialog } from "./UnlinkDiscord";
import { LinkDiscordDialog } from "./LinkDiscord";

// Mockup builds only; a normal build drops this branch and the fixture data with it.
const MockRoleMenu = import.meta.env.VITE_MOCK === "1" ? lazy(() => import("../api/mock/MockRoleMenu")) : null;

// The rail is laid out here by path, so a module only declares its own entry. A path no module
// registers (a page the reader's role cannot open) is left out.
const RAIL: { label: string; paths: string[] }[] = [
  { label: "", paths: ["/", "/next", "/flow", "/needs", "/items", "/activity"] },
  { label: "Settings", paths: ["/repos", "/pipeline", "/accounts", "/envs", "/access", "/admin/github-app", "/admin/discord", "/audit", "/prompts"] },
  { label: "Insight", paths: ["/progress", "/cost", "/rates", "/agents", "/security/scans", "/classifiers", "/contributors", "/main-ci", "/about"] },
];
const PHONE_TABS = ["/", "/next", "/needs", "/items"];

export function AppShell() {
  const user = useUser();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [railOpen, setRailOpen] = usePref(user.login, "rail-open", true);
  const [help, setHelp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const visible = useMemo(() => modules.filter((m) => can(user, m.permission)), [user]);
  const entries = visible.flatMap((m) => (m.nav ? [m.nav] : []));
  const rail = RAIL.map((g) => ({ label: g.label, entries: g.paths.flatMap((p) => entries.filter((e) => e.to === p)) })).filter((g) => g.entries.length > 0);
  const routes = visible.flatMap((m) => m.routes);
  const hiddenPaths = useMemo(() => modules.filter((m) => !can(user, m.permission)).flatMap((m) => m.routes.map((r) => ({ path: r.path, permission: m.permission }))), [user]);

  useHotkeys({
    "/": () => (phone ? setSearchOpen(true) : document.getElementById("global-search")?.focus()),
    "mod+k": () => (phone ? setSearchOpen(true) : document.getElementById("global-search")?.focus()),
    "?": () => setHelp(true),
    "[": () => setRailOpen(!railOpen),
    "g h": () => navigate("/"),
    "g n": () => navigate("/next"),
    "g d": () => navigate("/needs"),
    "g i": () => navigate("/items"),
    "g p": () => navigate("/progress"),
  });

  const content = (
    <Routes>
      {routes.map((r) => (
        <Route key={r.path} path={r.path} element={r.path === "/" ? <OldFlowLink route={r} /> : <RouteView route={r} />} />
      ))}
      <Route path="decisions/*" element={<RedirectTo from="/decisions" to="/needs/decisions" />} />
      <Route path="decisions" element={<RedirectTo to="/needs" />} />
      <Route path="queue/merge" element={<RedirectTo to="/next/merge" />} />
      <Route path="queue/*" element={<RedirectTo to="/next" />} />
      <Route path="queue" element={<RedirectTo to="/next" />} />
      <Route path="work" element={<RedirectTo to="/next" />} />
      <Route path="merge-queue" element={<RedirectTo to="/next/merge" />} />
      <Route path="github-activity" element={<RedirectTo to="/activity" search="?kinds=write" />} />
      <Route path="*" element={<NoRoute hidden={hiddenPaths} />} />
    </Routes>
  );

  if (phone) {
    return (
      <div className="flex h-full flex-col bg-panel">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-bg pl-1 pr-1.5">
          <button id="nav-toggle" aria-label="Open navigation" onClick={() => setNavOpen(true)} className="flex size-11 shrink-0 items-center justify-center text-ink/70">
            <ListIcon className="text-[20px]" />
          </button>
          <Wordmark />
          <div className="flex-1" />
          <LiveDot />
          <HealthMenu />
          <RoleChip />
          <button aria-label="Search" onClick={() => setSearchOpen(true)} className="flex size-11 items-center justify-center text-ink/70">
            <MagnifyingGlassIcon className="text-[18px]" />
          </button>
          <UserMenu theme={theme} setTheme={setTheme} onHelp={() => setHelp(true)} />
        </header>
        <main className="min-h-0 flex-1">{content}</main>
        <PhoneTabs rail={rail} />
        <NavDrawer open={navOpen} onOpenChange={setNavOpen} rail={rail} />
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
        <RailNav rail={rail} open={railOpen} className="flex-1" />
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
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bg pl-4 pr-2">
          <Breadcrumb routes={routes} />
          <div className="mx-auto w-full max-w-[440px]">
            <SearchBox />
          </div>
          <LiveDot />
          <LiveCounters />
          <HealthMenu />
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

function RailLink({ entry, open, tall }: { entry: NavEntry; open: boolean; tall?: boolean }) {
  const count = entry.useBadge?.();
  const cls = (isActive: boolean) =>
    cn(
      "relative flex items-center gap-2 rounded px-2 text-sm",
      tall ? "h-11" : "h-7",
      "text-ink/70 transition-colors duration-fast hover:bg-ink/[0.06] hover:text-ink",
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

type RailGroup = { label: string; entries: NavEntry[] };

/** The nav rail: the desktop sidebar and the phone drawer both render this. */
function RailNav({ rail, open, className, tall }: { rail: RailGroup[]; open: boolean; className?: string; tall?: boolean }) {
  return (
    <nav className={cn("overflow-y-auto px-2 pb-3 pt-1", className)} aria-label="Main">
      {rail.map((g) => (
        <div key={g.label} className="mb-3">
          {open && g.label && <div className="px-2 pb-1 pt-2 text-2xs font-medium text-ink/45">{g.label}</div>}
          {g.entries.map((n) => (
            <RailLink key={n.to} entry={n} open={open} tall={tall} />
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Phone: the rail in a left drawer. Radix Dialog supplies the focus trap, Escape, scroll lock and focus return. */
function NavDrawer({ open, onOpenChange, rail }: { open: boolean; onOpenChange: (o: boolean) => void; rail: RailGroup[] }) {
  const { pathname } = useLocation();
  useEffect(() => onOpenChange(false), [pathname, onOpenChange]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 animate-fadeIn" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col border-r border-line bg-bg pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] animate-fadeIn" aria-describedby={undefined} onCloseAutoFocus={(e) => { e.preventDefault(); document.getElementById("nav-toggle")?.focus(); }}>
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-1.5">
            <Wordmark />
            <Dialog.Close className="flex size-11 items-center justify-center text-ink/70" aria-label="Close navigation">
              <XIcon />
            </Dialog.Close>
          </div>
          <RailNav rail={rail} open tall className="min-h-0 flex-1 overscroll-contain" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PhoneTabs({ rail }: { rail: RailGroup[] }) {
  const all = rail.flatMap((g) => g.entries);
  const tabs = PHONE_TABS.flatMap((p) => all.filter((e) => e.to === p));
  return (
    <nav aria-label="Primary" style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }} className="grid shrink-0 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)]">
      {tabs.map((n) => (
        <PhoneTab key={n.to} entry={n} />
      ))}
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

/** Flowchart links from before the Now page (`/?node=review&repo=x`) open the flowchart; the query stays. */
function OldFlowLink({ route }: { route: RouteDef }) {
  const loc = useLocation();
  if (new URLSearchParams(loc.search).has("node")) return <Navigate to={`/flow${loc.search}`} replace />;
  return <RouteView route={route} />;
}

/** Sends an old path to its new place. `from` is the prefix to swap, so `/decisions/a/1` becomes `/needs/decisions/a/1`; `search` replaces the query. */
function RedirectTo({ to, from, search }: { to: string; from?: string; search?: string }) {
  const loc = useLocation();
  const tail = from ? loc.pathname.slice(from.length) : "";
  return <Navigate to={`${to}${tail}${search ?? loc.search}`} replace />;
}

function Breadcrumb({ routes }: { routes: RouteDef[] }) {
  const loc = useLocation();
  const first = loc.pathname.split("/")[1] ?? "";
  // Pages that share a first segment (/admin/...) are told apart by the whole path.
  const whole = loc.pathname.replace(/^\/|\/$/g, "");
  const r = routes.find((x) => x.path === whole) ?? routes.find((x) => x.path.split("/")[0] === first);
  const rest = decodeURIComponent(loc.pathname.split("/").slice(2).join("/"));
  const isItem = (first === "item" || first === "items") && rest.includes("/");
  return (
    <div className="flex w-[120px] shrink-0 items-center gap-1.5 truncate text-sm">
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

const CI_ORDER: MainCiState[] = ["green", "red", "running", "optional"];

function MainCiIndicator({ summary }: { summary: MainCiSummary }) {
  const shown = CI_ORDER.filter((s) => s === "green" || summary[s] > 0);
  return (
    <Link to="/main-ci" className="flex items-center gap-1 hover:text-ink" aria-label="Main CI" title="Main CI">
      <HeartbeatIcon className="text-sm" />
      {shown.map((s) => (
        <span key={s} className="flex items-center gap-0.5" title={`${MAIN_CI_LABEL[s]}: ${summary[s]}`}>
          <span className={cn("size-1.5 rounded-full", MAIN_CI_DOT[s])} />
          <span className="num font-medium text-ink">{summary[s]}</span>
        </span>
      ))}
    </Link>
  );
}

function LiveCounters() {
  const { data } = useQuery("progress", (api) => api.progress());
  if (!data) return null;
  const lastHour = data.perHourPipeline[data.perHourPipeline.length - 1] ?? 0;
  return (
    <div className="hidden shrink-0 items-center gap-2.5 whitespace-nowrap text-xs text-ink/60 xl:flex">
      {data.mainCi && <MainCiIndicator summary={data.mainCi} />}
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
  const discord = useQuery("discord-account", (a) => a.discord.account());
  const [unlinking, setUnlinking] = useState(false);
  const [linking, setLinking] = useState(false);
  return (
    <>
    <LinkDiscordDialog open={linking} linked={!!discord.data?.linked} onClose={() => setLinking(false)} />
    <UnlinkDiscordDialog open={unlinking} onClose={() => setUnlinking(false)} onDone={() => discord.refetch()} />
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
              <div className="text-xs text-ink/55">Times in {zoneName()}</div>
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
          {MockRoleMenu && (
            <Suspense fallback={null}>
              <MockRoleMenu itemCls={itemCls} labelCls={labelCls} />
            </Suspense>
          )}
          <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-line" />
          <DropdownMenu.Item onSelect={() => navigate("/connect")} className={itemCls}>
            <PlugsConnectedIcon className="text-ink/55" /> Connect agent
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => onHelp?.()} className={itemCls}>
            <KeyboardIcon className="text-ink/55" /> <span className="flex-1">Keyboard shortcuts</span> <Kbd keys="?" />
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setLinking(true)} className={itemCls}>
            <LinkIcon className="text-ink/55" /> Link Discord
          </DropdownMenu.Item>
          {discord.data?.linked && (
            <DropdownMenu.Item onSelect={() => setUnlinking(true)} className={itemCls}>
              <LinkBreakIcon className="text-ink/55" /> Unlink Discord
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Item onSelect={() => void api.signOut()} className={itemCls}>
            <SignOutIcon className="text-ink/55" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    </>
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
