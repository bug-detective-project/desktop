# Bug Detective design system

The desktop UI follows the approved **B-Refined** layout (`../layout-tests/UI_SPECIFICATION_B_REFINED.md` and the HTML prototypes in `../layout-tests/b-refined/`). This page records the rules the code implements, so new screens stay consistent.

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

Fonts: **Inter** for the UI, **JetBrains Mono** for code, logs, versions and IDs (`font-mono`). Both are bundled locally (`@fontsource-variable/*`); the app loads nothing remote.

The theme follows the Settings value (System / Light / Dark); `App.tsx` toggles `.dark` on `<html>`. The header's theme button switches between Light and Dark.

## Logo and app icon

- Source: the 960 × 960 app icon. Its dark rounded tile (800 × 800, about 21% corner radius) is cut out of the white margin, with transparent corners.
- `resources/icon.png` (512 × 512): the executable, installer and window icon. electron-builder builds the Windows `.ico` from it; `src/main/index.ts` sets it on the window for Linux and WSLg.
- `src/renderer/src/assets/logo.png` (96 × 96, sharp at 3× on a 32 px slot): the logo in the header and on the checklist, shown with `rounded-[21%]` and a `dark:ring-1 dark:ring-white/15` outline so the dark tile stays visible on the dark header.

## Typography

- Page titles: `text-2xl font-bold tracking-tight`. Message subjects: `text-lg font-bold tracking-tight`.
- Card titles: `text-[11px] font-bold uppercase tracking-wider text-foreground` (`SectionTitle`).
- Metadata: `text-xs text-muted-foreground` (`text-[10px]`/`text-[11px]` in dense rails).
- Markdown (`Markdown.tsx`): paragraphs in `text-muted-foreground leading-relaxed`, `strong` in `font-semibold text-foreground`, inline code as `bg-muted border border-border/60 font-mono font-semibold` chips. The container sets the size (`className="text-xs"` for directives, `text-sm` elsewhere).

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

- `Button` (`ui.tsx`): `variant` `primary` (`bg-primary`), `secondary` (`bg-secondary border`), `ghost`, `danger` (`bg-destructive`); `size` `sm` (docks, rails, banners) or `md`. `busy` shows a spinner.
- **Icons** (`icons.tsx`): inline Lucide shapes drawn with `currentColor`. Icons inside buttons always inherit the button's text color: never give them their own color (no green icon inside a primary button).
- `Card`, `SectionTitle`, `Badge` (tones `neutral`, `ok`, `warn`, `danger`, `brand`), `StagePill`, `StatusIcon`, `Tabs`, `LogView` (`bg-muted/60 font-mono text-[11px]`), `Modal`, `Notice` (amber warning or destructive block).
- `AppHeader.tsx`: the shell on every screen after the checklist. Left: the app logo (`assets/logo.png`, 32 px), app name, `Lanternfish Labs`. Nav: Dashboard, Board, Settings (active `bg-primary/10 text-primary`). Right: theme toggle, Docker health pill (green running, amber starting, red stopped), inbox button with the unread counter, `ME` avatar. The Docker banner (`DockerBanner` in `Checklist.tsx`) sits right below it while Docker is down.
- Toasts (`toast.tsx`): `bg-popover` with a primary (info) or destructive (error) left edge.

## Screens

- **Dashboard** (`screens/Dashboard.tsx`), a 3-column desk (`lg:grid-cols-12`, max width `7xl`):
  - Column 1 (3): Directives & Inbox (selected thread `border-primary/40 bg-primary/5`, unread dot and bold primary sender), the Lanternfish Labs card, the client card (emerald dot, `Client` tag, SupportDesk stack).
  - Column 2 (6): the open directive (avatar, sender and e-mail, role and date, `ID: msg-…` chip, subject, markdown body) and the **action dock**, which follows the game state in this order: downloads needed (`environment-panel`), unlocking (progress and log), an older directive of a done ticket (emerald "done & merged", return to the active task), the active ticket (stage pill, the stage's primary action), next assignment queued (or blocked while Docker is stopped), onboarding complete.
  - Column 3 (3): Current assignment (active ticket, or "Queued" with **Get next assignment**), Client reporters & mentors (from `content/story.*.json`), Local environment (Docker and each download item).
- **Board**: five columns with stage dots and counters on `bg-muted/40`; cards `bg-card rounded-xl border p-4 shadow-sm` with the key in `font-mono text-primary`. Only unlocked tickets appear.
- **Ticket panel**: key, stage pill, title; workspace actions with icons; QA running in an amber notice.
- **Code review**: key and stage pill above the title; accept button primary with a `checkCircle` icon.
- **Settings** (`screens/Settings.tsx`, approved spec `../layout-tests/SETTINGS_UI_SPECIFICATION_B_REFINED.md`): centered (`max-w-4xl`), title and subtitle, then segmented top tabs (`bg-secondary/50 rounded-2xl` bar; active tab `bg-primary text-primary-foreground`):
  - Preferences: language as flag cards, theme as a System / Light / Dark toggle group, QA time limit as a text field ("3 min 00 s", also accepts `2:30`, `90s`, `5m`) with -30s / +30s and an inline error outside 30 s–30 min.
  - Developer tools & status: one row per tool with its version chip and status badge; actions only where they exist (Start Docker Desktop, Install in VS Code, install links); Check again; disk usage of the game's images and volumes (measured on demand, needs Docker).
  - Progress & backup: last export (file, age, folder) and current progress in story terms (never branch names or totals), "Backup outdated" badge and an age chip on the tab; Export / Restore; Danger zone card with an outline destructive New game button. While a long task runs, a notice says which one and the actions are disabled; while Docker is stopped, Export and Restore are disabled with the reason.
  - About: logo, version and the Electron / Node.js / Chromium versions.
  - Dialogs (`Modal`, `bg-black/60 backdrop-blur-xs`): restore confirmation (save summary, amber overwrite warning), new game, and the restore in progress (no close button, terminal log).
- Badges are `text-xs`; nothing smaller than `text-xs` in Settings.

## Text

Every string comes from `locales/en.json` and `locales/pt.json`. Layouts must tolerate Portuguese text 15–30% longer: use `truncate`, `whitespace-nowrap` on pills and `min-w-0` on flex children.
