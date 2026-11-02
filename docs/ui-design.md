# Triage dashboard: UI design

The design for the new dashboard frontend in `web/`. The data model, routes and access rules stay as in [dashboard-spec.md](dashboard-spec.md); this document covers what the reader sees and how features plug in.

## 1. Where the look comes from

The visual reference is ArtCraft's brutalist system, which the desktop app (`storytold/artcraft`, `frontend/apps/artcraft`) shares with the web app (`storytold/artcraft-services`, `frontend/apps/artcraft-webapp`). Its traits:

- near-black flat surfaces, no gradients, no shadows on panels;
- white hairline borders at 15 % opacity separate everything;
- a mono "HUD" micro-label (Geist Mono, 11 px, uppercase, 0.15 em tracking) for every section title and field name;
- display headings in Archivo at 118 % width and weight 620;
- primary buttons filled with the foreground colour (white on dark), mono uppercase labels;
- 3 px corners on anything pressable, square corners on surfaces, badges and tiles;
- fine registration crosses at the corners of key frames, and a dot grid for empty areas.

### Followed exactly

| Element | ArtCraft source | Here |
|---|---|---|
| Dark surface tokens | `base.css` `:root` / `.theme-gray` (`--st-bg #121316`, `--st-panel #101014`, controls `#1e1f22`, sunken `#060607`, fg `#f2f1ee`, hairline `rgba(255,255,255,.15)`) | `web/src/styles/tokens.css`, same values |
| Light surface tokens | `.theme-light` | same values |
| Accent | primary `#2d81ff`, accent ink `#74aaff`, selection colour | same |
| Motion | `--ease-out`, `--ease-emphasis`, `--dur-fast 140ms`, `--dur-base 220ms`, reduced-motion collapse | same |
| Type families and treatments | Archivo display, Geist Mono `.hud-label`, Instrument Serif italic for rare accents | same |
| Corners | `tailwind.css` base rule: 3 px on controls | same rule |
| Components | `button`, `badge`, `Kbd`, `.filter-tab`, `.frame-corner-mark`, `.bg-dots`, lucide sizing rule | adapted copies in `web/src/ui/`, with notices |
| Icons | `lucide-react` 0.512, sized 1.2 em by the global `.lucide` rule | same |
| Panels | `react-resizable-panels` 2.x | same, with a hairline handle |
| Stack | React 18.3, Tailwind 3.4.3, Vite 6, TypeScript 5.8, Radix | same majors |

### Deviations and why

| Change | Reason |
|---|---|
| Body text in Archivo (normal width) instead of `system-ui` | The owner rejected the generic look; system UI text was its biggest single cause. Archivo keeps ArtCraft's family. |
| Fonts bundled with `@fontsource` | ArtCraft loads Google Fonts; the dashboard's CSP allows `'self'` only. |
| Colours through CSS variables (`bg`, `panel`, `ink`, `line`, …) instead of hard-coded `white/15` | ArtCraft hard-codes white alphas in many components, so its light theme is partial. Every component here works in both themes. |
| Primary button is `bg-ink text-inv` | Same as ArtCraft's white button in dark; it stays visible in light. |
| Amber `warn` and a lifted red `bad` | ArtCraft has no "waiting" colour; the dashboard needs one for decisions waiting and age. |
| Chart palette | ArtCraft's timeline track hues (character, camera, object, audio, keyframe), re-stepped to pass colour-vision checks on both surfaces. |
| Initials tiles instead of avatars | No external image requests under the CSP. |
| Dark is the default; System, Dark and Light are selectable | ArtCraft is dark-first; the spec asks for `prefers-color-scheme`. "System" follows the OS. |

## 2. Tokens

| Group | Tokens (Tailwind name → CSS variable) |
|---|---|
| Surface | `bg` `--st-bg`, `panel` `--st-panel`, `raised` `--st-raised` (menus, tooltips), `sunken` `--st-sunken` (inputs) |
| Ink | `ink` `--st-fg-rgb` with alpha steps: 100 text, 85 body, 70 secondary, 55 labels, 40 hints; `inv` for text on ink fills |
| Lines | `line` (hairline, 15 %), `line-strong` (32 %, hover and table heads) |
| State | `accent` / `accent-ink` (links, proposals), `ok`, `warn`, `bad` |
| Chart slots | `c1` blue, `c2` teal, `c3` orange, `c4` pink, `c5` ochre; dark and light steps validated (lightness band, chroma floor, CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, 3:1 contrast) |
| Type | `2xs` 10/14, `xs` 11/16, `sm` 13/18, `base` 14/20, `md` 16/22, `lg` 19/24, `xl` 24/28, `2xl` 32/34, `3xl` 44/44. Mono for refs (`repo#n`), numbers, facts and labels; Archivo for text; display treatment for questions, titles and big numbers |
| Spacing | Tailwind 4 px scale; rows 28–40 px; panel headers 40 px; top bar 48 px; touch targets ≥ 44 px on phones |
| Radius | `DEFAULT` 3 px on controls, `sm` 2 px on key caps, `none` on surfaces |
| Border | always 1 px hairline; emphasis by colour (`ink`, `accent-ink/40`), never by thickness, except the 2 px selection bar |
| Shadow | none on panels; menus and popovers only (`0 12px 40px rgba(0,0,0,.4)`) |
| Motion | `animate-rise` (4 px rise + fade, 220 ms) for menus and new content, `animate-fadeIn`; colour transitions 140 ms; nothing loops except the live dot |

## 3. Component rules

- **Section titles** are HUD labels, never bold sans headings. One display heading per screen: the decision question, the item title or the page title.
- **Refs** (`photocraft#4127`) are mono and link to the item page; blue only when they are links.
- **Badges** are square, mono, uppercase, 18 px tall; tone carries state (open, whitelisted, failing).
- **Buttons**: primary (ink fill) for the one thing to do; secondary (5 % tint + hairline) for the rest; ghost for icon and toolbar actions. Labels are mono uppercase.
- **Option buttons** on a decision are the exception: sentence-case labels at 15 px for fast reading, a numbered key cap, the recommendation filled with ink and marked `REC`.
- **Filter chips** are ArtCraft's `.filter-tab`: hairline, mono, count inside, inverted when active.
- **Lists** are dense rows with hairlines, no cards. The selected row gets a 2 px ink bar on the left.
- **Frames with registration marks** hold the facts that a decision rests on (facts block, item metadata, progress tiles). Use them sparingly; they mark "the numbers".
- **Empty states** use the dot grid and one line of Instrument Serif italic.

## 4. Layout model

- **Shell**: left rail (212 px, collapses to 52 px with `[`), top bar (breadcrumb, global search, role chip, live counters, theme switch, user menu), workspace.
- **Rail** groups: Work (Decisions, Progress), Insight (Contributors, Classifiers, Run and cost), Operator (Repos, Access). A run meter at the bottom shows day, percentage done and the done split.
- **Workspace**: each view is a row of panels in a `PanelGroup`. Panels are resizable; panels marked `collapsible` fold to a 3 % strip with a vertical label. Layouts are saved per user and view (`craft-triage:<login>:layout:<view>` in localStorage; the storage adapter is two calls the server can implement later).
- **Phones** (< 768 px): one column. A view either supplies its own phone component (Decisions) or its panels stack top to bottom, skipping those marked `hideOnPhone`. The rail becomes a bottom tab bar (entries with `phoneTab`, plus More); search opens full screen.

## 5. Extensibility

One file lists the feature modules: `web/src/registry/index.ts`. The shell builds nav, routes, panel layouts, permission checks and the shortcut sheet from their declarations. Adding a feature means adding a module there; the shell does not change.

```ts
interface FeatureModule {
  id: string;
  permission: "viewer" | "operator" | `write:${string}`;
  nav?: { label; icon; to; group: "work" | "insight" | "operator"; order; phoneTab?; useBadge? };
  routes: { path; view: { id; title; panels: PanelDef[]; phone?; toolbar? }; permission? }[];
  commands?: { id; keys; label; group }[];   // listed in the "?" sheet
  slots?: { slot: string; order; component }[]; // fill a named place in another view
  prefetch?: (api) => void;
}
```

- **Panels** declare `defaultSize`, `minSize`, `maxSize`, `collapsible`, `startCollapsed`, `hideOnPhone`. Panels of one view share state through the URL (selection, filters) or a small view-local store.
- **Slots** let a module add to another module's screen without editing it. The item page renders the `item.side` slot under its own side panel (for example, a future "audit entries" or "cost for this item" block).
- **Data hooks**: `useQuery(key, api => …)` over the typed `Api` interface (`web/src/api/client.ts`). It refetches after any write. `createMockApi()` implements `Api` over deterministic fixtures; an HTTP client implementing the same interface replaces it when the server exposes JSON endpoints.
- **Keyboard**: views register the keys they handle (`useShortcutHelp`), so the `?` sheet lists exactly what works on the current screen.
- **Placeholders**: Contributors, Classifiers, Run and cost, Repos and Access are real modules with a placeholder view, so nav and permissions are already in place.

## 6. Screens

### Decisions inbox (home)

Desktop, three panels: queue (30 %), decision (48 %), discussion (22 %, collapsible).

- **Toolbar**: tabs Waiting / Proposals (operators only) / Answered with counts; kind chips with counts; repo picker (multi-select); age picker; "My repos". All filters live in the URL.
- **Queue**: count and one-line summary first ("38 decisions · 20 scope · 8 duplicate … · oldest 3d"), then rows grouped by kind (sticky group headers), then repo, oldest first. A row shows the ref, a `batch ×12` or `proposal` tag, a lock when the reader can't act, who is looking at it, age (amber from 2 days), the title and the recommendation. Checkboxes select rows for a batch answer.
- **Decision**: kind, ref, age, "kiri-n is looking · 3m", comment count; the item title; the question as the one display heading; up to five facts in a registration-marked frame; pending proposals; the options (2–4, numbered, recommendation filled); an optional note; then disclosures: Items (batch, with a per-item override), Context, Posted publicly (the exact public text), Classifiers (one line each), Related.
- **Answering**: one click or number key answers and moves to the next decision. The answered row stays at the top of the queue as a one-line confirmation with Undo; `u` undoes the last one. Undo is possible until the pipeline applies the answer.
- **Batch**: a batch decision answers all its items with one choice, with per-item exceptions. Checking several rows of the same kind turns the decision panel into "Answer together".
- **Discussion**: activity (asked by, opened by) and comments. Comments are for people only; the composer says they are never posted on GitHub or sent to the pipeline.

Phone: one decision per screen. A header strip with the count, summary and a Filter button (filters in a bottom sheet); the decision; a Prev / "15 of 38" / Next bar above the tab bar. Kind, ref, title, question, five facts and the options fit on one 390 × 844 screen; context, classifiers, related items and the discussion sit in disclosures below. When an operator has a pending proposal to approve, Approve / Reject take the options' place and the options move into "Answer differently".

### Roles in the inbox (spec: Trust boundary)

| Reader | What the decision panel shows |
|---|---|
| Operator (with GitHub write on the repo) | Options answer at once. Pending proposals sit above the options: who proposes which option, their note, age, Approve (`a`) / Reject (`r`). A Proposals tab lists every decision with a pending proposal. |
| Maintainer, `maintainer_writes` on, with write on the repo | A line "Your pick goes to an operator as a proposal"; each option button reads "PROPOSE / <option>". After proposing, the options are replaced by "You propose …, waiting for an operator" with Withdraw. Can comment. |
| Maintainer, `maintainer_writes` off | Read-only: "Maintainer proposals are off in this deployment; an operator decides." The options are listed, inert. No comment box. |
| Viewer | Read-only: "Viewers can read decisions but not answer them." Same inert option list. |
| Anyone without GitHub write on the repo | Read-only: "You don't have write access to cadcraft on GitHub." |

The top bar always shows the reader's role chip (OPERATOR / MAINTAINER · PROPOSES / MAINTAINER · READ-ONLY / VIEWER), because the role changes what every button means. Answered decisions say "proposed by kiri-n, approved by ochre-fox" when they came from a proposal. The mock API enforces the same rules the server will (`decisionAccess` in `web/src/registry/permissions.ts`); in the mock, the user menu has "Mock · view as" and URLs accept `?as=operator|maintainer|maintainer-off|viewer`.

### Item detail

Two panels: the item (68 %) and a collapsible side panel (32 %).

- Header: state icon, ref, state and label badges, GitHub link, the title as the display heading.
- A registration-marked spec grid: author with whitelist tier badge and merged / closed counts; size (+/−, diff bar, S/M/L/XL bucket, file count); CI (state, one segment per check); mergeable, opened, updated.
- Classifier verdicts side by side (one column per classifier; type, want, reference, topics, reason). Cells that disagree with the majority turn amber with a marker; the header says "2 of 3 agree on type". On phones, one block per classifier.
- Stage timeline in plain words ("Waiting for a decision", "Merged by the pipeline"), actor and age; the current stage is marked.
- Files with +/− and a proportional bar.
- Side: decisions about the item (status, recommendation or answer, pending proposals), linked and duplicate items, CI checks, then the `item.side` slot.

### Progress

- Title with run start, day and repo count.
- Four tiles in a marked frame: open now (and at run start), done since start (share done by the pipeline), throughput per hour (24 h total), decisions waiting (answered today, links to the inbox).
- Funnel for open items: open → classified → reviewed as bars, then a stacked "routed" bar (taken, held, to close, in a batch, waiting for a decision) with a legend and counts.
- Done since run start: stacked bar (merged by pipeline, closed by pipeline, closed by others) and three number cells.
- Throughput: 24 hourly columns in one hue with a dashed average line and a hover readout, drawn at the container's pixel width so labels stay at type size.
- By repo: sortable table (open, classified / reviewed, routed mix, done split, decisions waiting, open-items sparkline). Repo names link to the inbox filtered to that repo. On phones, one compact row per repo.

Charts are hand-written SVG and HTML (no chart library): every bar has a 2 px surface gap, series are identified by legend and direct labels, never colour alone, and hover shows exact values.

## 7. Keyboard

| Key | Action |
|---|---|
| `/` or `Ctrl K` | Search (`repo#123`, `#123`, title or author; arrows and Enter) |
| `?` | Shortcut sheet for the current screen |
| `[` | Collapse or expand the rail |
| `g d`, `g p` | Go to decisions, progress |
| `j` / `k` | Next / previous decision |
| `1`–`4` | Answer (operator) or propose (maintainer) with that option |
| `n` | Focus the note |
| `x` | Check the row for a batch answer; `Esc` clears |
| `u` | Undo the last answer |
| `a` / `r` | Approve / reject the first pending proposal (operator) |
| `o` | Open the item page |
| `g a` | Toggle the Answered tab |
| `Ctrl Enter` | Send a comment |

Keys are ignored while typing, except `Esc` and `Ctrl Enter`.

## 8. Accessibility

- Contrast: body text ≥ 4.5:1 on both themes; amber and red have separate light-theme steps for that reason. Chart marks ≥ 3:1 against the surface.
- Focus: a 2 px accent-ink outline on every focusable element; all actions reachable by keyboard; Radix handles focus in menus and dialogs.
- Semantics: the queue is a `listbox` with `aria-selected`; tabs, radio groups and toggles carry their ARIA roles and states; option buttons declare `aria-keyshortcuts`; each chart has an `aria-label` and its numbers appear as text beside it.
- State is never colour alone: proposals have a text tag, locks have an icon and a sentence, disagreeing verdicts have a marker and amber text, chart series have legends.
- Phones: targets ≥ 44 px (option buttons 52 px), no horizontal page scroll at 360–390 px.
- `prefers-reduced-motion` collapses all durations.

## 9. Open points

- Radix `Dialog` injects a small `<style>` for scroll locking, which `style-src 'self'` blocks (the dialogs still work). Options: allow a hashed style, or drop scroll locking.
- Claim indicator: the mock records a claim when a decision opens; the server needs a short-lived claim table and a "being looked at" expiry (proposed: 10 minutes).
- Proposals need a table (`decision_proposals`: id, decision id, login, option, note, at, status, decided_by, decided_at) and audit actions `propose`, `approve`, `reject`, `withdraw`.
- Layout persistence is localStorage only; a `PUT /api/me/layout/:key` endpoint would make layouts follow the user.
