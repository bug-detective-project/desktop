# Bug Detective design system

The desktop UI follows the approved **B-Refined** layout (`../layout-tests/UI_SPECIFICATION_B_REFINED.md` and the HTML prototypes in `../layout-tests/b-refined/`). This page records the rules the code implements, so new screens stay consistent.

A self-contained version of this page for design tools (tokens with hex values, components and screen patterns, no code paths) lives in `../bug-finder/Bug Detective — Design System.md`. Update it whenever this page changes.

## Tone

Calm, realistic internal developer tool in someone's first week. No points, streaks, confetti, countdowns or game HUD. **Never show how many tickets exist** (no "1 of 4", no roadmap of locked tickets): the UI shows the current assignment, or that the next one is queued. **Never show git branch names** (`player/ticket-N`, `archive/…`): the UI talks about tickets; branches stay internal to the workspace.

## Tokens

Defined once in `src/renderer/src/styles.css` (Tailwind CSS 4, shadcn-style names). `:root` holds the light theme, `.dark` the dark one; `@theme inline` exposes them as utilities.

| Token | Utility examples | Use |
| --- | --- | --- |
| `background` / `foreground` | `bg-background`, `text-foreground` | Page canvas and main text |
| `card` / `card-foreground` | `bg-card` | Cards, header, panels |
| `popover` | `bg-popover` | Modals, toasts |
| `primary` / `primary-foreground` | `bg-primary`, `text-primary`, `bg-primary/10` | Brand (editorial indigo `oklch(0.50 0.15 265)`, `oklch(0.68 0.15 265)` in dark), primary buttons, active nav, ticket keys |
| `secondary` | `bg-secondary` | Secondary buttons, neutral pills |
| `muted` / `muted-foreground` | `bg-muted`, `text-muted-foreground` | Subtle surfaces, metadata, body text of messages |
| `accent` | `bg-accent` | Rare highlights |
| `destructive` | `bg-destructive`, `text-destructive`, `bg-destructive/5` | Errors, blocked states, New game |
| `border` / `input` / `ring` | `border-border`, `border-input`, `ring-ring/50` | Lines, form fields, focus rings |
| `radius` (0.5rem) | `rounded-md`, `rounded-lg`, `rounded-xl` | `rounded-xl` for cards, `rounded-lg` for buttons and inner boxes |

Fonts: **Inter** for the UI, **JetBrains Mono** for IDs, versions, paths, code and logs (see Typography). Both are bundled locally (`@fontsource-variable/*`); the app loads nothing remote.

The theme follows the Settings value (System / Light / Dark); `App.tsx` toggles `.dark` on `<html>`. The header's theme button switches between Light and Dark.

`color-scheme` follows the theme (`light` on `:root`, `dark` on `.dark`), so native controls match it. Scrollbars (`styles.css`) are 10px, rounded, without arrow buttons, on a transparent track; the thumb is `--muted-foreground` at 45% (75% on hover), so it works in both themes. Do not set `scrollbar-width` or `scrollbar-color`: Chromium then ignores the `::-webkit-scrollbar` rules and the arrows come back.

## Logo and app icon

- Source: the 960 × 960 app icon. Its dark rounded tile (800 × 800, about 21% corner radius) is cut out of the white margin, with transparent corners.
- `resources/icon.png` (512 × 512): the executable, installer and window icon. electron-builder builds the Windows `.ico` from it; `src/main/index.ts` sets it on the window for Linux and WSLg.
- `src/renderer/src/assets/logo.png` (96 × 96, sharp at 3× on a 32 px slot): the logo in the header and on the checklist, shown with `rounded-[21%]` and a `dark:ring-1 dark:ring-white/15` outline so the dark tile stays visible on the dark header.

## Typography

**Base size: 16px.** Normal text is `text-base` (1rem = 16px, the browser default set on `body`); every other size steps from it. Two families on every screen:

| Family | Utility | Use |
| --- | --- | --- |
| **Inter Variable** (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` as fallback) | `font-sans`, set on `body` | All UI text |
| **JetBrains Mono Variable** (`ui-monospace, monospace` as fallback) | `font-mono` | Only ticket keys (`SD-214`), versions, file names and paths, e-mail addresses, code and logs. Never for sentences, labels, stage names or numbers (use `tabular-nums` for sizes and durations) |

| Role | Size | Classes | Examples |
| --- | --- | --- | --- |
| Page title | 30px | `text-3xl font-bold tracking-tight` | "Board", "Settings", "Before you start", the code review title |
| Subject | 20px | `text-xl font-bold tracking-tight` | Directive subject, ticket panel title, dialog titles, About app name |
| Card heading | 18px | `text-lg font-bold tracking-tight` (or `font-semibold`) | Settings pane titles and setting titles, Danger zone, the Lanternfish Labs and client names in Project context, current assignment title, app name in the header |
| **Normal text** | **16px** | `text-base` | Card titles, directive and ticket body, list items, help texts, dialog text, inputs, tabs, navigation, buttons (`md`) |
| Secondary | 14px | `text-sm text-muted-foreground` | Dates, ticket keys, secondary lines, badges, chips, header pills, small buttons (`sm`) |
| Label | 12px | `text-xs font-bold uppercase tracking-wider` | Board column titles, Dashboard card labels ("Current task", "Project context", "Contacts", "Local environment"), counters |
| Small | 12px | `text-xs` | Dashboard tags ("Your team", "Client", "Hints mentor"), the "role · company" lines in Contacts, the Local environment statuses ("Running", "Ready (1.1 GB)") |

Nothing is smaller than 12px (`text-xs`). Buttons never wrap (`whitespace-nowrap`). Markdown (`Markdown.tsx`): `h1` 24px, paragraphs in `text-muted-foreground leading-relaxed`, `strong` in `font-semibold text-foreground`, inline code as `bg-muted border border-border/60 font-mono font-semibold` chips; the container sets `text-base`.

## Workflow stage colors

One hue per Kanban column, in `components/stage.ts` and rendered by `StagePill` (`components/ui.tsx`). The column dots on the Board use the same hues.

| Stage | Pill | Dot |
| --- | --- | --- |
| To Do | `bg-secondary text-secondary-foreground border-border` | slate |
| In Progress | `bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20` | blue, pulsing |
| In QA | `bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20` | amber, pulsing |
| Code Review | `bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20` | indigo |
| Done | `bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20` | emerald |

Action buttons never take the stage color: "Read & accept code review" is a primary button.

## Components (`src/renderer/src/components/`)

- `Button` (`ui.tsx`): `variant` `primary` (`bg-primary`), `secondary` (`bg-secondary border`), `ghost`, `danger` (`bg-destructive`), `review` (`bg-indigo-600`, the Code Review stage hue: "Open code review" of a card in Code Review, full width in the ticket panel); `size` `sm` (14px, `px-2.5`: docks, rails, banners) or `md` (16px). Next to a main action, the workspace buttons use the short labels "VS Code" and "Browser" ("Navegador"), with the full label as the tooltip, so the action row stays on one line in both languages; in the narrow current assignment card they stack below `xl`. `busy` shows a spinner.
- **Icons** (`icons.tsx`): inline Lucide shapes drawn with `currentColor`. Icons inside buttons always inherit the button's text color: never give them their own color (no green icon inside a primary button).
- `Card`, `SectionTitle`, `Badge` (tones `neutral`, `ok`, `warn`, `danger`, `brand`), `StagePill`, `StatusIcon`, `Tabs`, `LogView` (`bg-muted/60 font-mono text-xs`), `Modal`, `Notice` (amber warning or destructive block).
- `Tooltip` (`ui.tsx`): a `bg-popover` hint below its child, as wide as the child (or placed and sized with `panelClassName`, e.g. `right-0 w-96` for an `info` icon), shown on hover and focus (`hoverOnly`: hover only, so a click does not keep it open; it uses the named group `group/tooltip`, so a `group` ancestor never opens it); the wrapper catches hover even when the child button is disabled. Used for explanations that would otherwise sit as paragraphs under buttons (ticket panel).
- `SplitDiff.tsx`: the pull-request "Files changed" view. A file list (`font-mono`, one-sided files with a `Badge`: neutral for the left side only, `brand` for the right side only; renames as `old → new`; `−n +n` counts in rose and emerald), then one collapsible block per file (`bg-muted` header with a `chevronDown`) holding a fixed-layout two-pane table: line numbers in `w-14` columns, removed lines `bg-rose-500/12`, added lines `bg-emerald-500/12`, the missing side `bg-muted/50`, long lines wrap inside their pane. Binary files show a sentence instead of lines; files above 2,000 changed lines wait for "Load diff".
- `ReviewBanner.tsx`: below the header (after the Docker banner), `bg-primary/10` while a review is checked out in the workspace, with the primary `sm` "Back to my code" button; amber with a close button for what happened when the code came back. Ticket keys only, never branch names.
- `AppHeader.tsx`: the shell on every screen after the checklist, 64 px high (`h-16`). Text follows the scale: app name 18px bold, navigation 16px, company and pills 14px, icons `size-4`, unread counter 12px; below `2xl` (1536px) the company name and the theme label hide, below `xl` the inbox label too (icons and values stay). Left: the app logo (`assets/logo.png`, 36 px), app name, `Lanternfish Labs`. Nav: Dashboard, Board, Settings (active `bg-primary/10 text-primary`). Right: theme toggle, inbox button with the unread counter, `ME` avatar. No Docker status in the header: while Docker is down, the Docker banner (`DockerBanner` in `Checklist.tsx`) sits right below it, and Settings → Developer tools & status shows the full status.
- Toasts (`toast.tsx`): `bg-popover` with a primary (info) or destructive (error) left edge.

## Screens

- **Dashboard** (`screens/Dashboard.tsx`), a 3-column desk (`lg:grid-cols-12`, max width `7xl`). From `lg` up the dashboard is at most the window tall (`lg:h-full`, one `minmax(0,1fr)` row): the page never scrolls, each column fits and scrolls inside (the project context body, the e-mail above the action dock, which stays visible, and the right column as a whole). Below `lg` the columns stack and the page scrolls:
  - Column 1 (3): Directives & Inbox (selected thread `border-primary/40 bg-primary/5`, unread dot and bold primary sender; the list is at most three messages tall and scrolls past that), the collapsible **Project context** card (`ProjectContextCard`: the header row is a button with `aria-expanded` and a chevron; expanded by default, the choice kept in `localStorage`; it takes the rest of the column below the inbox and its body scrolls). Inside: Lanternfish Labs with a `Your team` tag and the client (emerald dot, `Client` tag) with the SupportDesk stack; each tag sits below its name, in `text-xs`.
  - Column 2 (6): the open directive (avatar, sender and e-mail, role and date in a fixed header; below it the subject and markdown body, which scroll) and the **action dock**, which follows the game state in this order: downloads needed (`environment-panel`), unlocking (progress and log), an older directive of a done ticket (emerald "done & merged", return to the active task), the active ticket (stage pill, the stage's primary action), next assignment queued (or blocked while Docker is stopped), onboarding complete.
  - Column 3 (3): Current task (active ticket, or "Queued" with **Get next assignment**; "Tarefa atual" in Portuguese), then Local environment (Docker and each download item; the colored status, such as the green "Ready (1.1 GB)", in `text-xs`), then Contacts (from `content/story.*.json`; name, then "role · company" in `text-xs text-muted-foreground` with `gap-1` between them, the mentor tag (`text-xs`) next to the senior's name).
- **Board**: title and subtitle, then five columns (`grid-cols-5 gap-4`, same height, filling the board). Each column is a framed card (`section` with the stage name as `aria-label`: `rounded-xl border bg-card shadow-sm`). Its header (`border-b px-4 py-3`) is tinted with the stage pill classes (`STAGE[column].pill`) and holds a 6px stage dot, the `h2` title (`text-xs font-bold uppercase tracking-wider`) and the counter (`ml-auto text-xs tabular-nums text-muted-foreground`). The In Progress dot always pulses; the In QA dot pulses only while a QA run is in progress. An empty column shows a dashed placeholder (`rounded-lg border-dashed px-4 py-6 text-center text-sm text-muted-foreground`, amber border in In QA) with a short message for that column; it stays a drop target. Ticket cards are flat (`rounded-lg border bg-background p-3.5`, no shadow, hover `border-primary/40`; the active card in In Progress keeps `border-primary/40`): key in `font-mono text-sm font-medium text-primary`, title `font-medium line-clamp-2`, and the danger "Test failed" badge only when the latest finished QA run failed. Nothing else sits on a card (no workspace buttons, no attempt counter, no "Tests passed"). Only unlocked tickets appear.
- **Ticket panel**: key, stage pill, title; workspace actions with icons; QA running in an amber notice. In the QA tab, each run's failing and unfinished tests sit in a bordered dropdown under its comment ("N errors in this run", a `chevronDown` that turns when open); the latest run starts open, earlier runs closed.
- **Code review**: key and stage pill above the title; below the title, always, the ghost "Back to the board" and the primary accept button with a `checkCircle` icon. The review notes card stays on top; below it, two dropdown cards (`<details>` styled as a card, the title row is the toggle with a `chevronDown`; titles 16px bold uppercase), both open by default. First "Diff: your solution with the proposed solution": a neutral sentence presenting two valid solutions with the whitespace checkbox and the primary "Open Review in VS Code" button (`code` icon) beside it, followed by an `info` icon; hovering the button or the icon shows the steps to the diff in VS Code, then the `SplitDiff` with "Your solution" on the left and "Reference solution" on the right; identical solutions show an emerald sentence, then the player's changes against the original code in the same view. Second "Diff: proposed solution with the original code": the senior developer's change as a `SplitDiff` ("Original code" left, "Reference solution" right), code only, no VS Code button.
- **Settings** (`screens/Settings.tsx`, approved spec `../layout-tests/SETTINGS_UI_SPECIFICATION_B_REFINED.md`): centered (`max-w-5xl`), title and subtitle, then segmented top tabs (`bg-secondary/50 rounded-2xl` bar; active tab `bg-primary text-primary-foreground`):
  - Preferences: language (flag + name) and theme (System / Light / Dark) as the same switch-like segmented control (`Segmented` in `Settings.tsx`: `bg-secondary/50` track, selected option raised in `bg-card` with a ring), QA time limit as a number field in minutes (its arrows and ↑/↓ step 1 minute; half minutes such as 2.5 or 2,5 can be typed) with the "minutes" label, -1m / +1m buttons and an inline error outside 1–30 minutes (the setting is stored in seconds, 60–1800; 3 minutes by default).
  - Developer tools & status: one row per tool with its version chip and status badge; actions only where they exist (Start Docker Desktop, Install in VS Code, install links); Check again; disk usage of the game's images and volumes (measured on demand, needs Docker).
  - Progress & backup: last export (file, age, folder) and current progress in story terms (never branch names or totals), "Backup outdated" badge and an age chip on the tab; Export / Restore; Danger zone card with an outline destructive New game button. While a long task runs, a notice says which one and the actions are disabled; while Docker is stopped, Export and Restore are disabled with the reason.
  - About: logo, version and the Electron / Node.js / Chromium versions.
  - Dialogs (`Modal`, `bg-black/60 backdrop-blur-xs`): restore confirmation (save summary, amber overwrite warning), new game, and the restore in progress (no close button, terminal log).
- Badges are 14px; reading text and help are 16px, like the rest of the app.

## Text

Every string comes from `locales/en.json` and `locales/pt.json`. Layouts must tolerate Portuguese text 15–30% longer: use `truncate`, `whitespace-nowrap` on pills and `min-w-0` on flex children.
