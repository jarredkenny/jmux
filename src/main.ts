import { $ } from "bun";
import { TmuxPty } from "./tmux-pty";
import { clipboardCopyCommand } from "./platform";
import { MIN_TMUX_VERSION, tmuxVersionOk } from "./tmux-version";
import { configFileIn, materializeAssets } from "./assets";
import { currentChannel, upgradeCommand } from "./channel";
import { compareGeneration, GENERATION_OPTION, stampCommand, staleGenerationNotice } from "./config-generation";
import { installSkill, uninstallIntegrations } from "./agent-hooks/skill";
import { ScreenBridge } from "./screen-bridge";
import { Renderer, getToolbarButtonRanges, getToolbarTabRanges, getModalPosition, buildToolbarButtons, type ToolbarConfig } from "./renderer";
import { InputRouter } from "./input-router";
import { sidebarWidthForCol, panelWidthForCol, type DragHandle } from "./drag";
import { Sidebar, rebuildSidebarColors, type PinnedPaneEntry } from "./sidebar";
import {
  GROUP_MODES, SORT_MODES, FILTER_MODES,
  groupModeLabel, sortModeLabel, filterModeLabel, migrateLegacySort,
  type GroupMode, type SortMode, type FilterMode, type LegacySortMode,
  type StageBucket,
} from "./sidebar-sort";
import { buildFooter, layoutFooter, type FooterModel } from "./footer";
import { CommandPalette } from "./command-palette";
import { InputModal } from "./input-modal";
import { ListModal, type ListItem } from "./list-modal";
import { ContentModal, type StyledLine } from "./content-modal";
import { renderMarkdownToStyledLines } from "./markdown";
import {
  NewSessionModal,
  tq,
  type NewSessionResult,
  type NewSessionProviders,
} from "./new-session-modal";
import { CaptureModal, type CaptureResult } from "./capture-modal";
import { buildPinCommands } from "./cli/pane";
import type { CellAttrs } from "./cell-grid";
import { createGrid } from "./cell-grid";
import type { Modal } from "./modal";
import { rebuildModalAttrs } from "./modal";
import { rebuildChromeTokens } from "./chrome-tokens";
import {
  theme,
  neutralFg,
  setTheme,
  deriveTheme,
  pack,
  toHex,
  OSC11_QUERY,
} from "./theme";
import { StdinGate } from "./stdin-gate";
import { GRAPHICS_PROBE, CELL_SIZE_PROBE, DEFAULT_CELL_PIXELS, type CellPixels } from "./images/kitty";
import { ImageStore } from "./images/store";
import { ImagePlane } from "./images/plane";
import { StoreImagePort, setImagePort } from "./images/port";
import { TmuxControl, type ControlEvent } from "./tmux-control";
import { DiffPanel } from "./diff-panel";
import { InfoPanel, rebuildInfoPanelColors } from "./info-panel";
import { parseViews, cycleGroupBy, cycleSortBy, toggleSortOrder, matchesIssueFilter, pickUpNext, applyFilterPatch, toggleFilterValue, parkedStages, toggleParkedState, effectiveFilter, stageForState, stageInSidebar, stageShowsUnstarted, type PanelView } from "./panel-view";
import { transformIssues, transformMrs, buildViewNodes, renderView, createViewState, filterItems, rebuildPanelViewColors, computeViewLayout, splitRatioForSepRow, DEFAULT_PANEL_SPLIT_RATIO, type ViewState, type ViewNode, type IssueSessionInfo } from "./panel-view-renderer";
import { createAdapters } from "./adapters/registry";
import { PollCoordinator } from "./adapters/poll-coordinator";
import { SessionState } from "./session-state";
import type { SessionContext, WorkflowState } from "./adapters/types";
import { stageForIssue, resolveIssueRepoDir, STAGE_ORDER, STAGE_LABELS } from "./work-stage";
import {
  selectGhosts, ghostCapValue, formatGhostCap, editGhostCap, parseGhostCap, stepGhostCap,
  GHOST_CAP_ALL, type GhostQueue, type GhostCap,
} from "./ghosts";
import {
  detectMrTransitions,
  transitionTarget,
  TRANSITION_LABELS,
  type MrSnapshot,
  type TransitionEvent,
} from "./transitions";
import {
  isParked,
  clearStaleOverride,
  captureBaseline,
  detectSignals,
  DEFAULT_PARKING,
  UNPARK_TRIGGERS,
  UNPARK_TRIGGER_LABELS,
  UNPARK_TRIGGER_SHORT,
  parkingSetupWarning,
  type ParkingConfig,
  type ParkBaseline,
  type ParkContext,
  type UnparkTrigger,
} from "./parking";
import type { DemoContext } from "./demo/setup";
import type { SessionInfo, WindowTab, PaletteCommand, PaletteResult, AgentState } from "./types";
import { loadProjectDirsCache, saveProjectDirsCache } from "./project-dirs-cache";
import { ConfigStore, sanitizeTmuxSessionName, DEFAULT_IMAGE_MAX_ROWS } from "./config";
import {
  RepoFactsCache,
  resolveForRepo,
  buildWorktreeCommand,
  REPO_SETTING_DEFAULTS,
  type RepoSettings,
  type WorkStage,
  type ResolvedRepoSettings,
} from "./repo-settings";
import {
  resolveStateColors,
  STATE_COLOR_NAMES,
  DEFAULT_STATE_COLORS,
} from "./state-colors";
import { INTERNAL_SESSION_FILTER, PARK_SESSION } from "./glass/internal-sessions";
import { PinnedPaneTracker } from "./glass/pinned-pane-tracker";
import { parsePaneStateLines, PANE_STATE_FORMAT } from "./glass/reflect";
import { US, splitFields } from "./tmux-fields";
import { buildPaneLabel } from "./glass/pane-label";
import { AGENT_DETECT_FORMAT, parseAgentDetectLines, detectAgentPanes } from "./glass/auto-detect";
import { GlassView, type GlassTileSpec } from "./glass/view";
import { normalizeTabs, defaultTabId, resolveTabId, summarizeTabState, addTab, renameTab, deleteTab, moveTab, type TabEntry } from "./glass/tabs";
import { buildCcCommands, NEW_TAB_OPTION_ID } from "./glass/cc-commands";
import { stripVisibleFor, renderStrip, layoutStrip, STRIP_ROWS } from "./glass/strip";
import { chipAtCol, type PlacedChip } from "./band-layout";
import { clampTabSelection } from "./glass/reload";
import { OtelReceiver } from "./otel-receiver";
import { computeFrameLayout, sidebarBottomRow, type FrameLayout } from "./frame-layout";
import { AgentStateTracker, coerceStaleAgentState } from "./agent-state";
import { logError } from "./log";
import { installAllAgents, screenTierMayWrite } from "./agent-hooks/registry";
import { BUILTIN_SIGNATURES, classifyPaneScreen, compileSignatures, hasSignatureFor } from "./agent-screen";
import { resolve, dirname } from "path";
import { writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { homedir } from "os";
import pkg from "../package.json" with { type: "json" };

// --- Crash logging ---
// Fatal errors during boot were being swallowed by `start().catch(cleanup)` (and
// runtime uncaught errors only flashed on the alt-screen before teardown), which
// made real crashes undiagnosable. Record full stacks to ~/.config/jmux/crash.log.
function logCrash(kind: string, err: unknown): void {
  const stack = err instanceof Error && err.stack ? err.stack : String(err);
  const line = `${new Date().toISOString()} [${kind}] ${stack}\n`;
  try {
    const dir = `${homedir()}/.config/jmux`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(`${dir}/crash.log`, line);
  } catch {}
  // Deliberately NOT writing to stderr: while the alt-screen TUI is active,
  // stderr bleeds into and corrupts the rendered screen. crash.log is the
  // reliable record; `cat ~/.config/jmux/crash.log` to read it.
}
process.on("uncaughtException", (e) => {
  logCrash("uncaughtException", e);
  // Minimal terminal restore (exit alt-screen, show cursor) then fail fast.
  try {
    process.stdout.write("\x1b[?1049l\x1b[?25h");
  } catch {}
  process.exit(1);
});
// Log-only: preserve the runtime's default rejection handling (no forced exit),
// so a previously-survivable background rejection can't newly kill the TUI.
process.on("unhandledRejection", (e) => {
  logCrash("unhandledRejection", e);
});

// --- CLI commands (run and exit before TUI) ---

const VERSION = pkg.version;
const MIN_BUN_VERSION = "1.3.8";

function checkBunVersion(): void {
  // parseInt parses leading digits and stops at the first non-digit, so
  // canary/prerelease suffixes like "1.3.8-pre.1" survive intact.
  const parsePart = (s: string) => {
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  };
  const cur = Bun.version.split(".").map(parsePart);
  const min = MIN_BUN_VERSION.split(".").map(parsePart);
  for (let i = 0; i < min.length; i++) {
    if ((cur[i] ?? 0) > min[i]) return;
    if ((cur[i] ?? 0) < min[i]) {
      process.stderr.write(
        `jmux requires Bun ${MIN_BUN_VERSION}+ (you have ${Bun.version}). Run: bun upgrade\n`,
      );
      process.exit(1);
    }
  }
}

const HELP = `jmux — the terminal workspace for agentic development

Agents, editors, servers, logs.
All running. All visible. One terminal.

Run Claude Code, Codex, or aider in parallel — jmux shows you which
agents are working, which finished, and which need your review.
No Electron. No lock-in. Just your terminal.

Usage:
  jmux [session-name] [options]

Options:
  -L, --socket <name>      Use a separate tmux server socket
  --demo                   Run in demo mode with mock data
  --live                   With --demo: run real agents in the demo sessions
                           (needs the claude CLI; spends real tokens)
  --install-agent-hooks    Install agent state hooks (Claude Code, Codex, pi)
  --install-skill          Install the jmux-control skill for Claude Code
  --uninstall-integrations Remove everything the two commands above installed
  -v, --version            Show version
  -h, --help               Show this help

Examples:
  jmux                     Start with default session
  jmux my-project          Start with named session
  jmux -L work             Use isolated tmux server
  jmux --install-agent-hooks  Set up agent state tracking
  jmux --install-skill     Teach agents the jmux ctl CLI

Agent Control (JSON output):
  jmux ctl session list          List sessions
  jmux ctl session create        Create a session
  jmux ctl run-claude            Launch Claude Code in a new session
  jmux ctl pane capture          Read pane contents
  jmux ctl --help                Show all ctl subcommands

Keybindings:
  Ctrl-Shift-Up/Down       Switch sessions
  Ctrl-a n                 New session / worktree
  Ctrl-a c                 New window
  Ctrl-a z                 Toggle pane zoom
  Ctrl-a Arrows            Resize panes
  Ctrl-a p                 Command palette
  Ctrl-a g                 Toggle diff panel (on/off)
  Ctrl-a z                 Zoom diff panel (split ↔ full, when focused)
  Ctrl-a Tab               Switch focus (tmux ↔ diff)
  Ctrl-a i                 Settings
  Click sidebar            Switch to session

https://github.com/jarredkenny/jmux`;

if (process.argv[2] === "ctl") {
  const { runCtl } = await import("./cli");
  await runCtl(process.argv.slice(3));
  process.exit(0);
}

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

if (process.argv.includes("-v") || process.argv.includes("--version")) {
  console.log(`jmux ${VERSION}`);
  process.exit(0);
}

// --- Asset materialization (must precede every subcommand that reads assets) ---
//
// `bun build --compile` collapses `import.meta.dir` to `/$bunfs`, which tmux —
// a separate process — cannot read. The embedded assets are written to a real
// path here and `$JMUX_DIR` points at it.
//
// This sits above the subcommand branches deliberately: `--install-agent-hooks`
// reads the materialized pi extension, and it is handled below. Per CLAUDE.md,
// anything called at module scope may only touch bindings declared above it —
// `materializeAssets` is an import, so it qualifies.
let jmuxDir: string;
try {
  jmuxDir = materializeAssets();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
}
const configFile = configFileIn(jmuxDir);

// Export JMUX_DIR so every tmux subprocess (PTY, control, Restorer) inherits
// it. The config file expands "$JMUX_DIR/config/defaults.conf", which is
// resolved at config-load time against the tmux server's environment — which
// is inherited from this process. Setting it here means we don't need to
// `set-environment -g JMUX_DIR ...` after control-mode attaches.
process.env.JMUX_DIR = jmuxDir;
// Same mechanism, same reason: defaults.conf's `C-a y` bind pipes into
// $JMUX_COPY. Resolved here rather than in the conf so the platform branch is
// testable and lives in one place. Empty is meaningful — the bind reports it.
process.env.JMUX_COPY = clipboardCopyCommand();

if (process.argv.includes("--install-agent-hooks")) {
  installAgentHooks();
  process.exit(0);
}

if (process.argv.includes("--install-skill")) {
  process.exit(installSkill() ? 0 : 1);
}

if (process.argv.includes("--uninstall-integrations")) {
  process.exit(uninstallIntegrations() ? 0 : 1);
}

function installAgentHooks(): void {
  const reports = installAllAgents();

  const touched = reports.filter((r) => r.kind === "installed" || r.kind === "migrated");
  const failed = reports.filter((r) => r.kind === "failed");

  for (const report of reports) {
    const status =
      report.kind === "skipped"
        ? "not installed on this machine — skipped"
        : report.kind === "noop"
          ? "already up to date"
          : report.kind === "failed"
            ? "FAILED"
            : report.kind;
    console.log(`${report.label}: ${status}`);
    for (const note of report.notes) console.log(`  ${note}`);
  }

  if (touched.length > 0) {
    console.log("");
    console.log("Your jmux sidebar will show RUNNING / WAITING / COMPLETE per agent pane.");
  }
  if (failed.length > 0) process.exit(1);
}

// --- Bun version gate (TUI requires Bun.markdown.ansi) ---

checkBunVersion();

// --- Nesting guard (after CLI commands, before TUI) ---

if (process.env.JMUX) {
  console.error("Already running inside jmux.");
  process.exit(1);
}
process.env.JMUX = "1";

// --- TUI startup ---

// Check for --demo flag early (before config, before arg loop)
const demoMode = process.argv.includes("--demo");
let demoCtx: DemoContext | null = null;
let demoCleanup: ((ctx: DemoContext) => void) | null = null;

if (demoMode) {
  const mod = await import("./demo/setup");
  // `configFile` is resolved above (line ~268) — demo mode *starts* the tmux
  // server itself, and `-f` is only honored by the process that does, so this
  // is jmux's one chance to apply its config to the demo socket.
  demoCtx = mod.setupDemo({ configFile });
  demoCleanup = mod.cleanupDemo;

  // `--live` runs real agents in the demo's sessions instead of seeding their
  // state. Opt-in because it spends real tokens against the user's own agent
  // credentials — demo mode's promise is "no credentials needed", and this is
  // the one flag that breaks it, so it must never be reachable by accident.
  if (process.argv.includes("--live")) {
    const live = await import("./demo/live-agents");
    if (!live.agentAvailable()) {
      console.error("--live needs the `claude` CLI on PATH; running with seeded state instead.");
    } else {
      const ctx = demoCtx;
      live.startLiveAgents(ctx);
      // Deliberately not awaited: the trust dialog takes seconds to appear and
      // blocking here would hold the first frame behind it. jmux boots, the
      // panes settle in the background, and the sidebar picks up the state as
      // the emitters write it. The watcher then stays up for the life of the
      // demo so sessions created later — by `Ctrl-a u`, or `n` in the issue
      // panel — don't strand their agent on the same dialog.
      void live.acceptWorkspaceTrust(ctx);
      live.watchWorkspaceTrust(ctx);
    }
  }
}

const configStore = new ConfigStore(demoCtx?.configPath);
let sidebarWidth = configStore.config.sidebarWidth || 26;
const BORDER_WIDTH = 1;
// Drag-handle chrome + live-resize state. `hoveredHandle` drives the accent
// that makes the one-column handles findable at all, and stays lit for the
// duration of a drag. `pendingDragResize` holds the most recent tracked
// handle position; applyPendingDragResize() turns it into a real relayout,
// throttled to DRAG_RESIZE_INTERVAL_MS so a fast drag can't fire a tmux
// resize + xterm reflow per pointer event.
let hoveredHandle: DragHandle | null = null;
let pendingDragResize: { handle: DragHandle; col: number } | null = null;
let dragResizeTimer: ReturnType<typeof setTimeout> | null = null;
let lastDragResizeAt = 0;
// Whether the in-flight drag has actually changed a width yet. A cancel only
// persists if it has — otherwise a stray press-then-keystroke would rewrite
// config for a drag that never moved.
let dragDidResize = false;
// Where the info panel's list/detail split sits, as a fraction of the
// splittable rows. Unlike the two width drags this needs no relayout — the
// panel grid is rebuilt every frame — so it applies straight through with no
// throttle.
let infoPanelSplitRatio =
  configStore.config.infoPanelSplitRatio ?? DEFAULT_PANEL_SPLIT_RATIO;
const DRAG_RESIZE_INTERVAL_MS = 33; // ~30fps, matching RENDER_INTERVAL_ACTIVE
const toolbarEnabled = true;
// Opt-in second toolbar row showing each window's git branch. Read once at
// startup; changing it requires a restart (toolbarHeight feeds PTY sizing).
const windowBranchesEnabled = configStore.config.windowBranches === true;
const toolbarHeight = toolbarEnabled ? (windowBranchesEnabled ? 2 : 1) : 0;
// Per-repo workflow settings. Only the git facts are cached (see RepoFactsCache);
// the config half is read fresh on every resolution so a settings edit applies
// without an invalidation step. There is deliberately no module-level
// `claudeCommand` any more — the answer depends on which repo you are asking about.
const repoFacts = new RepoFactsCache();

/** Effective workflow settings for a directory. A null dir yields global defaults. */
function repoSettingsFor(dir: string | null | undefined): ResolvedRepoSettings {
  if (!dir) return resolveForRepo(configStore.config, { key: null, bare: false });
  return resolveForRepo(configStore.config, repoFacts.get(dir));
}

/** The directory a live session is rooted in, or null if we don't know it yet. */
function sessionDir(name: string): string | null {
  const session = currentSessions.find((s) => s.name === name);
  return session ? (sessionDetailsCache.get(session.id)?.path ?? null) : null;
}

/** Effective settings for the session the user is currently attached to. */
function currentRepoSettings(): ResolvedRepoSettings {
  const name = currentSessions.find((s) => s.id === currentSessionId)?.name;
  return repoSettingsFor(name ? sessionDir(name) : null);
}

/** The global-default tier alone, with built-in defaults filled in. */
function repoDefaultsView(): ResolvedRepoSettings {
  return resolveForRepo({ repoDefaults: configStore.config.repoDefaults }, { key: null, bare: false });
}

let cacheTimersEnabled = configStore.config.cacheTimers !== false;
let autoPinAgentPanes = configStore.config.autoPinAgentPanes === true;
let agentPaneRegex = configStore.config.agentPaneCommandRegex ?? "codex";
let pinnedSessions = new Set<string>(configStore.config.pinnedSessions ?? []);
let infoPanelWidth: number | null = configStore.config.infoPanelWidth ?? null;
let diffPanelSplitRatio = configStore.config.diffPanel?.splitRatio ?? 0.4;
let hunkCommand = configStore.config.diffPanel?.hunkCommand ?? "hunk";

// jmuxDir / configFile are resolved far above, before the subcommand branches.

// Parse args: jmux [session] [--socket name] [--demo]
let sessionName: string | undefined;
let socketName: string | undefined = demoCtx?.socketName;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--demo") {
    continue; // already handled above
  } else if (arg === "--live") {
    // Handled above, but only meaningful alongside --demo. Silently ignoring it
    // would leave someone watching a sidebar of seeded state believing they
    // were looking at real agents.
    if (!demoMode) {
      console.error("--live requires --demo");
      process.exit(1);
    }
    continue;
  } else if (arg === "--socket" || arg === "-L") {
    if (demoMode) {
      console.error("--socket cannot be used with --demo");
      process.exit(1);
    }
    socketName = process.argv[++i];
  } else if (arg.startsWith("-")) {
    console.error(`Unknown option: ${arg}`);
    console.error("Run 'jmux --help' for usage.");
    process.exit(1);
  } else if (!sessionName) {
    sessionName = arg;
  } else {
    console.error(`Unexpected argument: ${arg}`);
    console.error("Run 'jmux --help' for usage.");
    process.exit(1);
  }
}
// Preflight checks — offer to install missing dependencies
function hasCommand(cmd: string[]): boolean {
  try {
    return Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
}

/** `tmux -V` output, or null when tmux is not installed. */
function tmuxVersionOutput(): string | null {
  try {
    const result = Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return null;
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

async function preflight(): Promise<void> {
  const missing: string[] = [];
  const version = tmuxVersionOutput();

  if (version === null) {
    missing.push("tmux");
  } else if (!tmuxVersionOk(version)) {
    // Previously this only checked that `tmux -V` exited 0, so a user on 2.8
    // sailed through and hit a confusing failure later. This path serves the
    // brew and npm channels, which the shell installer never touches.
    console.log(`\njmux requires tmux ${MIN_TMUX_VERSION} or newer (you have ${version.replace(/^tmux /, "")}).`);
    console.log(
      process.platform === "darwin"
        ? "Upgrade with:\n\n  brew upgrade tmux\n"
        : "Upgrade it with your package manager, or build from source.\n",
    );
    process.exit(1);
  }

  if (missing.length === 0) return;

  const isMac = process.platform === "darwin";
  const hasBrew = isMac && hasCommand(["brew", "--version"]);
  const hasApt = !isMac && hasCommand(["apt", "--version"]);

  console.log(`\njmux requires ${missing.join(" and ")} to run.\n`);

  if (hasBrew || hasApt) {
    const pm = hasBrew ? "brew" : "sudo apt";
    const installCmd = `${pm} install ${missing.join(" ")}`;
    console.log(`Install with:\n\n  ${installCmd}\n`);

    // Prompt to install
    process.stdout.write("Install now? [Y/n] ");
    const response = await new Promise<string>((resolve) => {
      process.stdin.setRawMode?.(false);
      process.stdin.resume();
      process.stdin.once("data", (data) => {
        process.stdin.pause();
        resolve(data.toString().trim().toLowerCase());
      });
    });

    if (response === "" || response === "y" || response === "yes") {
      console.log(`\nRunning: ${installCmd}\n`);
      try {
        const args = hasBrew
          ? ["brew", "install", ...missing]
          : ["sudo", "apt-get", "install", "-y", ...missing];
        const result = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
        if (result.exitCode !== 0) {
          console.error("\nInstallation failed. Please install manually and try again.");
          process.exit(1);
        }
      } catch {
        console.error("\nInstallation failed. Please install manually and try again.");
        process.exit(1);
      }
      console.log("\nDependencies installed. Starting jmux...\n");
      return;
    }
  } else {
    // No package manager detected — just show instructions
    if (isMac) {
      console.log("Install Homebrew first: https://brew.sh");
      console.log(`Then run: brew install ${missing.join(" ")}`);
    } else {
      console.log(`Install with your package manager, e.g.:`);
      console.log(`  apt install ${missing.join(" ")}`);
      console.log(`  dnf install ${missing.join(" ")}`);
      console.log(`  pacman -S ${missing.join(" ")}`);
    }
  }

  process.exit(1);
}
await preflight();

const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;
// Single source of truth for the frame's column geometry (sidebar │ border │
// main │ divider │ panel) — see src/frame-layout.ts. `relayout()` (defined
// once `pty`/`bridge`/`sidebar`/`inputRouter` exist, below) recomputes this on
// every resize/diff-panel/sidebar-width change; this initial call only seeds
// the values needed to construct those objects at boot.
let layout: FrameLayout = computeFrameLayout({
  termCols: cols,
  termRows: rows,
  sidebarWidth,
  borderWidth: BORDER_WIDTH,
  toolbarRows: toolbarHeight,
  diffState: "off",
  requestedPanelCols: 0,
  // Matches relayout()'s `base` (below) — the top rule is on from first
  // paint; the footer is disabled (see main.ts footer-removal notes).
  frameRulesEnabled: true,
  footerEnabled: false,
});
let mainCols = layout.main.w;

// The settings screen and Command Center (glass) are full-screen takeovers
// with no window tabs — they pass toolbar: null — so they render through
// this dedicated chrome-less layout instead of the shared toolbar-ful
// `layout` above: toolbarRows: 0 collapses resolveChrome's whole ladder to
// NONE (see frame-layout.ts), so there's no blank toolbar-row strip above
// them and no footer band clipping their bottom. Column geometry (sidebar
// span, borderCol, main.x) is identical to `layout` — only the row bands
// differ — so this is recomputed alongside `layout` everywhere `layout`
// changes (relayout()) and applied via applyChromeLayout() whenever the
// settings/glass mode itself is entered or left (those transitions don't
// go through relayout()).
let fullScreenLayout: FrameLayout = computeFrameLayout({
  termCols: cols,
  termRows: rows,
  sidebarWidth,
  borderWidth: BORDER_WIDTH,
  toolbarRows: 0,
  diffState: "off",
  requestedPanelCols: 0,
  frameRulesEnabled: false,
  footerEnabled: false,
});

// Toolbar buttons and window tabs
let hoveredToolbarButton: string | null = null;
let currentWindows: WindowTab[] = [];
let hoveredTabId: string | null = null;
let hoveredPanelTabId: string | null = null;
let startupComplete = false;

function getSnapshotHealth(): import("./snapshot").SnapshotHealth {
  // Suppressed when the user has explicitly opted out of snapshots.
  if (!configStore.config.snapshot?.enabled) return "disabled";
  // A permanently-lost control channel is reported first — capture is stopped.
  if (controlChannelLost) return "control_channel_lost";
  // Once the Snapshotter is up it owns the health verdict (per-subsystem signals).
  if (snapshotter) return snapshotter.getHealth();
  // Before/without a Snapshotter, fall back to the boot lock outcome so a
  // locked-out or errored boot still surfaces a specific state (this is the
  // exact gap that hid the two-month silent failure).
  return boot?.lockHealth ?? "starting";
}

/** Maps a health verdict to a short toolbar label, or null when nothing is wrong. */
function snapshotChipLabel(h: import("./snapshot").SnapshotHealth): string | null {
  switch (h) {
    case "disabled":
    case "healthy":
    case "starting":
      return null;
    case "locked_live":
      return "snapshot: other jmux";
    case "stale":
      return "snapshot stale";
    case "error":
      return "snapshot error";
    case "stopped":
      return "snapshot off";
    case "control_channel_lost":
      return "control lost";
  }
}

function makeToolbar(): ToolbarConfig {
  return {
    buttons: buildToolbarButtons({ panelActive: diffPanel.isActive() }),
    mainCols,
    hoveredButton: hoveredToolbarButton,
    tabs: currentWindows,
    hoveredTabId,
    // A live undo takes the chip: it is transient and time-boxed, and being
    // able to take the write back matters more for those 20s than ambient
    // snapshot health does.
    statusChip: undoChipLabel() ?? toastLabel() ?? snapshotChipLabel(getSnapshotHealth()),
  };
}

/**
 * Builds the footer's model from live state. The footer itself is disabled
 * (footerEnabled: false) — the snapshot chip and version indicator moved
 * back to the toolbar and sidebar respectively (see makeToolbar()'s
 * statusChip and sidebar.ts's version render / isVersionRow). This stays
 * only so footer.ts remains trivially re-enableable; it's unused at runtime.
 */
function makeFooter(): FooterModel {
  return buildFooter({
    snapshotChip: snapshotChipLabel(getSnapshotHealth()),
    version: sidebar.getVersion(),
    updateAvailable: sidebar.hasUpdate() ? `v${sidebar.getLatestVersion()} avail` : null,
  });
}

// --- Durable-session boot helper ---

async function performBoot(opts: {
  socketName: string | undefined;
  configFile: string;
  config: import("./config").JmuxConfig;
  sessionState: import("./session-state").SessionState;
  pinnedSessions: Set<string>;
}): Promise<{
  attachSessionName: string | null;
  snapshotDir: string;
  postRestoreActions: Array<() => void>;
  snapshotLock: import("./snapshot/deps").Lock | null;
  lockedOut: boolean;
  lockHealth: import("./snapshot").SnapshotHealth;
}> {
  const {
    ProductionFileSystem,
    ProductionTmuxRunner,
    ProductionClock,
    Restorer,
    resolveSnapshotDir,
    isSnapshotTempName,
  } = await import("./snapshot");

  const dir = resolveSnapshotDir({
    override: opts.config.snapshot?.dir ?? null,
    socketName: opts.socketName ?? null,
    xdgDataHome: process.env.XDG_DATA_HOME ?? null,
    home: process.env.HOME ?? "/tmp",
  });

  if (!opts.config.snapshot?.enabled) {
    return { attachSessionName: null, snapshotDir: dir, postRestoreActions: [], snapshotLock: null, lockedOut: false, lockHealth: "disabled" };
  }

  const fs = new ProductionFileSystem();
  const runner = new ProductionTmuxRunner(opts.socketName ?? null);
  const clock = new ProductionClock();

  // Sweep orphaned temp files from a prior crash. writeAtomic names them
  // `<file>.tmp.<pid>.<counter>`, so match that pattern (not just `.tmp`).
  const entries = await fs.readDir(dir).catch(() => [] as string[]);
  for (const e of entries) {
    if (isSnapshotTempName(e)) await fs.unlink(`${dir}/${e}`).catch(() => undefined);
  }
  const scrollbackDir = `${dir}/scrollback`;
  const sessionDirs = await fs.readDir(scrollbackDir).catch(() => [] as string[]);
  for (const sd of sessionDirs) {
    const files = await fs.readDir(`${scrollbackDir}/${sd}`).catch(() => [] as string[]);
    for (const f of files) {
      if (isSnapshotTempName(f)) await fs.unlink(`${scrollbackDir}/${sd}/${f}`).catch(() => undefined);
    }
  }

  // Migration: builds <=0.21.1 left a 0-byte O_EXCL lock file at `${dir}/.lock`
  // that never auto-released and permanently deadlocked snapshotting. proper-lockfile
  // uses `${dir}/.lock.lock` instead, so the legacy file is inert — remove it so
  // it can't confuse tooling or a human inspecting the directory.
  const legacyLock = await fs.stat(`${dir}/.lock`).catch(() => null);
  if (legacyLock && legacyLock.size === 0) {
    await fs.unlink(`${dir}/.lock`).catch(() => undefined);
  }

  // Collect actions that require OtelReceiver (constructed after performBoot).
  const postRestoreActions: Array<() => void> = [];

  // Mutable variable filled in after eligibility check; the agentStateSink
  // closure is only ever called during restorer.run() which requires
  // eligibility.ok === true, so capturedAt is always set by call time.
  let restoreCapturedAt: string = "";

  const restorer = new Restorer({
    dir,
    fs,
    runner,
    clock,
    jmuxVersion: process.env.JMUX_VERSION ?? "dev",
    userShell: process.env.SHELL ?? "/bin/sh",
    resolveClaudeCommand: (cwd) => repoSettingsFor(cwd).claudeCommand,
    configFile: opts.configFile,
    // If our held lock is reclaimed while running, tell the Snapshotter so it
    // stops capturing and surfaces `error` instead of silently double-writing.
    onLockCompromised: (e) => snapshotter?.handleCompromised(e),
    sessionLinksSink: (name, links) => opts.sessionState.upsertLinksForSession(name, links),
    pinnedSink: (name, pinned) => {
      if (pinned && !opts.pinnedSessions.has(name)) {
        opts.pinnedSessions.add(name);
        // Persist the restored pinned state — configStore is in scope at call site.
        configStore.set("pinnedSessions", [...opts.pinnedSessions]);
      }
    },
    agentStateSink: (name, agentState) => {
      if (!agentState) return;
      const TEN_MIN_MS = 10 * 60 * 1000;
      const coerced = coerceStaleAgentState(
        agentState,
        restoreCapturedAt,
        Date.now(),
        TEN_MIN_MS,
      );
      if (!coerced) return;
      const sinceEpoch = Math.floor(Date.parse(coerced.since) / 1000);
      // Chain so a partial failure can't leave state set with stale-or-missing since.
      // Fire-and-forget; failures on restore are harmless (the renderer falls back
      // to the empty state via the row-1 timer chain).
      void (async () => {
        try {
          await runner.run(["set-option", "-t", name, "@jmux-agent-state", coerced.state]);
          await runner.run(["set-option", "-t", name, "@jmux-agent-state-since", String(sinceEpoch)]);
        } catch {
          // Best-effort: tmux runner failure during restore is non-fatal.
        }
      })();
    },
    permissionModeSink: (name, mode) => {
      postRestoreActions.push(() => {
        otelReceiverRef.current?.setPermissionMode(name, mode);
      });
    },
    otelSink: (name, otel) => {
      if (!otel) return;
      postRestoreActions.push(() => {
        otelReceiverRef.current?.setSessionSnapshot(name, otel);
      });
    },
  });

  const eligibility = await restorer.checkEligibility();

  // Another live jmux holds the lock — we cannot restore or capture.
  // Skip Snapshotter construction entirely (lockedOut=true signals this to the caller).
  if (!eligibility.ok && eligibility.reason === "locked") {
    return { attachSessionName: null, snapshotDir: dir, postRestoreActions: [], snapshotLock: null, lockedOut: true, lockHealth: "locked_live" };
  }

  // The lock layer hit a hard error (e.g. EACCES / unwritable dir). We can't
  // snapshot, but this is a problem to surface, not a normal "another jmux".
  if (!eligibility.ok && eligibility.reason === "lock_error") {
    return { attachSessionName: null, snapshotDir: dir, postRestoreActions: [], snapshotLock: null, lockedOut: true, lockHealth: "error" };
  }

  // For all other outcomes (ok or ineligible-but-not-locked) the lock IS held by the
  // Restorer.  Transfer it to the caller so it can be handed to the Snapshotter.
  const snapshotLock = restorer.takeLock();

  if (eligibility.ok) {
    restoreCapturedAt = eligibility.snapshot.capturedAt;
    process.stdout.write(
      `restoring ${eligibility.snapshot.sessions.length} sessions from ${eligibility.snapshot.capturedAt}...\n`,
    );
    await restorer.run(eligibility.snapshot);
    return {
      attachSessionName: restorer.attachTarget(),
      snapshotDir: dir,
      postRestoreActions,
      snapshotLock,
      lockedOut: false,
      lockHealth: "healthy",
    };
  }

  return { attachSessionName: null, snapshotDir: dir, postRestoreActions: [], snapshotLock, lockedOut: false, lockHealth: "healthy" };
}

// Enter alternate screen, raw mode, enable mouse tracking
process.stdout.write("\x1b[?1049h");
process.stdout.write("\x1b[?1000h"); // mouse button tracking
process.stdout.write("\x1b[?1003h"); // mouse motion tracking (hover)
process.stdout.write("\x1b[?1006h"); // SGR extended mouse mode
process.stdout.write("\x1b[?2004h"); // bracketed paste mode
if (process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}

// Ask the terminal for its background color so modal/sidebar surfaces can be
// derived from the real theme rather than a hardcoded dark palette. The reply
// arrives asynchronously on stdin; terminals that don't support OSC 11 simply
// never answer and we keep DEFAULT_THEME.
process.stdout.write(OSC11_QUERY);

// Wire stdin to the gate from the moment the query is sent — before the async
// boot below. This is load-bearing: Bun discards data that lands on a resumed
// stream with no `data` listener, so a fast terminal's OSC 11 reply would be
// dropped across `await performBoot`, leaving every chrome surface on the dark
// fallback theme (the light-theme bug). The gate resolves the background the
// instant its reply arrives and buffers any keystrokes until the input pipeline
// is live — see stdinGate.markReady() further down.
let stdinReady = false;
let lastDetectedBg: number | null = null;
// Declared here — before `await performBoot` below — because onBackground can
// fire during boot (when the OSC 11 reply lands) and reaches applyPaneStyles,
// which reads controlStarted. Declaring it after the await would leave it in the
// temporal dead zone at that moment and crash the boot.
let controlStarted = false;
const stdinGate = new StdinGate({
  onBackground: (rgb) => {
    const packed = pack(rgb);
    // Live re-detection re-queries periodically; ignore replies that report the
    // same background so a steady theme is a no-op, not a re-theme every poll.
    if (packed === lastDetectedBg) return;
    lastDetectedBg = packed;
    setTheme(deriveTheme(rgb));
    // Must run FIRST: the chrome tokens (accent, neutral ramp, rules) are
    // derived from the freshly-detected theme, and rebuildSidebarColors/
    // rebuildModalAttrs/etc. below read tokens.* — so a stale token here would
    // leave every chrome surface on the dark defaults over a light terminal.
    rebuildChromeTokens();
    rebuildModalAttrs();
    rebuildSidebarColors();
    rebuildInfoPanelColors();
    rebuildSettingsColors();
    rebuildWorkflowColors();
    rebuildGhostPreviewColors();
    // rebuildPanelViewColors also re-derives the shared issue-detail attrs, so
    // the preview's body tracks the theme through the same call.
    rebuildPanelViewColors();
    applyPaneStyles(); // re-issue tmux window-style fades for the new theme
    // Pre-ready, the first paint after boot reads the freshly themed values;
    // once live (startup done or a theme change), an explicit repaint is needed.
    if (stdinReady) scheduleRender();
  },
  onInput: (str) => {
    markInputActivity();
    inputRouter.handleInput(str);
  },
  // Only ever fires while armed, which is after the graphics state below is
  // declared — see probeTerminalGraphics().
  onImageProbe: ({ supported, cellPx }) => {
    if (supported !== null) imagesSupported = supported;
    if (cellPx) imageCellPx = cellPx;
    applyImageSupport();
  },
  gridSize: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
});
process.stdin.on("data", (data: Buffer) => stdinGate.feed(data.toString()));
process.stdin.resume();

// SessionState must be constructed before performBoot so restore can populate links.
const sessionStatePath = demoCtx?.statePath ?? resolve(homedir(), ".config", "jmux", "state.json");
const sessionState = new SessionState(sessionStatePath);

// Forward reference used by performBoot's deferred otel sinks.
// OtelReceiver is constructed just after performBoot; sinks are replayed immediately after.
const otelReceiverRef: { current: OtelReceiver | null } = { current: null };

// Run restore-before-attach boot phase.
let boot: Awaited<ReturnType<typeof performBoot>>;
try {
  boot = await performBoot({
    socketName,
    configFile,
    config: configStore.config,
    sessionState,
    pinnedSessions,
  });
} catch (err) {
  process.stdout.write("\x1b[?1049l");
  process.stdin.setRawMode?.(false);
  throw err;
}

// Core components
let attachMode: "strictAttach" | "createOrAttach" = "createOrAttach";
let attachSessionName = boot.attachSessionName ?? undefined;
if (boot.attachSessionName) {
  // Confirm the restored session still exists before committing to strictAttach.
  // There is a window between performBoot and TmuxPty construction where the session
  // could have been destroyed, which would cause tmux attach-session to exit immediately.
  const { ProductionTmuxRunner: BootRunner } = await import("./snapshot");
  const check = await new BootRunner(socketName || null).run(["has-session", "-t", boot.attachSessionName]);
  if (check.exitCode === 0) {
    attachMode = "strictAttach";
  } else {
    // session vanished post-restore — fall back, let tmux pick a session
    attachSessionName = undefined;
  }
}
const pty = new TmuxPty({
  sessionName: attachSessionName ?? sessionName,
  socketName,
  configFile,
  jmuxDir,
  cols: mainCols,
  rows: layout.ptyRows,
  attachMode,
});
const bridge = new ScreenBridge(mainCols, layout.ptyRows);
const renderer = new Renderer();

// --- Terminal graphics -------------------------------------------------------
//
// Inline images in issue previews, drawn with the kitty graphics protocol.
// jmux can do this at all because it is the outermost program on the terminal —
// tmux runs inside a pty it owns, so none of this goes through tmux and none of
// tmux's passthrough rules apply.
//
// The whole feature hangs off one switch: with no port installed, issue detail
// linkifies images exactly as it always did. So a terminal that can't draw, a
// terminal that never answers the probe, and a user who turned it off all take
// the identical, well-worn path — there is no degraded mode to keep working.
const imageStore = new ImageStore(process.pid);
const imagePlane = new ImagePlane(
  (id) => imageStore.getById(id),
  () => imageStore.takeFreedIds(),
);
let imageCellPx: CellPixels = DEFAULT_CELL_PIXELS;
let imagesSupported: boolean | null = null;
const storeImagePort = new StoreImagePort(imageStore, {
  cellPx: () => imageCellPx,
  maxRows: () => configStore.config.images?.maxRows ?? DEFAULT_IMAGE_MAX_ROWS,
});
imageStore.onChange(() => scheduleRender());

/**
 * Config wins over detection in both directions. Forcing this on won't make an
 * incapable terminal draw pictures — it'll make it print escape sequences — but
 * a terminal that answers the probe wrongly is exactly the case a detected
 * default can't fix by itself.
 */
function imagesOn(): boolean {
  const forced = configStore.config.images?.enabled;
  return forced !== undefined ? forced : imagesSupported === true;
}

function applyImageSupport(): void {
  const on = imagesOn();
  setImagePort(on ? storeImagePort : null);
  renderer.setImagePlane(on ? imagePlane : null);
  // Guarded exactly like the OSC 11 background handler's repaint, and for the
  // same two reasons. Pre-ready there is no frame to repaint — the first paint
  // after boot reads this state anyway — and, load-bearing, this function runs
  // once at module scope, where `scheduleRender` would touch module state
  // declared further down the file and die in its temporal dead zone. Any
  // startup-time call from up here owes the same check.
  if (stdinReady) scheduleRender();
}

/** How long the stdin scanner stays armed waiting for a probe reply. */
const IMAGE_PROBE_WINDOW_MS = 1500;
let cellSizeProbeAt = 0;

function probeTerminalGraphics(cellSizeOnly = false): void {
  stdinGate.armImageProbe();
  process.stdout.write(cellSizeOnly ? CELL_SIZE_PROBE : GRAPHICS_PROBE + CELL_SIZE_PROBE);
  cellSizeProbeAt = Date.now();
  setTimeout(() => stdinGate.disarmImageProbe(), IMAGE_PROBE_WINDOW_MS);
}

/**
 * Re-ask for cell geometry after a resize — the same window can come back with
 * a different font size, and every image's aspect ratio is computed from it.
 * Throttled because a dragged window corner fires SIGWINCH continuously.
 */
function maybeReprobeCellSize(): void {
  if (!imagesOn()) return;
  if (Date.now() - cellSizeProbeAt < 1000) return;
  probeTerminalGraphics(true);
}

applyImageSupport();
probeTerminalGraphics();
const sidebar = new Sidebar(sidebarWidth, sidebarBottomRow(layout));
sidebar.setStateColors(resolveStateColors(configStore.config.stateColors));
// Restore the persisted group + sort modes (filter is deliberately ephemeral — a
// persisted filter that hides sessions is the "where did they go?" trap). Prefer
// the split axes; if only the pre-split `sidebarSort` is present, migrate it.
{
  const savedGroup = configStore.config.sidebarGroupBy;
  const savedSort = configStore.config.sidebarSortBy;
  const hasSplit =
    (savedGroup && (GROUP_MODES as readonly string[]).includes(savedGroup)) ||
    (savedSort && (SORT_MODES as readonly string[]).includes(savedSort));
  if (hasSplit) {
    if (savedGroup && (GROUP_MODES as readonly string[]).includes(savedGroup)) {
      sidebar.setGroupMode(savedGroup);
    }
    if (savedSort && (SORT_MODES as readonly string[]).includes(savedSort)) {
      sidebar.setSortMode(savedSort);
    }
  } else {
    const legacy = configStore.config.sidebarSort;
    const LEGACY: readonly string[] = ["project", "status", "activity", "name"];
    if (legacy && LEGACY.includes(legacy)) {
      const { groupBy, sortBy } = migrateLegacySort(legacy as LegacySortMode);
      sidebar.setGroupMode(groupBy);
      sidebar.setSortMode(sortBy);
    }
  }
}

/** Set the sidebar group mode and persist it, so it survives restart. */
function applySidebarGroup(mode: GroupMode): void {
  sidebar.setGroupMode(mode);
  configStore.set("sidebarGroupBy", mode);
  // The grouping axis decides both where ghosts land and which stages they come
  // from — per-stage on the stage axis, the Up next set anywhere else — so the
  // set has to be rebuilt when the axis changes, not just re-placed.
  recomputeGhosts();
}
/** Set the sidebar member-sort mode and persist it, so it survives restart. */
function applySidebarSort(mode: SortMode): void {
  sidebar.setSortMode(mode);
  configStore.set("sidebarSortBy", mode);
}
const agentStateTracker = new AgentStateTracker();
agentStateTracker.onChange((sessionId) => {
  const record = agentStateTracker.getRecord(sessionId);
  sidebar.setAgentStateRecord(sessionId, record);
  // "Agent needs attention" is an unpark trigger, so a state change can pull a
  // session back out of the band.
  recomputeSessionBands();

  // Mirror to snapshot if snapshotter is up.
  const sessionName = currentSessions.find((s) => s.id === sessionId)?.name;
  if (sessionName) {
    const snapState = record
      ? { state: record.state, since: new Date(record.since).toISOString() }
      : null;
    snapshotter?.onAgentState(sessionName, snapState);
  }

  // Keep the Command Center live as agents change state — refresh both the
  // breakdown (manual pins) and auto-detected agent panes.
  if (pinnedTracker.size > 0 || autoPinAgentPanes) refreshPinnedPanes();

  scheduleRender();
});
// --- Pane-of-glass wiring ---

const pinnedTracker = new PinnedPaneTracker();

// Whether the Overview (pane-of-glass) view is currently shown, and its renderer.
let inGlass = false;
/** The real session the interactive client was on before glass parked it. */
let preGlassSessionId: string | null = null;
let glassView: GlassView | null = null;

let commandCenterTabs: TabEntry[] = normalizeTabs(configStore.config.commandCenterTabs);
let activeTabId: string = defaultTabId(commandCenterTabs);
let lastActiveTabId: string = activeTabId;
let currentStripChips: PlacedChip[] = [];
let summaryByTab = new Map<string, AgentState | null>();

const glassRunner = {
  run: (args: string[]): { ok: boolean; lines: string[] } => {
    const socketArgs = socketName ? ["-L", socketName] : [];
    const proc = Bun.spawnSync(["tmux", ...socketArgs, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const ok = (proc.exitCode ?? 1) === 0;
    const lines = proc.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return { ok, lines };
  },
};

const otelReceiver = new OtelReceiver({
  onAgentResumeHint: (sessionName) => {
    const id = currentSessions.find((s) => s.name === sessionName)?.id;
    if (!id) return;
    if (agentStateTracker.getState(id) !== "waiting") return;
    // Correct every pane of this session that is parked in `waiting`. This has
    // to be a per-pane write: state is pane-scoped now, so a session-scoped
    // set-option would be shadowed by any pane holding its own value and the
    // stale `waiting` would survive.
    const stuck = agentStateTracker.findPanesInState(id, "waiting");
    if (stuck.length === 0) return;
    // Chain the two writes so we never leave a pane with state=running
    // and since=stale-from-waiting. Fire-and-forget; failures are harmless.
    void (async () => {
      const since = Math.floor(Date.now() / 1000);
      for (const paneId of stuck) {
        try {
          await control.sendCommand(
            `set-option -p -t ${tq(paneId)} @jmux-agent-state running`,
          );
          await control.sendCommand(
            `set-option -p -t ${tq(paneId)} @jmux-agent-state-since ${since}`,
          );
        } catch {
          // Best-effort: control-channel failure leaves the previous state intact.
        }
      }
    })();
  },
});
otelReceiverRef.current = otelReceiver;
// Replay any restore actions that required OtelReceiver (permissionMode, otel state).
for (const fn of boot.postRestoreActions) fn();
sidebar.cacheTimersEnabled = cacheTimersEnabled;
sidebar.setPinnedSessions(pinnedSessions);
const control = new TmuxControl();
const diffPanel = new DiffPanel();
let diffBridge: ScreenBridge | null = null;
let diffPty: import("bun-pty").Terminal | null = null;
let diffPanelFocused = false;
const settingsScreen = new SettingsScreen();
const workflowScreen = new WorkflowScreen();
const ghostPreview = new GhostPreview();

import { SettingsScreen, rebuildSettingsColors, type SettingDef, type SettingsCategory, type SettingsAction } from "./settings-screen";
import { WorkflowScreen, rebuildWorkflowColors, TRANSITIONS_BAND, type WorkflowPort, type WorkflowBand, type SettingsTier } from "./workflow-screen";
import { GhostPreview, rebuildGhostPreviewColors, type GhostPreviewPort, type StartOutcome } from "./ghost-preview";
import { buildPreflight, type Preflight } from "./ghost-preflight";
import { resolveNavStep, type NavFocus } from "./nav-order";

const adapters = demoCtx
  ? { codeHost: demoCtx.codeHost, issueTracker: demoCtx.issueTracker }
  : createAdapters(configStore.config.adapters);
const infoPanel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
let panelViews = parseViews(configStore.config.panelViews);
const viewStates = new Map<string, ViewState>();
for (const view of panelViews) {
  viewStates.set(view.id, createViewState());
}

async function initAdapters(): Promise<void> {
  if (adapters.codeHost) {
    await adapters.codeHost.authenticate();
    if (adapters.codeHost.authState !== "ok") {
      process.stderr.write(`jmux: ${adapters.codeHost.type} adapter auth failed — check ${adapters.codeHost.authHint}\n`);
    }
  }
  if (adapters.issueTracker) {
    await adapters.issueTracker.authenticate();
    if (adapters.issueTracker.authState !== "ok") {
      process.stderr.write(`jmux: ${adapters.issueTracker.type} adapter auth failed — check ${adapters.issueTracker.authHint}\n`);
    }
  }
  refreshPanelViews();
}

/**
 * Item count per issues tab, for the tab strip. Recomputed on each poll so the
 * strip answers "is anything urgent?" without switching tabs.
 */
function panelViewCounts(views: PanelView[]): Map<string, number> {
  const counts = new Map<string, number>();
  const states = getIssueSessionStates();
  const mrs = mrsByUrl();
  for (const view of views) {
    if (view.source !== "issues") continue;
    const items = transformIssues(issuesForView(view), new Set(), states, mrs);
    counts.set(view.id, buildViewNodes(items, view, new Set()).filter((n) => n.kind === "item").length);
  }
  return counts;
}

/** Re-publish the visible tab set to the panel (after auth, or a saved view). */
function refreshPanelViews(): void {
  const visibleViews = panelViews.filter((v) => {
    if (v.source === "issues") return adapters.issueTracker?.authState === "ok";
    if (v.source === "mrs") return adapters.codeHost?.authState === "ok";
    return false;
  });
  infoPanel.updateConfig({
    viewIds: visibleViews.map((v) => v.id),
    viewLabels: new Map(visibleViews.map((v) => [v.id, v.label])),
    viewCounts: panelViewCounts(visibleViews),
  });
}

const pollCoordinator = new PollCoordinator({
  codeHost: adapters.codeHost,
  issueTracker: adapters.issueTracker,
  onUpdate: (sessionName) => {
    sidebar.setSessionContexts(pollCoordinator.getAllContexts());
    // A poll is the main way a stage changes (and the only way an unpark
    // signal arrives), so both bands are re-derived on every one.
    recomputeSessionBands();
    checkMrTransitions();
    refreshPanelViews();
    if (sessionName === "__global__") refreshTeams();
    scheduleRender();
  },
  getSessionDir: (name) => {
    const session = currentSessions.find((s) => s.name === name);
    return session ? (sessionDetailsCache.get(session.id)?.path ?? null) : null;
  },
  sessionState,
});

initAdapters().then(() => {
  pollCoordinator.start();
  pollCoordinator.pollGlobal();
  refreshTeams();
  scheduleRender();
}).catch((e) => {
  logError("jmux", `adapter init failed, panel running without adapters: ${(e as Error).message}`);
});

let cachedTeams: Array<{ id: string; name: string }> = [];
let lastTeamFetchMs = 0;
const TEAM_REFRESH_INTERVAL_MS = 300_000; // 5 minutes

async function refreshTeams(): Promise<void> {
  if (adapters.issueTracker?.authState !== "ok") return;
  if (Date.now() - lastTeamFetchMs < TEAM_REFRESH_INTERVAL_MS && cachedTeams.length > 0) return;
  try {
    cachedTeams = await adapters.issueTracker.getTeams();
    lastTeamFetchMs = Date.now();
  } catch (e) {
    logError("jmux", `team fetch failed: ${(e as Error).message}`);
  }
  try {
    cachedWorkflowStates = await adapters.issueTracker.listWorkflowStates();
  } catch (e) {
    logError("jmux", `workflow state fetch failed: ${(e as Error).message}`);
  }
}

/**
 * Every workflow state the tracker offers, for the stage/transition pickers.
 * Empty when the tracker is unauthenticated or exposes no real workflow —
 * settings surfaces that rather than showing an empty picker with no reason.
 */
let cachedWorkflowStates: WorkflowState[] = [];

function workflowStateOptions(): Array<{ id: string; label: string }> {
  return cachedWorkflowStates.map((s) => ({ id: s.name, label: s.name }));
}

// --- Parking ---
//
// Baselines are in-memory only. On restart a parked session simply re-parks
// and captures a fresh baseline, so signals raised while jmux was down are not
// replayed. The main path survives that: a QA-Failed issue changes *stage*, and
// stage is re-derived from the tracker on every poll.
const parkBaselines = new Map<string, ParkBaseline>();

function parkingConfig(): ParkingConfig {
  const p = configStore.config.pipeline;
  return {
    unparkOn: p?.unparkOn ?? DEFAULT_PARKING.unparkOn,
    autoParkIdleDays: p?.autoParkIdleDays ?? DEFAULT_PARKING.autoParkIdleDays,
  };
}

/** Statuses that park, as a stage map. The one thing behaviour keys off. */
function parkedStates(): string[] {
  return configStore.config.pipeline?.parkedStates ?? [];
}

function derivedStages(): Record<WorkStage, string[]> {
  return parkedStages(parkedStates());
}

/** Stage of a session's linked issue, or null when it has none. */
function stageOfSession(name: string): WorkStage | null {
  const issue = pollCoordinator.getContext(name)?.issues[0];
  if (!issue) return null;
  return stageForIssue(issue, derivedStages());
}

/**
 * Recompute where each session sits in the sidebar: the Parked band, and the
 * workflow stage it groups under. Cheap and idempotent, so it can run on any
 * signal that might change the answer (session list changes, poll updates,
 * agent-state changes, config edits).
 *
 * Both bands are derived from the same fact — the session's linked issue — so
 * they are computed in one pass. Splitting them would mean two functions that
 * always have to be called together, from every one of these call sites.
 */
function recomputeSessionBands(): void {
  const config = parkingConfig();
  const now = Date.now();
  const parked = new Set<string>();
  const stages = new Map<string, StageBucket>();
  const live = new Set(currentSessions.map((s) => s.name));

  for (const session of currentSessions) {
    const name = session.name;
    const stage = stageOfSession(name);

    // An override answers "for this situation"; once the stage moves on it no
    // longer applies, or one manual unpark would suppress parking forever.
    const stored = sessionState.getParkOverride(name);
    const fresh = clearStaleOverride(stored, stage);
    if (stored && !fresh) sessionState.setParkOverride(name, null);

    const ctx = pollCoordinator.getContext(name);

    // The stage band: the session's linked issue, projected through the user's
    // own stage definitions. Rank is the stage's position in `panelViews`,
    // which is the priority order the workflow screen reorders — so the sidebar
    // headers read top-to-bottom in the order they arranged their workflow.
    const issue = ctx?.issues[0];
    const stageView = issue ? stageForState(panelViews, issue.status) : null;
    // A stage hidden from the sidebar claims nothing for grouping: its sessions
    // fall to the flat remainder, exactly like a session whose status no stage
    // claims. Hiding the band must never hide the session.
    if (stageView && stageInSidebar(stageView)) {
      stages.set(name, {
        id: stageView.id,
        label: stageView.label,
        rank: panelViews.indexOf(stageView),
      });
    }

    const baseline = parkBaselines.get(name);
    const parkCtx: ParkContext = {
      stage,
      issues: ctx?.issues ?? [],
      mrs: ctx?.mrs ?? [],
    };
    const signals = baseline ? detectSignals(baseline, parkCtx) : new Set<UnparkTrigger>();
    const info = sidebar.getSortInfo(name);

    const shouldPark = isParked(
      {
        name,
        stage,
        manual: fresh?.manual ?? null,
        attention: info?.status === "waiting",
        signals,
        lastActivity: info?.lastActivity ?? now,
      },
      config,
      now,
    );

    if (shouldPark) {
      parked.add(name);
      // Capture the baseline on the parking edge, so "changed since parked"
      // has something to compare against.
      if (!baseline) parkBaselines.set(name, captureBaseline(parkCtx));
    } else {
      parkBaselines.delete(name);
    }
  }

  for (const name of parkBaselines.keys()) {
    if (!live.has(name)) parkBaselines.delete(name);
  }

  sidebar.setParkedSessions(parked);
  sidebar.setSessionStages(stages);
  recomputeGhosts();
}

/** The stored ghost-row cap. Conversions all live in ghosts.ts. */
function storedGhostCap(): unknown {
  return configStore.config.pipeline?.showUnstartedInSidebar ?? null;
}

/** The effective cap: 0 for off, Infinity for "all". */
function ghostCap(): number {
  return ghostCapValue(storedGhostCap());
}

/** Persist a new cap and repaint the band. */
function setGhostCap(next: GhostCap): void {
  configStore.setPipeline("showUnstartedInSidebar", next);
  recomputeGhosts();
  scheduleRender();
}

/**
 * Rebuild the sidebar's Up next band: the issues in your pull queues that have
 * no session yet.
 *
 * Called from `recomputeSessionBands` so it can never go stale — every signal
 * that changes the answer (a poll, a session appearing, a config edit) already
 * routes there. That funnel also carries signals which can't change the answer
 * (agent state, a few times a second), so this recomputes more often than it
 * strictly must. Measured at 0.24ms for 300 issues across 7 queues — well
 * inside a frame, and not worth an input-signature guard. The obvious candidate
 * for one, comparing `getGlobalIssues()` by reference, is unsound anyway: that
 * array is mutated in place by `addGlobalIssue` and by the targeted per-issue
 * refresh, so exactly the status change that should add or remove a ghost would
 * keep its identity and be missed.
 *
 * With the feature off it returns before doing any of the work.
 */
function recomputeGhosts(): void {
  const cap = ghostCap();
  if (cap === 0) {
    sidebar.setGhostSessions([]);
    return;
  }

  // Which stages contribute depends on where the rows will land.
  //
  // Grouped by stage, every stage shows the work sitting in it that nobody has
  // picked up — the row is filed under its own stage, so "which stage is this?"
  // is answered by where it sits and needs no gate.
  //
  // On any other axis the rows collect into one flat band that cannot say which
  // stage anything came from, so it falls back to the Up next set: the stages
  // the user has already declared they pull new work from.
  const perStage = sidebar.getGroupMode() === "stage";
  const sources = perStage
    ? panelViews.filter((v) => v.source === "issues" && stageShowsUnstarted(v)).map((v) => v.id)
    : (configStore.config.pipeline?.upNext ?? []).filter((id) => {
        // The flat band is fed by Up next, but a stage the user has switched off
        // shouldn't leak its work back in through the other placement.
        const view = panelViews.find((v) => v.id === id);
        return !view || stageShowsUnstarted(view);
      });
  if (sources.length === 0) {
    sidebar.setGhostSessions([]);
    return;
  }

  const byView = orderedIssuesByView();
  const sessionStates = getIssueSessionStates();
  const stages = derivedStages();

  const queues: GhostQueue[] = [];
  for (const viewId of sources) {
    const view = panelViews.find((v) => v.id === viewId);
    if (!view || view.source !== "issues") continue;
    queues.push({
      viewId,
      label: view.label,
      // Priority is the stage's position in the workflow screen, NOT its
      // position in `upNext` — see the note in ghosts.ts.
      rank: panelViews.indexOf(view),
      issues: (byView.get(viewId) ?? []).map((issue) => {
        const stage = stageForIssue(issue, stages);
        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          hasSession: sessionStates.get(issue.id)?.state === "session",
          // Done and parked work never becomes a ghost. Nothing gives a
          // completed issue a session, so those rows would accumulate under a
          // "Done" stage forever with no way to clear them.
          inactive: stage === "done" || stage === "parked",
        };
      }),
    });
  }

  // One selector for both placements: the cap is per stage either way, and rows
  // are always stage-tagged — the sidebar files them by tag when it is banding
  // by stage and ignores the tag when it is not.
  sidebar.setGhostSessions(selectGhosts(queues, cap));
}

// --- Status transitions ---
//
// The one place jmux writes to a shared tracker. Everything here is opt-in per
// repo and per event; with no configuration these functions do nothing.

const UNDO_WINDOW_MS = 20_000;

/** Last-seen MR states per session, for edge detection across polls. */
const mrSnapshots = new Map<string, MrSnapshot[]>();

interface PendingUndo {
  issueId: string;
  identifier: string;
  from: string;
  to: string;
  expiresAt: number;
}
let pendingUndo: PendingUndo | null = null;

function transitionConfirmMode(): "always" | "undo-toast" | "never" {
  return configStore.config.pipeline?.transitionConfirm ?? "undo-toast";
}

/** The toolbar chip text while an undo is still available, else null. */
function undoChipLabel(): string | null {
  if (!pendingUndo) return null;
  if (Date.now() > pendingUndo.expiresAt) { pendingUndo = null; return null; }
  return `${pendingUndo.identifier} → ${pendingUndo.to}  ^a Z undo`;
}

// A transient confirmation in the toolbar chip. Actions that deliberately
// leave you where you are still have to say they happened — a keypress with no
// visible effect is indistinguishable from one that failed.
let statusToast: { text: string; expiresAt: number } | null = null;
const TOAST_MS = 6_000;

function showToast(text: string): void {
  statusToast = { text, expiresAt: Date.now() + TOAST_MS };
  scheduleRender();
}

function toastLabel(): string | null {
  if (!statusToast) return null;
  if (Date.now() > statusToast.expiresAt) { statusToast = null; return null; }
  return statusToast.text;
}

async function applyTransition(
  issue: import("./adapters/types").Issue,
  event: TransitionEvent,
  target: string,
): Promise<void> {
  const tracker = adapters.issueTracker;
  if (!tracker || tracker.authState !== "ok") return;
  if (issue.status === target) return; // already there — nothing to say

  const from = issue.status;
  try {
    await tracker.updateStatus(issue.id, target);
  } catch (e) {
    logError("jmux", `transition failed for ${issue.identifier}: ${(e as Error).message}`);
    return;
  }

  if (transitionConfirmMode() !== "never") {
    pendingUndo = {
      issueId: issue.id,
      identifier: issue.identifier,
      from,
      to: target,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
    };
  }
  logError("jmux", `transition: ${issue.identifier} ${from} → ${target} (${TRANSITION_LABELS[event]})`);
  pollCoordinator.pollGlobal();
  scheduleRender();
}

/** Revert the most recent transition, if the undo window is still open. */
async function undoLastTransition(): Promise<void> {
  const undo = pendingUndo;
  if (!undo || Date.now() > undo.expiresAt) { pendingUndo = null; return; }
  pendingUndo = null;
  const tracker = adapters.issueTracker;
  if (!tracker || tracker.authState !== "ok") return;
  try {
    await tracker.updateStatus(undo.issueId, undo.from);
    pollCoordinator.pollGlobal();
  } catch (e) {
    logError("jmux", `undo failed for ${undo.identifier}: ${(e as Error).message}`);
  }
  scheduleRender();
}

/**
 * Run a transition through the configured confirmation policy. "always" asks
 * first; "undo-toast" writes and leaves an undo on screen; "never" writes
 * silently.
 */
async function requestTransition(
  issue: import("./adapters/types").Issue,
  event: TransitionEvent,
): Promise<void> {
  const dir = resolveIssueRepoDir(issue, configStore.config, homedir());
  const target = transitionTarget(event, repoSettingsFor(dir));
  if (!target || issue.status === target) return;

  if (transitionConfirmMode() !== "always") {
    await applyTransition(issue, event, target);
    return;
  }

  const modal = new ListModal({
    header: `${issue.identifier} → ${target}?`,
    subheader: `${TRANSITION_LABELS[event]} · currently ${issue.status}`,
    items: [{ id: "yes", label: `Move to ${target}` }, { id: "no", label: "Leave it" }],
  });
  modal.open();
  openModal(modal, async (value) => {
    if ((value as ListItem).id === "yes") await applyTransition(issue, event, target);
  });
}

/** Detect MR edges for every session and fire whatever transitions they imply. */
function checkMrTransitions(): void {
  for (const session of currentSessions) {
    const ctx = pollCoordinator.getContext(session.name);
    if (!ctx) continue;
    const next: MrSnapshot[] = ctx.mrs.map((m) => ({ id: m.id, status: m.status }));
    const prev = mrSnapshots.get(session.name);
    mrSnapshots.set(session.name, next);
    // No baseline yet: record and stay silent. The first poll of a session is
    // observation, never a trigger.
    if (!prev) continue;

    const { opened, merged } = detectMrTransitions(prev, next);
    if (!opened && !merged) continue;
    const issue = ctx.issues[0];
    if (!issue) continue;
    // Merged is the later edge, so it wins when both fire in one poll.
    void requestTransition(issue, merged ? "mr-merged" : "mr-open");
  }
  for (const name of mrSnapshots.keys()) {
    if (!currentSessions.some((s) => s.name === name)) mrSnapshots.delete(name);
  }
}

/** Toggle an explicit park decision for a session and re-derive the band. */
function toggleParked(name: string): void {
  const stage = stageOfSession(name);
  const current = clearStaleOverride(sessionState.getParkOverride(name), stage);
  const nowParked = sidebar.isParked(name);
  // Record the opposite of what is on screen, so the key always does the thing
  // its label promises regardless of whether the current state was derived.
  if (current?.manual === (nowParked ? "park" : "unpark")) {
    sessionState.setParkOverride(name, null);
  } else {
    sessionState.setParkOverride(name, { manual: nowParked ? "unpark" : "park", atStage: stage });
  }
  recomputeSessionBands();
  scheduleRender();
}

function setDiffFocus(focused: boolean): void {
  diffPanelFocused = focused;
  inputRouter.setPanelFocused(focused);
  // Dim/undim the tmux active pane to visually show focus has moved. The dim
  // color tracks the theme so it recedes correctly on light backgrounds too.
  if (focused) {
    control.sendCommand(`select-pane -P 'fg=${toHex(theme.paneInactiveFg)}'`).catch(() => {});
  } else {
    control.sendCommand("select-pane -P ''").catch(() => {});
  }
  scheduleRender();
}

// The tmux window-style / window-active-style options give inactive panes a
// faded default foreground and the active pane a strong one, as a focus cue.
// They're seeded (hardcoded, dark) in config/defaults.conf, but must be re-issued
// from the detected theme — the baked-in light-gray active fg washes out on a
// light background, making the focused pane *harder* to read. Applied once the
// control channel is up, and again whenever the terminal theme changes.
// (controlStarted is declared before the boot await — see the stdin gate setup.)
function applyPaneStyles(): void {
  if (!controlStarted) return;
  control.sendCommand(`set -g window-style 'fg=${toHex(theme.paneInactiveFg)}'`).catch(() => {});
  control.sendCommand(`set -g window-active-style 'fg=${toHex(theme.paneActiveFg)}'`).catch(() => {});
}

let currentSessionId: string | null = null;
let ptyClientName: string | null = null;
let sidebarShown = layout.sidebar !== null;
let currentSessions: SessionInfo[] = [];
let snapshotter: import("./snapshot").Snapshotter | null = null;
let lockRetrier: import("./snapshot").LockRetrier | null = null;
let controlChannelLost = false;

sidebar.setVersion(VERSION);
const lastViewedTimestamps = new Map<string, number>();
/**
 * Per-session git facts, with the two forms of a session's location kept
 * deliberately apart:
 *
 *   * `directory` — the **display** string, tilde-abbreviated (`~/Code/x`).
 *     The sidebar shows it and derives group labels from it, and its grouping
 *     treats a leading `~` specially, so it must stay abbreviated.
 *   * `path` — the **filesystem** path, absolute (`/Users/me/Code/x`).
 *     Anything that runs a command or resolves a repo needs this one.
 *
 * They were one field. Nothing expands `~` on the way to a subprocess, so
 * `git -C ~/Code/x` ran in a directory that does not exist: every session's
 * branch came back null and branch-derived issues silently vanished from the
 * sidebar. Two names is what keeps a display string out of a `cwd`.
 */
const sessionDetailsCache = new Map<string, {
  directory?: string;
  path?: string;
  gitBranch?: string;
  project?: string;
}>();

/**
 * Tell the poll coordinator where each session lives, so it can resolve the
 * session's issue and MR context.
 *
 * Called from both `fetchSessions` and `lookupSessionDetails` because a session
 * only becomes registerable once its path is cached, and the two run in the
 * wrong order to do it once: `fetchSessions` fires the (async) lookup *after*
 * this point, so on the first pass every path is still unknown. Registering
 * only there meant a session that existed at startup was never handed over at
 * all — no context, and so no issue on its sidebar row — until something
 * created or destroyed a session and forced a second pass.
 *
 * `addSession` is idempotent, so calling it from both places costs nothing.
 */
function registerSessionsWithPoller(sessions: SessionInfo[]): void {
  for (const session of sessions) {
    // The absolute path, never the display string: this becomes the `cwd` of
    // the git commands that discover the session's branch.
    const dir = sessionDetailsCache.get(session.id)?.path;
    if (dir) pollCoordinator.addSession(session.name, dir);
  }
}

let cacheTimerInterval: ReturnType<typeof setInterval> | null = null;
let themeRequeryInterval: ReturnType<typeof setInterval> | null = null;

function startCacheTimerTick(): void {
  if (cacheTimerInterval) return;
  cacheTimerInterval = setInterval(() => {
    if (cacheTimersEnabled && otelReceiver.getActiveSessionIds().length > 0) {
      scheduleRender();
    }
  }, 1000);
}

function stopCacheTimerTick(): void {
  if (cacheTimerInterval) {
    clearInterval(cacheTimerInterval);
    cacheTimerInterval = null;
  }
}

otelReceiver.onUpdate = (sessionName) => {
  // Map session name → session ID for the sidebar
  const session = currentSessions.find((s) => s.name === sessionName);
  if (!session) return;
  const state = otelReceiver.getSessionState(sessionName);
  sidebar.setSessionOtelState(session.id, state);
  startCacheTimerTick();
  scheduleRender();
};

/**
 * Ctrl-Shift-Up/Down through `[Overview, ...sidebar rows]`.
 *
 * Rows are sessions *and* ghosts: landing on a session switches to it, landing
 * on a ghost previews it. Ghosts were excluded while selecting one provisioned
 * a worktree; previewing is not destructive, so the exclusion went with it.
 *
 * The stepping arithmetic lives in nav-order.ts — the empty-list and
 * stale-focus cases are easy to get wrong and worth a unit test.
 */
function switchByOffset(offset: number): void {
  const targets = sidebar.getNavOrder();
  const focus: NavFocus = inGlass
    ? { type: "overview" }
    : ghostPreview.isOpen && ghostPreview.getIssueId()
      ? { type: "ghost", issueId: ghostPreview.getIssueId()! }
      : { type: "session", sessionId: currentSessionId ?? "" };

  const next = resolveNavStep(targets, focus, offset);

  if (next.type === "overview") {
    if (!inGlass) void enterGlass();
    return;
  }
  if (next.type === "session") {
    if (inGlass) void leaveGlass(next.sessionId);
    else void switchSession(next.sessionId);
    return;
  }
  const issue = pollCoordinator.getGlobalIssues().find((i) => i.id === next.issueId);
  if (issue) openGhostPreview({ id: issue.id, identifier: issue.identifier });
}

// --- Diff panel lifecycle ---

function calcSplitPanelCols(available: number): number {
  if (infoPanelWidth !== null) {
    return Math.max(20, Math.min(infoPanelWidth, available - 20));
  }
  return diffPanel.calcPanelCols(available, diffPanelSplitRatio);
}

function getDiffPanelCols(): number {
  return layout.panel?.w ?? 0;
}

async function getSessionCwd(): Promise<string | null> {
  try {
    const lines = await control.sendCommand(
      `display-message -t ${tq(currentSessionId!)} -p '#{pane_current_path}'`,
    );
    const cwd = (lines[0] || "").trim();
    return cwd || null;
  } catch {
    return null;
  }
}

function killDiffProcess(): void {
  if (diffPty) {
    try { diffPty.kill(); } catch {}
    diffPty = null;
  }
  diffBridge = null;
}

async function spawnHunk(cols: number, rows: number): Promise<void> {
  killDiffProcess();
  diffPanel.setHunkExited(false);

  const hunkPath = Bun.which(hunkCommand);
  if (!hunkPath) {
    diffPanel.setHunkExited(true);
    return;
  }

  const cwd = await getSessionCwd();
  if (!cwd) {
    diffPanel.setHunkExited(true);
    return;
  }

  const { Terminal } = await import("bun-pty");
  diffBridge = new ScreenBridge(cols, rows);
  const pty_ = new Terminal(hunkPath, ["diff"], {
    name: "xterm-256color",
    cols,
    rows,
    env: { ...process.env, TERM: "xterm-256color" },
    cwd,
  });
  diffPty = pty_;

  pty_.onData((data: string) => {
    if (diffPty !== pty_ || !diffBridge) return;
    diffBridge.write(data).then(() => scheduleRender());
  });

  pty_.onExit(() => {
    // Guard: if a newer hunk process replaced us, don't clobber its state
    if (diffPty !== pty_) return;
    diffPanel.setHunkExited(true);
    diffPty = null;
    scheduleRender();
  });
}

/**
 * Recomputes `layout` from current inputs (term size, sidebar width, toolbar
 * height, diff-panel state) and applies it: resizes the main pty/bridge, the
 * diff pty/bridge (if spawned), the sidebar, and pushes the new layout into
 * the input router in one shot via `setLayout`, then schedules a repaint.
 * This is the single place that turns "something affecting frame geometry
 * changed" into "everything downstream of that geometry agrees" — callers
 * mutate exactly the input that changed (`diffPanel.toggle()`/`toggleZoom()`,
 * `sidebarWidth`, or nothing for a pure terminal resize) and then call this.
 */
/**
 * The drag-handle chrome the renderer should composite this frame. Bundled
 * into one accessor so all three render paths (normal frame, settings screen,
 * Command Center) show the same affordance — the sidebar edge is draggable
 * wherever the sidebar is drawn, so its highlight must be too.
 */
function dragChrome(): { hoveredHandle: DragHandle | null } {
  return { hoveredHandle };
}

/**
 * The active panel view's row layout. Every consumer — the paint, the
 * wheel/click hit-testing, and the split drag — goes through here so they
 * can't disagree about where the list ends and the detail begins.
 */
function panelViewLayout(rows: number, viewState: ViewState) {
  return computeViewLayout(rows, viewState.filterQuery !== null, infoPanelSplitRatio);
}

/**
 * The active view state, but only when a panel view (not the diff tab) is
 * actually showing — the split handle exists only there.
 */
function activePanelViewState(): ViewState | null {
  if (!diffPanel.isActive() || infoPanel.activeTab === "diff") return null;
  const view = panelViews.find((v) => v.id === infoPanel.activeTab);
  if (!view) return null;
  return viewStates.get(view.id) ?? null;
}

/**
 * Applies the most recent tracked drag position as a real resize. Returns
 * whether anything changed — a drag that hasn't crossed a column boundary,
 * or one already clamped at its limit, resolves to the same width and must
 * not relayout, or a drag held against the edge would resize on every event.
 */
function applyPendingDragResize(): boolean {
  const pending = pendingDragResize;
  if (pending === null) return false;
  pendingDragResize = null;
  lastDragResizeAt = Date.now();

  if (pending.handle === "sidebar-edge") {
    const width = sidebarWidthForCol(layout, pending.col);
    if (width === sidebarWidth) return false;
    sidebarWidth = width;
    dragDidResize = true;
  } else {
    const width = panelWidthForCol(layout, pending.col, BORDER_WIDTH);
    if (width === infoPanelWidth) return false;
    infoPanelWidth = width;
    dragDidResize = true;
  }
  relayout();
  return true;
}

/**
 * Throttles live drag resizes: apply immediately when the last one is far
 * enough behind (so the first movement of a drag is instant), otherwise let
 * a trailing timer flush the newest position. Leading + trailing, so the
 * drag both feels responsive and never ends on a dropped final position.
 *
 * Deliberately not folded into scheduleRender()'s tick: renderFrame() bails
 * early while `writesPending > 0`, and a live resize makes tmux chatty, so
 * hanging the resize off the render tick would starve it exactly when the
 * user is dragging fastest.
 */
function scheduleDragResize(): void {
  const since = Date.now() - lastDragResizeAt;
  if (since >= DRAG_RESIZE_INTERVAL_MS) {
    applyPendingDragResize();
    return;
  }
  if (dragResizeTimer !== null) return;
  dragResizeTimer = setTimeout(() => {
    dragResizeTimer = null;
    applyPendingDragResize();
  }, DRAG_RESIZE_INTERVAL_MS - since);
}

/** Drops any queued live resize — the drag that owned it is over. */
function clearPendingDragResize(): void {
  pendingDragResize = null;
  if (dragResizeTimer !== null) {
    clearTimeout(dragResizeTimer);
    dragResizeTimer = null;
  }
}

/**
 * Writes the size a finished drag left behind. Reads the module state rather
 * than a position, so it works for a cancel — where there is no final
 * position, only whatever the live resize last applied — as well as a commit.
 */
function persistDragWidth(handle: DragHandle): void {
  if (handle === "sidebar-edge") {
    configStore.set("sidebarWidth", sidebarWidth);
  } else if (handle === "panel-divider" && infoPanelWidth !== null) {
    configStore.set("infoPanelWidth", infoPanelWidth);
  } else if (handle === "panel-split") {
    configStore.set("infoPanelSplitRatio", infoPanelSplitRatio);
  }
}

/**
 * Moves the info panel's list/detail split so its separator lands on the
 * absolute grid row `pos`. Stored as a ratio rather than a row count so the
 * proportions survive a terminal or panel resize.
 */
function applyPanelSplit(pos: number): void {
  const viewState = activePanelViewState();
  if (!viewState) return;
  const ratio = splitRatioForSepRow(
    layout.ptyRows,
    viewState.filterQuery !== null,
    pos - layout.contentTop,
  );
  if (ratio === infoPanelSplitRatio) return;
  infoPanelSplitRatio = ratio;
  dragDidResize = true;
  scheduleRender();
}

function relayout(): void {
  const termCols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;

  // Probe computeFrameLayout in off mode to derive the available width that
  // the panel-width calculation depends on.
  const base = {
    termCols,
    termRows,
    sidebarWidth,
    borderWidth: BORDER_WIDTH,
    toolbarRows: toolbarHeight,
    // The top rule (+ junctions + tab underline) is on — compositeGrids
    // paints it (renderer.ts). The footer is disabled (see footer-removal
    // notes) — content reclaims the bottom row for tmux.
    frameRulesEnabled: true,
    footerEnabled: false,
  };
  const probe = computeFrameLayout({ ...base, diffState: "off", requestedPanelCols: 0 });
  const available = probe.main.w;

  let requestedPanelCols = 0;
  if (diffPanel.state === "split") {
    requestedPanelCols = calcSplitPanelCols(available);
  } else if (diffPanel.state === "full") {
    requestedPanelCols = available;
  }

  layout = computeFrameLayout({
    ...base,
    diffState: diffPanel.state,
    requestedPanelCols,
  });

  // Recomputed alongside `layout` on every geometry change so the settings
  // screen / Command Center's frameless render always has an up-to-date
  // fullScreenLayout for the current terminal size, even though neither of
  // those modes affects diffState/requestedPanelCols (both are always "off"/0
  // here — they're full-screen takeovers with no diff panel of their own).
  fullScreenLayout = computeFrameLayout({
    termCols,
    termRows,
    sidebarWidth,
    borderWidth: BORDER_WIDTH,
    toolbarRows: 0,
    diffState: "off",
    requestedPanelCols: 0,
    frameRulesEnabled: false,
    footerEnabled: false,
  });

  mainCols = layout.main.w;
  sidebarShown = layout.sidebar !== null;

  pty.resize(layout.main.w, layout.ptyRows);
  bridge.resize(layout.main.w, layout.ptyRows);

  if (diffPty && diffBridge && layout.panel) {
    diffPty.resize(layout.panel.w, layout.ptyRows);
    diffBridge.resize(layout.panel.w, layout.ptyRows);
  }

  applyChromeLayout();

  scheduleRender();
}

/**
 * The layout that should currently govern the sidebar's height and the
 * input router's row classification: the frameless full-screen layout while
 * the settings screen or Command Center (glass) is the active view — both
 * render via `fullScreenLayout` in renderFrame() — the shared toolbar-ful
 * `layout` otherwise. Column geometry is identical between the two; only
 * which row bands (toolbar/rules/footer) exist differs.
 */
function activeChromeLayout(): FrameLayout {
  return settingsScreen.isOpen || workflowScreen.isOpen || ghostPreview.isOpen || inGlass
    ? fullScreenLayout
    : layout;
}

/**
 * Applies activeChromeLayout() to the sidebar (its rendered height must
 * match whichever layout is compositing it, or blit clips its bottom rows —
 * see frame-layout.ts's sidebarBottomRow) and the input router (so mouse row
 * classification — toolbar/rule/footer/content — matches what's actually
 * painted, rather than swallowing clicks on newly-frameless content as if
 * they'd landed on chrome rows that no longer exist there).
 *
 * Called from relayout() (geometry changed) and from every settings/glass
 * entry/exit point (mode changed without a geometry change) — those
 * transitions don't go through relayout(), so without this the sidebar/input
 * router would keep the previous mode's layout until the next resize.
 */
function applyChromeLayout(): void {
  const active = activeChromeLayout();
  // NOTE: this must NOT cancel an in-flight drag. A live drag calls
  // relayout() on every tracked movement, which lands here — cancelling
  // would abort the drag on its own first motion. SIGWINCH cancels instead
  // (see the resize handler); mode changes can't strand a drag because
  // reaching them requires a keystroke, which already aborts.
  inputRouter.setLayout(active);
  sidebar.resize(sidebarWidth, sidebarBottomRow(active));
}

async function toggleDiffPanel(): Promise<void> {
  const wasActive = diffPanel.isActive();
  diffPanel.toggle();

  if (!wasActive && diffPanel.state === "split") {
    // off → split: shrink tmux, focus the panel, then spawn hunk at the
    // now-current panel size.
    relayout();
    setDiffFocus(true);
    await spawnHunk(getDiffPanelCols(), layout.ptyRows);
  } else if (wasActive && diffPanel.state === "off") {
    // split/full → off: kill hunk, resize tmux back.
    killDiffProcess();
    relayout();
    setDiffFocus(false);
  }
}

async function zoomDiffPanel(): Promise<void> {
  if (!diffPanel.isActive()) return;
  diffPanel.toggleZoom();
  relayout();

  if (diffPanel.state === "full") {
    // split → full: zooming always grabs focus. relayout() only pushes
    // geometry (inputRouter.setLayout) and never touches panel focus, so
    // that state has to be set explicitly here via setDiffFocus.
    setDiffFocus(true);
  }
}

// --- Session data helpers ---

async function fetchSessions(): Promise<void> {
  try {
    const lines = await control.sendCommand(
      `list-sessions -f "${INTERNAL_SESSION_FILTER}" -F '#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}'`,
    );
    const sessions: SessionInfo[] = lines
      .filter((l) => l.length > 0)
      .map((line) => {
        const [id, name, activity, attached, windows] = line.split(":");
        const cached = sessionDetailsCache.get(id);
        return {
          id,
          name,
          activity: parseInt(activity, 10) || 0,
          attached: attached === "1",
          windowCount: parseInt(windows, 10) || 1,
          directory: cached?.directory,
          gitBranch: cached?.gitBranch,
          project: cached?.project,
        };
      });
    currentSessions = sessions;

    // Mark sessions with activity since last viewed
    for (const session of sessions) {
      const lastViewed = lastViewedTimestamps.get(session.id) ?? 0;
      if (session.activity > lastViewed && session.id !== currentSessionId) {
        sidebar.setActivity(session.id, true);
      }
    }

    sidebar.updateSessions(sessions);

    // Update poll coordinator session list
    const knownSessions = new Set<string>();
    for (const session of sessions) {
      knownSessions.add(session.name);
    }
    registerSessionsWithPoller(sessions);
    for (const [name] of pollCoordinator.getAllContexts()) {
      if (!knownSessions.has(name)) pollCoordinator.removeSession(name);
    }
    sidebar.setSessionContexts(pollCoordinator.getAllContexts());
    recomputeSessionBands();

    // Prune state for dead sessions
    const liveNames = sessions.map((s) => s.name);
    const liveSessionNames = new Set(liveNames);
    sessionState.pruneSessions(liveSessionNames);
    otelReceiver.pruneExcept(liveNames);
    if (otelReceiver.getActiveSessionIds().length === 0) {
      stopCacheTimerTick();
    }

    renderFrame();

    // Fire-and-forget git branch lookup (async, updates sidebar when done)
    lookupSessionDetails(sessions);
  } catch {
    // tmux server may be shutting down
  }
}

/**
 * Put the sidebar rail on the attached session — unless another surface owns
 * the main area.
 *
 * The rail marks the row whose content is on screen, not merely which session
 * tmux has us attached to. Those are the same thing most of the time, but the
 * ghost preview and the Command Center both show something else, and an
 * authoritative `%client-session-changed` from another tmux client would
 * otherwise yank the rail onto a session the user cannot currently see.
 * `currentSessionId` still tracks tmux either way; only the rail is withheld.
 *
 * Every write to the rail on the session-change path goes through here — there
 * are two (resolveClientName and the client-session-changed handler), and
 * guarding one but not the other is indistinguishable from guarding neither.
 */
function applySessionRail(): void {
  if (ghostPreview.isOpen || inGlass) return;
  sidebar.setActiveSession(currentSessionId ?? "");
}

async function resolveClientName(): Promise<void> {
  try {
    const lines = await control.sendCommand(
      "list-clients -F '#{client_name}:#{client_pid}:#{session_id}:#{session_name}'",
    );
    const pid = pty.pid.toString();
    for (const line of lines) {
      const [name, clientPid, ...rest] = line.split(":");
      if (clientPid === pid) {
        ptyClientName = name;
        // rest[0] = session_id, rest.slice(1).join(":") = session_name (may contain colons)
        const sessionId = rest[0];
        if (sessionId) {
          currentSessionId = sessionId;
          applySessionRail();
        }
        return;
      }
    }
  } catch {
    // Retry on next session switch
  }
}

async function syncControlClient(): Promise<void> {
  if (currentSessionId) {
    try {
      await control.sendCommand(`switch-client -t ${tq(currentSessionId)}`);
    } catch { /* non-critical */ }
  }
}

async function switchSession(sessionId: string): Promise<void> {
  // Choosing a session is choosing to stop previewing. Central so sidebar
  // clicks, keyboard navigation and the palette all get it for free. Guarded
  // against the unpark in closeGhostPreview, which calls back into here.
  if (ghostPreview.isOpen) {
    ghostPreview.close();
    sidebar.setFocusedGhost(null);
    previewUnparkTarget = null;
    inputRouter.setModalOpen(inputConsumerActive());
    applyChromeLayout();
  }

  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;

  try {
    await control.sendCommand(
      `switch-client -c ${ptyClientName} -t ${tq(sessionId)}`,
    );
    currentSessionId = sessionId;
    sidebar.setOverviewActive(false);
    sidebar.setActiveSession(sessionId);
    sidebar.scrollToActive();
    const sessionName = currentSessions.find((s) => s.id === sessionId)?.name;
    if (sessionName) {
      snapshotter?.onFocused(sessionName);
      await pollCoordinator.setActiveSession(sessionName);
      focusPanelOnSessionIssue(sessionName);
    }
    fetchWindows();
    renderFrame();
  } catch {
    // Session may have been killed
  }
}

// --- Rendering ---

let renderTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Build the active modal's overlay grid + absolute cursor position, or null when
 * no modal is open. Shared by every render branch so modals composite the same
 * way over the main view, the settings screen, and the Command Center.
 */
function computeModalOverlay(activeLayout: FrameLayout): {
  grid: import("./types").CellGrid;
  cursor: { row: number; col: number } | null;
} | null {
  if (!activeModal?.isOpen()) return null;
  const modalWidth = activeModal.preferredWidth(activeLayout.termCols);
  const grid = activeModal.getGrid(modalWidth);
  const pos = getModalPosition(activeLayout, modalWidth, grid.rows);
  const cursorPos = activeModal.getCursorPosition();
  const cursor = cursorPos
    ? { row: pos.startRow + cursorPos.row, col: pos.startCol + cursorPos.col }
    : null;
  return { grid, cursor };
}

function renderFrame(): void {
  if (writesPending > 0) return;

  // The footer is disabled (footerEnabled: false — see footer-removal notes),
  // so layout.footerRow is always null and the renderer never paints it.
  // Skip building it each frame; footer.ts stays intact for a trivial re-enable.
  const footerCells = layout.footerRow !== null ? layoutFooter(makeFooter(), layout.termCols).cells : undefined;

  // Settings screen replaces main content. It's a frameless full-screen
  // takeover — no window tabs, so no toolbar — rendered through
  // fullScreenLayout (toolbarRows: 0) rather than the shared toolbar-ful
  // `layout`: no blank toolbar-row strip above it, no footer band clipping
  // its bottom, and the sidebar beside it (resized to fullScreenLayout's
  // full-terminal height by applyChromeLayout()) fills its full height too.
  if (settingsScreen.isOpen) {
    const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
    const totalCols = fullScreenLayout.termCols;
    const contentCols = sidebarShown ? totalCols - fullScreenLayout.main.x : totalCols;
    const settingsGrid = settingsScreen.render(contentCols, fullScreenLayout.contentRows);
    renderer.render(
      fullScreenLayout,
      settingsGrid,
      { x: 0, y: 0 },
      sidebarGrid,
      null, // no toolbar
      null, // no modal
      null, // no modal cursor
      undefined, // no diff panel
      undefined, // no footer — frameless full-screen view
      dragChrome(),
    );
    return;
  }

  // The workflow screen is the same class of surface as settings: a frameless
  // full-screen takeover through fullScreenLayout, with no toolbar, no footer,
  // and no modal overlay — it paints its own pickers and prompts.
  if (workflowScreen.isOpen) {
    const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
    const totalCols = fullScreenLayout.termCols;
    const contentCols = sidebarShown ? totalCols - fullScreenLayout.main.x : totalCols;
    renderer.render(
      fullScreenLayout,
      workflowScreen.render(contentCols, fullScreenLayout.contentRows),
      { x: 0, y: 0 },
      sidebarGrid,
      null, null, null, undefined, undefined,
      dragChrome(),
    );
    return;
  }

  // Ghost preview: the same frameless full-screen takeover as settings and
  // workflow — but the modal overlay is composited, because unlike those two
  // this surface opens a real ListModal (the status picker) over itself.
  // Passing null here would open that picker invisibly.
  if (ghostPreview.isOpen) {
    const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
    const totalCols = fullScreenLayout.termCols;
    const contentCols = sidebarShown ? totalCols - fullScreenLayout.main.x : totalCols;
    const overlay = computeModalOverlay(fullScreenLayout);
    renderer.render(
      fullScreenLayout,
      ghostPreview.render(contentCols, fullScreenLayout.contentRows),
      { x: 0, y: 0 },
      sidebarGrid,
      null,
      overlay?.grid ?? null,
      overlay?.cursor ?? null,
      undefined, undefined,
      dragChrome(),
    );
    return;
  }

  // Pane-of-glass (Overview) replaces main content; toolbar hidden. Modals
  // (e.g. the command palette) still composite on top — otherwise they open
  // invisibly while the Command Center is up. Frameless full-screen takeover
  // like settings above — rendered through fullScreenLayout, no footer.
  if (inGlass && glassView) {
    const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
    const overlay = computeModalOverlay(fullScreenLayout);
    const stripVisible = stripVisibleFor(commandCenterTabs);
    const totalCols = fullScreenLayout.termCols;
    const contentCols = sidebarShown ? totalCols - fullScreenLayout.main.x : totalCols;

    let content = glassView.getGrid();
    let cursor = glassView.getFocusedCursor() ?? { x: 0, y: 0 };

    if (stripVisible) {
      const palette = resolveStateColors(configStore.config.stateColors);
      const stripInput = { tabs: commandCenterTabs, activeTabId, summaryByTab, width: contentCols, palette };
      currentStripChips = layoutStrip(stripInput);
      const strip = renderStrip(stripInput, currentStripChips);
      const combined = createGrid(contentCols, fullScreenLayout.contentRows);
      // Blit strip on top rows, glass content below.
      for (let r = 0; r < STRIP_ROWS && r < combined.rows; r++)
        for (let c = 0; c < contentCols; c++) combined.cells[r][c] = strip.cells[r][c];
      for (let r = 0; r < content.rows && r + STRIP_ROWS < combined.rows; r++)
        for (let c = 0; c < content.cols && c < contentCols; c++) combined.cells[r + STRIP_ROWS][c] = content.cells[r][c];
      content = combined;
      cursor = { x: cursor.x, y: cursor.y + STRIP_ROWS };
    } else {
      currentStripChips = [];
    }

    renderer.render(fullScreenLayout, content, cursor, sidebarGrid, null, overlay?.grid ?? null, overlay?.cursor ?? null, undefined, undefined, dragChrome());
    return;
  }

  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  const tb = toolbarEnabled ? makeToolbar() : null;
  const overlay = computeModalOverlay(layout);
  const modalGrid = overlay?.grid ?? null;
  const modalCursorPos = overlay?.cursor ?? null;
  let diffPanelArg: { grid: import("./types").CellGrid; mode: "split" | "full"; focused: boolean; tabBar?: import("./types").CellGrid } | undefined;
  if (diffPanel.isActive()) {
    const dpCols = getDiffPanelCols();
    const dpRows = layout.ptyRows;

    let contentGrid: import("./types").CellGrid;
    if (infoPanel.activeTab === "diff") {
      if (diffPanel.hunkExited || !diffBridge) {
        contentGrid = !Bun.which(hunkCommand)
          ? diffPanel.getNotFoundGrid(dpCols, dpRows)
          : diffPanel.getEmptyGrid(dpCols, dpRows);
      } else {
        contentGrid = diffBridge.getGrid();
      }
    } else {
      // View tab — use global panel view renderer
      const activeViewId = infoPanel.activeTab;
      const view = panelViews.find((v) => v.id === activeViewId);
      if (view) {
        const viewState = viewStates.get(view.id) ?? createViewState();

        const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
        const ctx = pollCoordinator.getContext(sessionName);
        const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
        const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);

        let rawItems: import("./panel-view-renderer").RenderableItem[];
        if (view.source === "issues") {
          rawItems = transformIssues(issuesForView(view), linkedIssueIds, getIssueSessionStates(), mrsByUrl());
        } else if (view.filter.scope === "reviewing") {
          rawItems = transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds);
        } else {
          rawItems = transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
        }

        // Apply fuzzy filter when active
        if (viewState.filterQuery) {
          rawItems = filterItems(rawItems, viewState.filterQuery);
        }

        // When filtering, flatten groups so fuzzy-score order is preserved
        const effectiveView = viewState.filterQuery
          ? { ...view, groupBy: "none" as const }
          : view;
        const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
        contentGrid = renderView(nodes, dpCols, dpRows, viewState, {
          splitRatio: infoPanelSplitRatio,
          splitHovered: hoveredHandle === "panel-split",
        });
      } else {
        contentGrid = createGrid(dpCols, dpRows);
      }
    }

    const tabBar = infoPanel.hasMultipleTabs ? infoPanel.getTabBarGrid(dpCols, hoveredPanelTabId) : undefined;
    diffPanelArg = {
      grid: contentGrid,
      mode: diffPanel.state as "split" | "full",
      focused: diffPanelFocused,
      tabBar,
    };
  }
  renderer.render(
    layout,
    grid, cursor,
    sidebarShown ? sidebar.getGrid() : null,
    tb,
    modalGrid,
    modalCursorPos,
    diffPanelArg,
    footerCells,
    dragChrome(),
  );
}

const RENDER_INTERVAL_ACTIVE = 33;  // ~30fps when focused
const RENDER_INTERVAL_IDLE = 200;   // ~5fps when no recent input

let lastInputTime = Date.now();

function markInputActivity(): void {
  lastInputTime = Date.now();
}

function scheduleRender(): void {
  if (renderTimer !== null) return;
  const elapsed = Date.now() - lastInputTime;
  const interval = elapsed < 2000 ? RENDER_INTERVAL_ACTIVE : RENDER_INTERVAL_IDLE;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderFrame();
  }, interval);
}

// --- Indicator clearing on interaction ---

function clearSessionIndicators(): void {
  if (!currentSessionId) return;
  const id = currentSessionId;
  if (!sidebar.hasActivity(id)) return;
  lastViewedTimestamps.set(id, Math.floor(Date.now() / 1000));
  sidebar.setActivity(id, false);
  scheduleRender();
}

function resolvePreselectedTeamId(): string | null {
  const workflow = configStore.config.issueWorkflow;
  if (!workflow?.teamRepoMap) return null;
  // Absolute, so it is comparable to the expanded teamRepoMap paths below.
  const sessionDir = sessionDetailsCache.get(currentSessionId ?? "")?.path ?? null;
  if (!sessionDir) return null;

  for (const [teamName, repoDir] of Object.entries(workflow.teamRepoMap)) {
    const expandedDir = repoDir.replace("~", homedir());
    if (sessionDir === expandedDir || sessionDir.startsWith(expandedDir + "/")) {
      const team = cachedTeams.find((t) => t.name === teamName);
      if (team) return team.id;
    }
  }
  return null;
}

/** Explain, rather than no-op, when capture can't run. A key that silently
 *  does nothing is indistinguishable from a broken one. */
function explainCaptureUnavailable(reason: string, hint: string): void {
  const onSurface = { bg: theme.surface, bgMode: 2 as const };
  const lines: StyledLine[] = [
    [],
    [{ text: reason, attrs: { fg: 3, fgMode: 1, ...onSurface } }],
    [],
    [{ text: hint, attrs: { ...neutralFg(8), dim: true, ...onSurface } }],
    [],
    [{ text: "Press q or Esc to close.", attrs: { ...neutralFg(8), dim: true, ...onSurface } }],
  ];
  const modal = new ContentModal({ lines, title: "Can't capture an issue" });
  modal.setTermRows(process.stdout.rows || 24);
  modal.open();
  openModal(modal, () => {});
  scheduleRender();
}

/**
 * A checklist built out of ListModal: each Enter toggles an option and reopens
 * the list, Esc closes. Cheaper than a bespoke multi-select modal and it keeps
 * the panel's editing surface consistent with every other picker.
 */
function openToggleList(opts: {
  header: string;
  options: Array<{ id: string; label: string; annotation?: string }>;
  selected: () => string[];
  toggle: (id: string) => void;
}): void {
  const render = (): void => {
    if (opts.options.length === 0) return;
    const chosen = new Set(opts.selected().map((s) => s.toLowerCase()));
    const items = opts.options.map((o) => ({
      id: o.id,
      label: `${chosen.has(o.id.toLowerCase()) ? "[x]" : "[ ]"} ${o.label}`,
      // Showing an already-assigned status's current home makes it obvious that
      // ticking it *moves* it rather than duplicating it.
      annotation: o.annotation,
    }));
    const modal = new ListModal({
      header: opts.header,
      subheader: "Enter toggles · Esc when done",
      items,
    });
    modal.open();
    openModal(modal, (value) => {
      const picked = value as ListItem | undefined;
      if (!picked) return;
      opts.toggle(picked.id);
      render();
    });
  };
  render();
}

/** Mutate one filter axis of a view and persist it. */
function updateViewFilter(view: PanelView, patch: Partial<PanelView["filter"]>): void {
  view.filter = applyFilterPatch(view.filter, patch);
  debouncedViewSave(view);
  scheduleRender();
}

function toggleInFilterList(
  view: PanelView,
  key: "states" | "stages" | "labels",
  id: string,
): void {
  view.filter = toggleFilterValue(view.filter, key, id);
  debouncedViewSave(view);
  scheduleRender();
}

const PRIORITY_CHOICES: Array<{ id: string; label: string }> = [
  { id: "none", label: "Any priority" },
  { id: "1", label: "Urgent only (P1)" },
  { id: "2", label: "Urgent + High (P1–P2)" },
  { id: "3", label: "P1–P3" },
  { id: "4", label: "P1–P4 (excludes no-priority)" },
];

/** The filter menu for one issues view: one entry per membership axis. */
function openViewFilterMenu(view: PanelView): void {
  const f = view.filter;
  const count = (k: "states" | "stages" | "labels") => (f[k] ?? []).length;
  const labelsAvailable = new Set<string>();
  for (const issue of pollCoordinator.getGlobalIssues()) {
    for (const l of issue.labels ?? []) labelsAvailable.add(l.name);
  }

  // A stage's statuses govern its membership, and `effectiveFilter` drops
  // `filter.states` for it — so offering a States axis here would be a control
  // that silently does nothing. The workflow screen is where its statuses live.
  const sectioned = view.states !== undefined;

  const items: ListItem[] = [
    ...(sectioned
      ? [{ id: "workflow", label: "Statuses…", annotation: "in the workflow screen" }]
      : [{ id: "states", label: `States… (${count("states") || "any"})` }]),
    { id: "stages", label: `Stages… (${count("stages") || "any"})` },
    { id: "labels", label: `Labels… (${count("labels") || "any"})` },
    {
      id: "priority",
      label: `Priority: ${f.priorityAtMost ? `P1–P${f.priorityAtMost}` : "any"}`,
    },
    { id: "clear", label: "Clear all filters" },
    { id: "workflow-screen", label: "Configure workflow…" },
  ];

  const modal = new ListModal({ header: `Filter — ${view.label}`, items });
  modal.open();
  openModal(modal, (value) => {
    const picked = (value as ListItem | undefined)?.id;
    if (!picked) return;
    if (picked === "workflow" || picked === "workflow-screen") { openWorkflowScreen(); return; }
    if (picked === "clear") {
      view.filter = { scope: view.filter.scope };
      debouncedViewSave(view);
      scheduleRender();
      return;
    }
    if (picked === "priority") {
      const pick = new ListModal({ header: "Minimum priority", items: PRIORITY_CHOICES });
      pick.open();
      openModal(pick, (v) => {
        const id = (v as ListItem | undefined)?.id;
        if (!id) return;
        updateViewFilter(view, { priorityAtMost: id === "none" ? undefined : Number(id) });
      });
      return;
    }
    if (picked === "states") {
      openToggleList({
        header: "States in this queue",
        options: workflowStateOptions(),
        selected: () => view.filter.states ?? [],
        toggle: (id) => toggleInFilterList(view, "states", id),
      });
      return;
    }
    if (picked === "stages") {
      openToggleList({
        header: "Stages in this queue",
        options: STAGE_ORDER.map((s) => ({ id: s, label: STAGE_LABELS[s] })),
        selected: () => view.filter.stages ?? [],
        toggle: (id) => toggleInFilterList(view, "stages", id),
      });
      return;
    }
    openToggleList({
      header: "Labels in this queue",
      options: [...labelsAvailable].sort().map((l) => ({ id: l, label: l })),
      selected: () => view.filter.labels ?? [],
      toggle: (id) => toggleInFilterList(view, "labels", id),
    });
  });
}

// --- Panel views ---
//
// Tabs and their sections are edited on the workflow screen (workflow-screen.ts),
// which owns its own pickers and prompts. Everything that mutates the tab list
// lands back here to be persisted.

/** Swap in an edited view list, keeping derived state consistent, and persist. */
function persistViews(next: PanelView[]): void {
  panelViews = next;
  const ids = new Set(panelViews.map((v) => v.id));
  for (const v of panelViews) if (!viewStates.has(v.id)) viewStates.set(v.id, createViewState());
  // A deleted tab must not linger in the up-next rotation, or `Ctrl-a u` would
  // silently skip a queue that no longer exists.
  const upNext = configStore.config.pipeline?.upNext ?? [];
  const pruned = upNext.filter((id) => ids.has(id));
  configStore.set("panelViews", panelViews);
  if (pruned.length !== upNext.length) configStore.setPipeline("upNext", pruned);
  refreshPanelViews();
  // A tab edit moves statuses between stages, which is exactly what the stage
  // band groups on — and though which statuses *park* is independent of tab
  // membership, an edit can still change what a session's issue resolves to.
  // Cheap and idempotent, so it runs on any edit — and the workflow screen,
  // which reports "parks its sessions (n now)" while you edit, would otherwise
  // be quoting a stale n.
  recomputeSessionBands();
  scheduleRender();
}

function openCreateIssueModal(): void {
  if (!adapters.issueTracker || adapters.issueTracker.authState !== "ok") {
    explainCaptureUnavailable(
      "No issue tracker is connected.",
      adapters.issueTracker
        ? `Authentication failed — check ${adapters.issueTracker.authHint}.`
        : "Set adapters.issueTracker in ~/.config/jmux/config.json.",
    );
    return;
  }
  if (cachedTeams.length === 0) {
    // Teams arrive from an async poll, so this is usually just "too early".
    refreshTeams();
    explainCaptureUnavailable(
      "No teams loaded from the issue tracker yet.",
      "jmux is fetching them now — try again in a moment.",
    );
    return;
  }

  const preselectedTeamId = resolvePreselectedTeamId();
  const modal = new CaptureModal({ teams: cachedTeams, preselectedTeamId });
  modal.open();
  openModal(modal, async (value) => {
    const result = value as CaptureResult;
    try {
      const issue = await adapters.issueTracker!.createIssue(result.teamId, result.title, result.description);
      pollCoordinator.addGlobalIssue(issue);
      // "Capture & start" is the same capture plus the panel's own `n` flow, so
      // an idea reaches a running agent without a second trip through the UI.
      if (result.mode === "start") {
        showToast(`${issue.identifier} created`);
        const state = getIssueSessionStates().get(issue.id);
        await startWorkOnIssue(issue, state?.state ?? "none", state?.sessionName);
        return;
      }
      // Capture-and-stay: confirm it landed, and highlight it if the list
      // happens to be on screen — but don't move the user.
      showToast(`${issue.identifier} captured`);
      selectIssueInOpenPanel(issue.id);
      scheduleRender();
    } catch (e) {
      logError("jmux", `failed to create issue: ${(e as Error).message}`);
      showToast("Issue creation failed — see jmux.log");
    }
  });
}

// --- Input Router ---

// Open a URL with the OS default handler. jmux opens links itself (see the
// InputRouter link-click path) so clicking works identically across terminals
// instead of depending on each terminal's mouse-capture bypass.
function openUrl(url: string): void {
  const opener =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" });
}

const inputRouter = new InputRouter(
  {
    getLinkAt: (x, y) => renderer.getLinkAt(x, y),
    onOpenLink: openUrl,
    onPtyData: (data) => {
      if (inGlass) {
        glassView?.writeFocused(data);
        return;
      }
      pty.write(data);
      clearSessionIndicators();
    },
    onSidebarClick: (row, col) => {
      if (sidebar.headerGroupToggleHit(row, col)) {
        applySidebarGroup(sidebar.cycleGroupMode());
        scheduleRender();
        return;
      }
      if (sidebar.headerSortToggleHit(row, col)) {
        applySidebarSort(sidebar.cycleSortMode());
        scheduleRender();
        return;
      }
      if (sidebar.isVersionRow(row)) {
        void showVersionInfo();
        return;
      }
      const groupKey = sidebar.getGroupKeyByRow(row);
      if (groupKey) {
        sidebar.toggleGroup(groupKey);
        scheduleRender();
        return;
      }
      const sel = sidebar.getSelectionByRow(row);
      if (sel?.type === "overview" || sel?.type === "pinnedPane") {
        void enterGlass();
        return;
      }
      if (sel?.type === "ghost") {
        const issue = pollCoordinator.getGlobalIssues().find((i) => i.id === sel.issueId);
        if (issue) openGhostPreview({ id: issue.id, identifier: issue.identifier });
        return;
      }
      const session = sidebar.getSessionByRow(row);
      if (session) {
        if (inGlass) void leaveGlass(session.id);
        else switchSession(session.id);
      }
    },
    onSidebarScroll: (delta) => {
      sidebar.scrollBy(delta);
      scheduleRender();
    },
    onToolbarClick: (col) => {
      if (!toolbarEnabled) return;
      const tb = makeToolbar();
      // Check tabs first (left side)
      const tabRanges = getToolbarTabRanges(tb);
      for (const { id, startCol, endCol } of tabRanges) {
        if (col >= startCol && col <= endCol) {
          handleTabClick(id);
          return;
        }
      }
      // Then buttons (right side)
      const ranges = getToolbarButtonRanges(tb);
      for (const { id, startCol, endCol } of ranges) {
        if (col >= startCol && col <= endCol) {
          handleToolbarAction(id);
          return;
        }
      }
    },
    onFooterClick: (col) => {
      const { ranges } = layoutFooter(makeFooter(), layout.termCols);
      for (const { startCol, endCol, onClick } of ranges) {
        if (col >= startCol && col <= endCol && onClick === "changelog") {
          void showVersionInfo();
          return;
        }
      }
    },
    onHover: (target) => {
      let changed = false;
      if (target?.area === "toolbar") {
        const tb = makeToolbar();
        // Check tab hover (left side)
        const tabRanges = getToolbarTabRanges(tb);
        let foundTab: string | null = null;
        for (const { id, startCol, endCol } of tabRanges) {
          if (target.col >= startCol && target.col <= endCol) {
            foundTab = id;
            break;
          }
        }
        if (foundTab !== hoveredTabId) {
          hoveredTabId = foundTab;
          changed = true;
        }
        // Check button hover (right side)
        const ranges = getToolbarButtonRanges(tb);
        let found: string | null = null;
        for (const { id, startCol, endCol } of ranges) {
          if (target.col >= startCol && target.col <= endCol) {
            found = id;
            break;
          }
        }
        if (found !== hoveredToolbarButton) {
          hoveredToolbarButton = found;
          changed = true;
        }
        if (sidebar.getHoveredRow() !== null) {
          sidebar.setHoveredRow(null);
          changed = true;
        }
      } else if (target?.area === "sidebar") {
        if (hoveredToolbarButton !== null) { hoveredToolbarButton = null; changed = true; }
        if (hoveredTabId !== null) { hoveredTabId = null; changed = true; }
        const prev = sidebar.getHoveredRow();
        if (prev !== target.row) {
          sidebar.setHoveredRow(target.row);
          changed = true;
        }
      } else if (target?.area === "handle") {
        if (hoveredToolbarButton !== null) { hoveredToolbarButton = null; changed = true; }
        if (hoveredTabId !== null) { hoveredTabId = null; changed = true; }
        if (sidebar.getHoveredRow() !== null) { sidebar.setHoveredRow(null); changed = true; }
      } else {
        if (hoveredToolbarButton !== null) { hoveredToolbarButton = null; changed = true; }
        if (hoveredTabId !== null) { hoveredTabId = null; changed = true; }
        if (sidebar.getHoveredRow() !== null) { sidebar.setHoveredRow(null); changed = true; }
      }
      // Handle hover is set/cleared on every hover dispatch, not just when a
      // handle is under the pointer — otherwise the accent would stick after
      // the pointer moved off.
      const nextHandle = target?.area === "handle" ? target.handle : null;
      if (nextHandle !== hoveredHandle) { hoveredHandle = nextHandle; changed = true; }
      if (changed) scheduleRender();
    },
    onModalToggle: () => togglePalette(),
    onNewSession: () => handlePaletteAction({ commandId: "new-session" }),
    onSettings: () => handleToolbarAction("settings"),
    onCaptureIssue: () => openCreateIssueModal(),
    onStartUpNext: () => { void startUpNext(); },
    onUndoTransition: () => { void undoLastTransition(); },
    onSettingsScreen: () => toggleSettingsScreen(),
    onWorkflowScreen: () => toggleWorkflowScreen(),
    onGroupCycle: () => { applySidebarGroup(sidebar.cycleGroupMode()); scheduleRender(); },
    onSortCycle: () => { applySidebarSort(sidebar.cycleSortMode()); scheduleRender(); },
    onFilterCycle: () => { sidebar.cycleFilterMode(); scheduleRender(); },
    onModalInput: (data) => {
      // Full-screen surfaces consume input while open, ahead of any modal.
      if (workflowScreen.isOpen) {
        handleWorkflowInput(data);
        return;
      }
      if (settingsScreen.isOpen) {
        handleSettingsInput(data);
        return;
      }
      // Guarded on no modal being open: the preview hosts the status picker,
      // and swallowing input here would leave that picker unable to receive
      // the keys it exists to collect.
      if (ghostPreview.isOpen && !activeModal?.isOpen()) {
        handleGhostPreviewInput(data);
        return;
      }
      if (!activeModal?.isOpen()) return;
      const action = activeModal.handleInput(data);
      switch (action.type) {
        case "consumed":
          scheduleRender();
          break;
        case "closed":
          closeModal();
          break;
        case "result": {
          const handler = onModalResult;
          closeModal();
          handler?.(action.value);
          break;
        }
      }
    },
    // The panel split costs nothing but a repaint (the panel grid is rebuilt
    // each frame), so it applies immediately instead of going through the
    // resize throttle the two width handles need.
    panelSplit: () => {
      const viewState = activePanelViewState();
      if (!viewState) return null;
      const view = panelViewLayout(layout.ptyRows, viewState);
      if (!view.showDetail) return null;
      // Panel-internal rows -> absolute grid rows.
      return {
        row: layout.contentTop + view.sepRow,
        minRow: layout.contentTop + view.minSepRow,
        maxRow: layout.contentTop + view.maxSepRow,
      };
    },
    onDragMove: (handle, pos) => {
      if (handle === "panel-split") {
        applyPanelSplit(pos);
        return;
      }
      pendingDragResize = { handle, col: pos };
      scheduleDragResize();
    },
    // A cancel (keystroke or wheel mid-drag) stops tracking but keeps the
    // width the drag already applied — with a live resize the new size is
    // what's on screen, and snapping back would be the surprising outcome.
    // So it persists, exactly like a commit; only the source of the final
    // position differs. The handle comes from the cancelled drag itself, not
    // from hover state: a drag that was never hovered (or whose hover moved
    // on) still has to know which width it owns.
    onDragCancel: (handle) => {
      clearPendingDragResize();
      if (dragDidResize) persistDragWidth(handle);
      dragDidResize = false;
    },
    // Commit order matters: assign the module-level width *before* writing
    // config. configStore.set fires the file watcher, which relayouts only
    // when the persisted value differs from the module state — assigning
    // first makes that check false, so the watcher doesn't fire a second,
    // visible resize on top of the one relayout() just did.
    onDragCommit: (handle, pos) => {
      if (handle === "panel-split") {
        applyPanelSplit(pos);
        persistDragWidth(handle);
        dragDidResize = false;
        return;
      }
      // Flush the final position synchronously: the last move may still be
      // sitting behind the throttle, and releasing must land exactly where
      // the pointer did.
      clearPendingDragResize();
      pendingDragResize = { handle, col: pos };
      applyPendingDragResize();
      persistDragWidth(handle);
      dragDidResize = false;
    },
    onSessionPrev: () => switchByOffset(-1),
    onSessionNext: () => switchByOffset(1),
    glassActive: () => inGlass,
    onGlassClick: (x, y) => {
      glassView?.focusAt(x, y);
      scheduleRender();
    },
    onGlassMouse: (x, y, button, release) => {
      glassView?.forwardMouse(x, y, button, release);
      scheduleRender();
    },
    onGlassFocusMove: (dir) => {
      glassView?.moveFocus(dir);
      scheduleRender();
    },
    glassStripRows: () => (inGlass && stripVisibleFor(commandCenterTabs) ? STRIP_ROWS : 0),
    onGlassTabClick: (x) => { const id = chipAtCol(currentStripChips, x); if (id) switchCommandCenterTab(id); },
    onGlassTabSwitch: (n) => { const tab = commandCenterTabs[n - 1]; if (tab) switchCommandCenterTab(tab.id); },
    onGlassTabRelative: (delta) => switchCommandCenterTabRelative(delta),
    onGlassDetach: () => detachClient(),
    onDiffToggle: () => toggleDiffPanel(),
    onDiffZoom: () => zoomDiffPanel(),
    onPaneNavRight: async () => {
      // Shift+Right intercepted — check if we're at the rightmost pane
      try {
        const lines = await control.sendCommand("display-message -p '#{pane_at_right}'");
        if ((lines[0] || "").trim() === "1") {
          // At right edge — focus the diff panel
          setDiffFocus(true);
        } else {
          // Not at right edge — forward Shift+Right to tmux for normal pane switch
          pty.write("\x1b[1;2C");
        }
      } catch {
        // Control query failed — forward to tmux as fallback
        pty.write("\x1b[1;2C");
      }
    },
    onDiffPanelData: (data) => {
      if (diffPty) diffPty.write(data);
    },
    onDiffPanelFocusToggle: () => {
      if (!diffPanel.isActive() || diffPanel.state === "full") return;
      setDiffFocus(!diffPanelFocused);
    },
    onPanelPrevTab: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) viewState.filterQuery = null;
      infoPanel.prevTab();
      inputRouter.setPanelTabsActive(infoPanel.activeTab !== "diff");
      scheduleRender();
    },
    onPanelNextTab: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) viewState.filterQuery = null;
      infoPanel.nextTab();
      inputRouter.setPanelTabsActive(infoPanel.activeTab !== "diff");
      scheduleRender();
    },
    onPanelSelectPrev: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState && viewState.selectedIndex > 0) {
        viewState.selectedIndex--;
        viewState.detailScrollOffset = 0; // reset detail scroll on item change
        // Scroll list if selection is above visible area
        if (viewState.selectedIndex < viewState.scrollOffset) {
          viewState.scrollOffset = viewState.selectedIndex;
        }
        scheduleRender();
      }
    },
    onPanelSelectNext: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (!viewState) return;
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
      const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);
      let rawItems: import("./panel-view-renderer").RenderableItem[];
      if (view.source === "issues") {
        rawItems = transformIssues(issuesForView(view), linkedIssueIds, getIssueSessionStates(), mrsByUrl());
      } else if (view.filter.scope === "reviewing") {
        rawItems = transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds);
      } else {
        rawItems = transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
      }
      if (viewState.filterQuery) rawItems = filterItems(rawItems, viewState.filterQuery);
      const effectiveView = viewState.filterQuery ? { ...view, groupBy: "none" as const } : view;
      const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
      if (viewState.selectedIndex < nodes.length - 1) {
        viewState.selectedIndex++;
        viewState.detailScrollOffset = 0; // reset detail scroll on item change
        // Scroll list if selection goes below visible area
        const dpRows = layout.ptyRows;
        const { listRows } = panelViewLayout(dpRows, viewState);
        if (viewState.selectedIndex >= viewState.scrollOffset + listRows) {
          viewState.scrollOffset = viewState.selectedIndex - listRows + 1;
        }
        scheduleRender();
      }
    },
    // Edit the active view's membership filter from the panel itself.
    //
    // Without this, `states` / `stages` / `labels` / `priorityAtMost` could only
    // be set by hand-editing config.json, which makes "build your own queue" a
    // feature only people willing to write JSON can use. The option lists come
    // from the tracker (workflow states) or from jmux's own stage set, so this
    // works in any Linear workspace without knowing a thing about it.
    onPanelEditFilter: () => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view || view.source !== "issues") return;
      openViewFilterMenu(view);
    },
    onPanelCycleGroupBy: () => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      view.groupBy = cycleGroupBy(view.groupBy);
      debouncedViewSave(view);
      scheduleRender();
    },
    onPanelCycleSubGroupBy: () => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      view.subGroupBy = cycleGroupBy(view.subGroupBy);
      debouncedViewSave(view);
      scheduleRender();
    },
    onPanelCycleSortBy: () => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      view.sortBy = cycleSortBy(view.sortBy);
      debouncedViewSave(view);
      scheduleRender();
    },
    onPanelToggleSortOrder: () => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      view.sortOrder = toggleSortOrder(view.sortOrder);
      debouncedViewSave(view);
      scheduleRender();
    },
    onPanelToggleCollapse: () => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      const viewState = viewStates.get(view.id);
      if (!viewState) return;
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
      const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);
      let rawItems = view.source === "issues"
        ? transformIssues(issuesForView(view), linkedIssueIds, getIssueSessionStates(), mrsByUrl())
        : view.filter.scope === "reviewing"
          ? transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds)
          : transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
      if (viewState.filterQuery) rawItems = filterItems(rawItems, viewState.filterQuery);
      const effectiveView = viewState.filterQuery ? { ...view, groupBy: "none" as const } : view;
      const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
      const selected = nodes[viewState.selectedIndex];
      if (selected?.kind === "group") {
        const key = selected.key;
        if (viewState.collapsedGroups.has(key)) viewState.collapsedGroups.delete(key);
        else viewState.collapsedGroups.add(key);
        scheduleRender();
      }
    },
    onPanelCreateSession: async () => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view || view.source !== "issues") return;
      const viewState = viewStates.get(view.id);
      if (!viewState) return;
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
      let rawItems = transformIssues(issuesForView(view), linkedIssueIds, getIssueSessionStates(), mrsByUrl());
      if (viewState.filterQuery) rawItems = filterItems(rawItems, viewState.filterQuery);
      const effectiveView = viewState.filterQuery ? { ...view, groupBy: "none" as const } : view;
      const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
      const selected = nodes[viewState.selectedIndex];
      if (selected?.kind !== "item" || selected.item.type !== "issue") return;
      await startWorkOnIssue(
        selected.item.raw as import("./adapters/types").Issue,
        selected.item.issueSessionState ?? "none",
        selected.item.linkedSessionName,
      );
    },

    onPanelLinkToSession: () => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      const viewState = viewStates.get(view.id);
      if (!viewState) return;
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
      const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);
      let rawItems = view.source === "issues"
        ? transformIssues(issuesForView(view), linkedIssueIds, getIssueSessionStates(), mrsByUrl())
        : view.filter.scope === "reviewing"
          ? transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds)
          : transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
      if (viewState.filterQuery) rawItems = filterItems(rawItems, viewState.filterQuery);
      const effectiveView = viewState.filterQuery ? { ...view, groupBy: "none" as const } : view;
      const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
      const selected = nodes[viewState.selectedIndex];
      if (selected?.kind !== "item") return;
      if (!sessionName) return;
      if (selected.item.type === "issue") {
        const issue = selected.item.raw as import("./adapters/types").Issue;
        sessionState.addLink(sessionName, { type: "issue", id: issue.id });
        pollCoordinator.addLinkedIssue(sessionName, issue);
      } else {
        const mr = selected.item.raw as import("./adapters/types").MergeRequest;
        sessionState.addLink(sessionName, { type: "mr", id: mr.id });
        pollCoordinator.addLinkedMr(sessionName, mr);
      }
      scheduleRender();
    },
    onPanelFilterStart: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) {
        viewState.filterQuery = "";  // "" = bar open, no text yet
        scheduleRender();
      }
    },
    onPanelFilterInput: (char) => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) {
        viewState.filterQuery = (viewState.filterQuery ?? "") + char;
        viewState.selectedIndex = 0;
        viewState.scrollOffset = 0;
        viewState.detailScrollOffset = 0;
        scheduleRender();
      }
    },
    onPanelFilterBackspace: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState && viewState.filterQuery && viewState.filterQuery.length > 0) {
        viewState.filterQuery = viewState.filterQuery.slice(0, -1);
        viewState.selectedIndex = 0;
        viewState.scrollOffset = 0;
        viewState.detailScrollOffset = 0;
        scheduleRender();
      }
    },
    onPanelFilterClear: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) {
        viewState.filterQuery = null;
        viewState.selectedIndex = 0;
        viewState.scrollOffset = 0;
        viewState.detailScrollOffset = 0;
        scheduleRender();
      }
    },
    onPanelRefresh: () => {
      pollCoordinator.pollGlobal();
      scheduleRender();
    },
    onPanelScroll: (delta, row) => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      const viewState = viewStates.get(view.id);
      if (!viewState) return;

      // Determine if scroll is in list area or detail area
      const dpRows = layout.ptyRows;
      const { listRows } = panelViewLayout(dpRows, viewState);

      if (row < listRows) {
        // Scroll list
        const newOffset = viewState.scrollOffset + delta;
        viewState.scrollOffset = Math.max(0, newOffset);
      } else {
        // Scroll detail
        const newOffset = viewState.detailScrollOffset + delta;
        viewState.detailScrollOffset = Math.max(0, newOffset);
      }
      scheduleRender();
    },
    onPanelTabHover: (col) => {
      const ranges = infoPanel.getTabRanges();
      let found: string | null = null;
      for (const { tab, startCol, endCol } of ranges) {
        if (col >= startCol && col <= endCol) { found = tab; break; }
      }
      if (found !== hoveredPanelTabId) {
        hoveredPanelTabId = found;
        scheduleRender();
      }
    },
    onPanelItemClick: (row) => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      const viewState = viewStates.get(view.id);
      if (!viewState) return;
      // Only handle clicks in the list area (top half)
      const dpRows = layout.ptyRows;
      const { listRows } = panelViewLayout(dpRows, viewState);
      if (row >= listRows) return; // click was in detail area — ignore
      // row is relative to panel content (after toolbar row)
      const nodeIndex = row + viewState.scrollOffset;
      if (nodeIndex >= 0) {
        const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
        const ctx = pollCoordinator.getContext(sessionName);
        const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
        const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);
        let rawItems = view.source === "issues"
          ? transformIssues(issuesForView(view), linkedIssueIds, getIssueSessionStates(), mrsByUrl())
          : view.filter.scope === "reviewing"
            ? transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds)
            : transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
        if (viewState.filterQuery) rawItems = filterItems(rawItems, viewState.filterQuery);
        const effectiveView = viewState.filterQuery ? { ...view, groupBy: "none" as const } : view;
        const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
        if (nodeIndex < nodes.length) {
          viewState.selectedIndex = nodeIndex;
          scheduleRender();
        }
      }
    },
    onPanelTabClick: (col) => {
      const ranges = infoPanel.getTabRanges();
      for (const { tab, startCol, endCol } of ranges) {
        if (col >= startCol && col <= endCol) {
          infoPanel.setActiveTab(tab);
          inputRouter.setPanelTabsActive(infoPanel.activeTab !== "diff");
          scheduleRender();
          return;
        }
      }
    },
    onPanelAction: (key) => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;

      // Create issue (Shift-C) — doesn't require a selected item
      if (key === "C" && view.source === "issues" && adapters.issueTracker?.authState === "ok") {
        openCreateIssueModal();
        return;
      }

      const viewState = viewStates.get(view.id);
      if (!viewState) return;
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
      const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);
      let rawItems = view.source === "issues"
        ? transformIssues(issuesForView(view), linkedIssueIds, getIssueSessionStates(), mrsByUrl())
        : view.filter.scope === "reviewing"
          ? transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds)
          : transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
      if (viewState.filterQuery) rawItems = filterItems(rawItems, viewState.filterQuery);
      const effectiveView = viewState.filterQuery ? { ...view, groupBy: "none" as const } : view;
      const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
      const selected = nodes[viewState.selectedIndex];
      if (selected?.kind !== "item") return;

      if (selected.item.type === "mr" && adapters.codeHost) {
        const mr = selected.item.raw as import("./adapters/types").MergeRequest;
        if (key === "o") adapters.codeHost.openInBrowser(mr.id);
        if (key === "a") adapters.codeHost.approve(mr.id).then(() => { pollCoordinator.refreshGlobalItem("mr", mr.id); scheduleRender(); });
      }
      if (selected.item.type === "issue" && adapters.issueTracker) {
        const issue = selected.item.raw as import("./adapters/types").Issue;
        if (key === "o") adapters.issueTracker.openInBrowser(issue.id);
        if (key === "c") {
          // Copy issue prompt to clipboard via OSC 52
          const prompt = `You are working on ${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}\n\nStart by understanding the relevant code, then propose an approach.`;
          const encoded = Buffer.from(prompt).toString("base64");
          process.stdout.write(`\x1b]52;c;${encoded}\x07`);
        }
        if (key === "s") {
          adapters.issueTracker.getAvailableStatuses(issue.id).then((statuses) => {
            if (statuses.length === 0) return;
            const items = statuses.map((s) => ({ id: s, label: s }));
            const listModal = new ListModal({ items, header: "Update Status" });
            listModal.open();
            openModal(listModal, (selected: unknown) => {
              const sel = selected as { id: string };
              if (sel?.id) {
                pollCoordinator.optimisticIssueStatus(issue.id, sel.id);
                adapters.issueTracker!.updateStatus(issue.id, sel.id).then(() => { pollCoordinator.refreshGlobalItem("issue", issue.id); });
              }
            });
          });
        }
      }
    },
  },
  layout,
);

const palette = new CommandPalette();
let activeModal: Modal | null = null;
let onModalResult: ((value: unknown) => void) | null = null;

function openModal(modal: Modal, onResult: (value: unknown) => void): void {
  activeModal = modal;
  onModalResult = onResult;
  inputRouter.setModalOpen(true);
  renderFrame();
}

function closeModal(): void {
  activeModal?.close();
  activeModal = null;
  onModalResult = null;
  // Hand routing back to whatever is still claiming input rather than clearing
  // it outright. A full-screen surface can host a modal — the ghost preview
  // opens the status picker over itself — and blindly clearing here left that
  // surface painted but deaf, with the next keystroke leaking to the pty.
  // Modal results call closeModal() before their callback, and SIGWINCH calls
  // it too, so both paths went through this.
  inputRouter.setModalOpen(inputConsumerActive());
  renderFrame();
}

function showNewSessionError(result: NewSessionResult, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const title = result.type === "new_worktree"
    ? `New worktree '${result.name}' failed`
    : result.type === "existing_worktree"
      ? `Worktree session '${result.branch}' failed`
      : `New session '${result.name}' failed`;
  const hint = result.type === "new_worktree"
    ? "The worktree, branch, or session name may already exist."
    : "The session name may already exist.";
  const lines: StyledLine[] = [
    [],
    [{ text: message, attrs: { fg: 1, fgMode: 1, bg: theme.surface, bgMode: 2 } }],
    [],
    [{ text: hint, attrs: { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 } }],
    [],
    [{ text: "Press q or Esc to close.", attrs: { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 } }],
  ];
  const modal = new ContentModal({ lines, title });
  modal.setTermRows(process.stdout.rows || 24);
  modal.open();
  openModal(modal, () => {});
  scheduleRender();
}

function togglePalette(): void {
  if (activeModal) {
    closeModal();
  } else {
    openPalette();
  }
}

function openPalette(): void {
  const commands = buildPaletteCommands();
  palette.open(commands);
  openModal(palette, (value) => {
    handlePaletteAction(value as PaletteResult);
  });
}

function buildPaletteCommands(): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

  const cfg = configStore.config;

  // Dynamic: switch to session (excluding current)
  for (const session of currentSessions) {
    if (session.id === currentSessionId) continue;
    commands.push({
      id: `switch-session:${session.id}`,
      label: `Switch to ${session.name}`,
      category: "session",
    });
  }

  // Dynamic: switch to window (excluding active)
  for (const win of currentWindows) {
    if (win.active) continue;
    commands.push({
      id: `switch-window:${win.windowId}`,
      label: `Switch to ${win.name}`,
      category: "window",
    });
  }

  // Dynamic: collapse/expand groups. The command id carries the axis-namespaced
  // collapse key; the human label uses the group's display name.
  for (const group of sidebar.getGroups()) {
    commands.push({
      id: `toggle-group:${group.key}`,
      label: group.collapsed ? `Expand: ${group.label}` : `Collapse: ${group.label}`,
      category: "session",
    });
  }

  // Dynamic: pin/unpin current session
  {
    const currentName = currentSessions.find(s => s.id === currentSessionId)?.name;
    if (currentName) {
      if (pinnedSessions.has(currentName)) {
        commands.push({
          id: "unpin-session",
          label: `Unpin session: ${currentName}`,
          category: "session",
        });
      } else {
        commands.push({
          id: "pin-session",
          label: `Pin session: ${currentName}`,
          category: "session",
        });
      }
      if (panelViews.some((v) => v.id === infoPanel.activeTab)) {
        commands.push({
          id: "save-view-as-tab",
          label: "Save current view as tab",
          category: "issue",
        });
      }
      const next = upNextIssue();
      if (next) {
        commands.push({
          id: "start-up-next",
          label: `Up next · ${next.viewLabel}: ${next.issue.identifier} ${next.issue.title}`,
          category: "issue",
        });
      }
      commands.push({
        id: "toggle-park-session",
        label: sidebar.isParked(currentName)
          ? `Unpark session: ${currentName}`
          : `Park session: ${currentName}`,
        category: "session",
      });
    }
  }

  // Command Center commands (context-aware: in-glass vs session).
  {
    const focusedPaneId = inGlass ? (glassView?.focusedPaneId() ?? null) : null;
    const focusedTabId = focusedPaneId
      ? resolveTabId(pinnedTracker.getValue(focusedPaneId) ?? null, commandCenterTabs)
      : null;
    const focusedIsAuto = focusedPaneId ? !pinnedTracker.has(focusedPaneId) : false;
    let sessionActivePinned = false;
    if (!inGlass && currentSessionId) {
      const activePane = glassRunner.run(["display-message", "-p", "-t", currentSessionId, "#{pane_id}"]).lines[0];
      sessionActivePinned = activePane ? pinnedTracker.has(activePane) : false;
    }
    const tabCounts = new Map<string, number>();
    for (const tab of commandCenterTabs) tabCounts.set(tab.id, 0);
    for (const paneId of pinnedTracker.all()) {
      const tid = resolveTabId(pinnedTracker.getValue(paneId) ?? null, commandCenterTabs);
      tabCounts.set(tid, (tabCounts.get(tid) ?? 0) + 1);
    }
    commands.push(...buildCcCommands({
      inGlass, tabs: commandCenterTabs, activeTabId, tabCounts,
      focusedPaneId, focusedTabId, focusedIsAuto, sessionActivePinned,
    }));
  }

  // Static commands
  commands.push(
    { id: "new-session", label: "New session", category: "session" },
    { id: "kill-session", label: "Kill session", category: "session" },
    { id: "rename-session", label: "Rename session", category: "session" },
    { id: "new-window", label: "New window", category: "window" },
    { id: "rename-window", label: "Rename window", category: "window" },
    { id: "close-window", label: "Close window", category: "window" },
    { id: "move-window", label: "Move window to session", category: "window" },
    { id: "split-h", label: "Split horizontal", category: "pane" },
    { id: "split-v", label: "Split vertical", category: "pane" },
    { id: "zoom-pane", label: "Zoom pane", category: "pane" },
    { id: "close-pane", label: "Close pane", category: "pane" },
    { id: "open-claude", label: "Open Claude", category: "other" },
    { id: "settings-screen", label: "Settings", category: "other" },
  );

  // Diff panel commands
  commands.push(
    { id: "diff-toggle", label: "Toggle diff panel", category: "diff" },
    { id: "diff-zoom", label: "Zoom diff panel", category: "diff" },
  );

  // Settings
  commands.push({
    id: "setting-sidebar-width",
    label: "Sidebar width",
    category: "setting",
  });
  commands.push({
    id: "setting-panel-width",
    label: `Panel width${infoPanelWidth !== null ? `: ${infoPanelWidth}` : " (auto)"}`,
    category: "setting",
  });

  // The palette edits *global defaults*; per-repo overrides are the settings
  // screen's "This repo" category. Label and action therefore both read the
  // default tier, so what you see is what the keypress changes.
  const repoNow = repoDefaultsView();
  commands.push({
    id: "setting-wtm",
    label: `wtm integration: ${repoNow.wtmIntegration ? "on" : "off"}`,
    category: "setting",
  });
  commands.push({
    id: "setting-claude-command",
    label: "Claude command",
    category: "setting",
  });
  commands.push({
    id: "setting-project-dirs",
    label: "Project directories",
    category: "setting",
  });
  // The palette only lists one-shot setting *commands*; anything with a real
  // editor (the stage/parking multiselects) lives in the settings screen, so
  // the palette needs a way through to it rather than being a dead end.
  commands.push({
    id: "setting-edit-workflow",
    label: "Configure workflow (your stages, statuses, parking, tracker writes)…",
    category: "setting",
  });
  commands.push({
    id: "setting-open-screen",
    label: "All settings…",
    category: "setting",
  });
  commands.push({
    id: "setting-cache-timers",
    label: `Cache timers: ${cfg.cacheTimers !== false ? "on" : "off"}`,
    category: "setting",
  });
  commands.push({
    id: "setting-running-color",
    label: `Running state color: ${currentStateColorName("running")}`,
    category: "setting",
  });
  commands.push({
    id: "setting-waiting-color",
    label: `Waiting state color: ${currentStateColorName("waiting")}`,
    category: "setting",
  });
  commands.push({
    id: "setting-complete-color",
    label: `Complete state color: ${currentStateColorName("complete")}`,
    category: "setting",
  });

  // Adapter settings
  const adaptersCfg = cfg.adapters ?? {};
  const codeHostType = adaptersCfg.codeHost?.type ?? "none";
  const issueTrackerType = adaptersCfg.issueTracker?.type ?? "none";
  commands.push({
    id: "setting-code-host",
    label: `Code host: ${codeHostType}`,
    category: "setting",
  });
  commands.push({
    id: "setting-issue-tracker",
    label: `Issue tracker: ${issueTrackerType}`,
    category: "setting",
  });

  // Issue workflow settings
  const wf = cfg.issueWorkflow;
  commands.push({
    id: "setting-default-branch",
    label: `Default base branch: ${repoNow.defaultBaseBranch}`,
    category: "setting",
  });
  commands.push({
    id: "setting-team-repo-map",
    label: `Team → repo mappings (${Object.keys(wf?.teamRepoMap ?? {}).length})`,
    category: "setting",
  });
  commands.push({
    id: "setting-session-template",
    label: `Session name template: ${repoNow.sessionNameTemplate}`,
    category: "setting",
  });
  commands.push({
    id: "setting-auto-agent",
    label: `Auto-launch agent: ${repoNow.autoLaunchAgent ? "on" : "off"}`,
    category: "setting",
  });

  // Create issue
  if (adapters.issueTracker?.authState === "ok" && cachedTeams.length > 0) {
    commands.push(
      { id: "new-issue", label: "New Issue", category: "issue" },
    );
  }

  // Link commands
  if (adapters.issueTracker?.authState === "ok") {
    commands.push(
      { id: "link-issue", label: "Link issue to session", category: "link" },
      { id: "unlink-issue", label: "Unlink issue from session", category: "link" },
    );
  }
  if (adapters.codeHost?.authState === "ok") {
    commands.push(
      { id: "link-mr", label: "Link MR to session", category: "link" },
      { id: "unlink-mr", label: "Unlink MR from session", category: "link" },
    );
  }

  // Sidebar group / sort / filter — submenus mirroring the Ctrl-a G / s / f cycles.
  const activeGroup = sidebar.getGroupMode();
  const activeSort = sidebar.getSortMode();
  const activeFilter = sidebar.getFilterMode();
  commands.push({
    id: "sidebar-group", label: "Group sessions…", category: "session",
    sublist: GROUP_MODES.map((m) => ({ id: m, label: groupModeLabel(m), current: m === activeGroup })),
  });
  commands.push({
    id: "sidebar-sort", label: "Sort sessions…", category: "session",
    sublist: SORT_MODES.map((m) => ({ id: m, label: sortModeLabel(m), current: m === activeSort })),
  });
  commands.push({
    id: "sidebar-filter", label: "Filter sessions…", category: "session",
    sublist: FILTER_MODES.map((f) => ({ id: f, label: filterModeLabel(f), current: f === activeFilter })),
  });

  return commands;
}

function currentStateColorName(state: AgentState): string {
  return configStore.config.stateColors?.[state] ?? DEFAULT_STATE_COLORS[state];
}

function persistStateColor(state: AgentState, name: string): void {
  configStore.set("stateColors", { ...configStore.config.stateColors, [state]: name });
}

// The per-repo settings, described once and rendered into two tiers: the
// global-default rows (writing `repoDefaults`) and the override rows under a
// "This repo" category (writing `repos[key]`). Describing them once is what
// keeps the two tiers from drifting, and is why adding a per-repo setting is
// a one-line change here rather than an edit in two places.
type RepoRowKind = "text" | "boolean" | "multiselect" | "state";

interface RepoRow {
  id: string;
  label: string;
  field: keyof RepoSettings;
  kind: RepoRowKind;
  group: "workflow" | "transitions";
}

const REPO_SETTING_ROWS: RepoRow[] = [
  { id: "default-branch", label: "Default base branch", field: "defaultBaseBranch", kind: "text", group: "workflow" },
  { id: "session-template", label: "Session name template", field: "sessionNameTemplate", kind: "text", group: "workflow" },
  { id: "claude-command", label: "Claude command", field: "claudeCommand", kind: "text", group: "workflow" },
  { id: "wtm", label: "wtm integration", field: "wtmIntegration", kind: "boolean", group: "workflow" },
  { id: "auto-agent", label: "Auto-launch agent", field: "autoLaunchAgent", kind: "boolean", group: "workflow" },

  { id: "on-start", label: "On session start", field: "onSessionStartState", kind: "state", group: "transitions" },
  { id: "on-mr-open", label: "On MR opened", field: "onMrOpenState", kind: "state", group: "transitions" },
  { id: "on-mr-merged", label: "On MR merged", field: "onMrMergedState", kind: "state", group: "transitions" },
];

/** Sentinel option meaning "leave the tracker alone on this event". */
const NEVER_OPTION = "(never)";

/**
 * Where a tier reads its effective value from and where it writes it back to.
 * The two tiers differ only in these four functions, so every row kind is
 * implemented once.
 */
interface RepoTier {
  idPrefix: string;
  read: (field: keyof RepoSettings) => unknown;
  write: (field: keyof RepoSettings, value: unknown) => void;
  scope?: (field: keyof RepoSettings) => "inherited" | "override";
  clear?: (field: keyof RepoSettings) => void;
}

function buildRepoRows(group: RepoRow["group"], tier: RepoTier): SettingDef[] {
  return REPO_SETTING_ROWS.filter((r) => r.group === group).map((row) => {
    const shown = (): string => {
      const v = tier.read(row.field);
      if (typeof v === "boolean") return v ? "on" : "off";
      if (Array.isArray(v)) return v.length ? v.join(", ") : "none";
      if (v === null || v === undefined) return NEVER_OPTION;
      return String(v);
    };
    const base: SettingDef = {
      id: `${tier.idPrefix}${row.id}`,
      label: row.label,
      type: row.kind === "state" ? "list" : row.kind,
      getValue: shown,
      ...(tier.scope ? { getScope: () => tier.scope!(row.field) } : {}),
      ...(tier.clear ? { onClearOverride: () => tier.clear!(row.field) } : {}),
    };

    switch (row.kind) {
      case "boolean":
        return { ...base, onToggle: () => tier.write(row.field, shown() !== "on") };
      case "text":
        return { ...base, onTextCommit: (v: string) => tier.write(row.field, v) };
      case "multiselect":
        return {
          ...base,
          getOptions: workflowStateOptions,
          getSelected: () => (tier.read(row.field) as string[] | undefined) ?? [],
          onToggleOption: (id: string) => {
            const cur = ((tier.read(row.field) as string[] | undefined) ?? []).slice();
            const at = cur.findIndex((n) => n.toLowerCase() === id.toLowerCase());
            if (at >= 0) cur.splice(at, 1); else cur.push(id);
            tier.write(row.field, cur);
          },
        };
      case "state":
        return {
          ...base,
          options: [NEVER_OPTION, ...cachedWorkflowStates.map((s) => s.name)],
          onOptionSelect: (v: string) => tier.write(row.field, v === NEVER_OPTION ? null : v),
        };
    }
  });
}

/** Global-default rows — these write to `repoDefaults`. */
function repoDefaultTier(): RepoTier {
  return {
    idPrefix: "",
    read: (field) => configStore.config.repoDefaults?.[field] ?? REPO_SETTING_DEFAULTS[field],
    write: (field, value) => configStore.setRepoDefault(field, value as never),
  };
}

function repoDefaultSettings(group: RepoRow["group"] = "workflow"): SettingDef[] {
  return buildRepoRows(group, repoDefaultTier());
}

/**
 * Override rows for the repo the active session lives in. Absent entirely when
 * there is no repo-backed session — an override category with nothing to
 * override would just be a second, confusing copy of the defaults.
 */
function currentRepoCategory(): SettingsCategory[] {
  const name = currentSessions.find((s) => s.id === currentSessionId)?.name;
  const dir = name ? sessionDir(name) : null;
  if (!dir) return [];
  const key = repoFacts.get(dir).key;
  if (!key) return [];

  const label = key.replace(/\/\.git$/, "").split("/").pop() ?? key;
  const tier: RepoTier = {
    idPrefix: "repo-",
    read: (field) => repoSettingsFor(dir)[field as keyof ResolvedRepoSettings],
    write: (field, value) => configStore.setRepoOverride(key, field, value as never),
    scope: (field) =>
      configStore.config.repos?.[key]?.[field] !== undefined ? "override" : "inherited",
    clear: (field) => configStore.clearRepoOverride(key, field),
  };

  // Transitions are not here: they moved onto the workflow screen, which shows
  // the effective value for this repo and switches tier with `g`. Listing them
  // in both places is how the chain came to be split across four categories.
  return [{
    label: `This repo · ${label}`,
    collapsed: false,
    settings: buildRepoRows("workflow", tier),
  }];
}

function buildSettingsCategories(): SettingsCategory[] {
  const wf = () => configStore.config.issueWorkflow;
  const adapterCfg = () => configStore.config.adapters;

  return [
    {
      label: "Display",
      collapsed: false,
      settings: [
        {
          id: "sidebar-width", label: "Sidebar width", type: "text" as const,
          getValue: () => String(sidebarWidth),
          onTextCommit: (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 10 && n <= 60) configStore.set("sidebarWidth", n);
          },
        },
        {
          id: "panel-width", label: "Panel width", type: "text" as const,
          getValue: () => infoPanelWidth !== null ? String(infoPanelWidth) : "auto",
          onTextCommit: (v) => {
            if (v === "auto" || v === "") {
              configStore.set("infoPanelWidth", undefined as any);
            } else {
              const n = parseInt(v, 10);
              if (!isNaN(n) && n >= 20 && n <= 120) {
                configStore.set("infoPanelWidth", n);
              }
            }
          },
        },
        {
          id: "cache-timers", label: "Cache timers", type: "boolean" as const,
          getValue: () => cacheTimersEnabled ? "on" : "off",
          onToggle: () => {
            cacheTimersEnabled = !cacheTimersEnabled;
            sidebar.cacheTimersEnabled = cacheTimersEnabled;
            configStore.set("cacheTimers", cacheTimersEnabled);
          },
        },
        {
          id: "inline-images", label: "Inline images in issue previews", type: "boolean" as const,
          // The value discloses *why* it reads the way it does. A plain on/off
          // here would let the row claim "on" on a terminal that cannot draw a
          // pixel, which is the same trap as a per-stage toggle under a master
          // switch that's off: a preference reported as in effect when it isn't.
          getValue: () => {
            const forced = configStore.config.images?.enabled;
            if (forced === false) return "off";
            if (forced === true) return imagesSupported === false ? "on (terminal can't draw)" : "on";
            if (imagesSupported === true) return "on";
            if (imagesSupported === false) return "off (terminal can't draw)";
            return "off (detecting…)";
          },
          onToggle: () => {
            configStore.set("images", { ...configStore.config.images, enabled: !imagesOn() });
            applyImageSupport();
          },
        },
        {
          id: "image-max-rows", label: "Max image height (rows)", type: "text" as const,
          getValue: () => String(configStore.config.images?.maxRows ?? DEFAULT_IMAGE_MAX_ROWS),
          onTextCommit: (v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 1 && n <= 60) {
              configStore.set("images", { ...configStore.config.images, maxRows: n });
              scheduleRender();
            }
          },
        },
        {
          id: "auto-pin-agents",
          label: "Auto-pin agent panes to Command Center",
          type: "boolean" as const,
          getValue: () => autoPinAgentPanes ? "on" : "off",
          onToggle: () => {
            autoPinAgentPanes = !autoPinAgentPanes;
            configStore.set("autoPinAgentPanes", autoPinAgentPanes);
            refreshPinnedPanes();
          },
        },
        {
          id: "agent-pane-regex",
          label: "Auto-pin command match (regex)",
          type: "text" as const,
          getValue: () => agentPaneRegex,
          onTextCommit: (v) => {
            agentPaneRegex = v;
            configStore.set("agentPaneCommandRegex", v);
            refreshPinnedPanes();
          },
        },
        {
          id: "running-color", label: "Running state color", type: "list" as const,
          getValue: () => currentStateColorName("running"),
          options: [...STATE_COLOR_NAMES],
          onOptionSelect: (v) => persistStateColor("running", v),
        },
        {
          id: "waiting-color", label: "Waiting state color", type: "list" as const,
          getValue: () => currentStateColorName("waiting"),
          options: [...STATE_COLOR_NAMES],
          onOptionSelect: (v) => persistStateColor("waiting", v),
        },
        {
          id: "complete-color", label: "Complete state color", type: "list" as const,
          getValue: () => currentStateColorName("complete"),
          options: [...STATE_COLOR_NAMES],
          onOptionSelect: (v) => persistStateColor("complete", v),
        },
      ],
    },
    {
      label: "Integrations",
      collapsed: false,
      settings: [
        {
          id: "code-host", label: "Code host", type: "list" as const,
          getValue: () => adapterCfg()?.codeHost?.type ?? "none",
          options: ["gitlab", "github", "none"],
          onOptionSelect: (v) => configStore.setAdapter("codeHost", v === "none" ? null : { type: v }),
        },
        {
          id: "issue-tracker", label: "Issue tracker", type: "list" as const,
          getValue: () => adapterCfg()?.issueTracker?.type ?? "none",
          options: ["linear", "github", "none"],
          onOptionSelect: (v) => configStore.setAdapter("issueTracker", v === "none" ? null : { type: v }),
        },
      ],
    },
    {
      label: "Repo",
      collapsed: false,
      settings: [
        ...repoDefaultSettings(),
        {
          id: "team-repo-map", label: "Team → repo mappings", type: "map" as const,
          getValue: () => {
            const entries = Object.entries(wf()?.teamRepoMap ?? {});
            return entries.length > 0 ? `${entries.length} mapped` : "none";
          },
          getMapEntries: () => Object.entries(wf()?.teamRepoMap ?? {}).map(([k, v]) => ({ key: k, value: v })),
          getMapKeyOptions: () => {
            // Provide Linear teams if available, otherwise manual entry
            // Teams are fetched async in pollGlobal — use cached global issues' teams as proxy
            const teams = new Set<string>();
            for (const issue of pollCoordinator.getGlobalIssues()) {
              if (issue.team) teams.add(issue.team);
            }
            return [...teams].sort().map((t) => ({ id: t, label: t }));
          },
          getMapValueOptions: () => {
            const dirs = cachedProjectDirs.length > 0 ? cachedProjectDirs : [homedir()];
            return dirs.map((d) => ({ id: d, label: d.replace(homedir(), "~") }));
          },
          onMapSave: (key, value) => configStore.setTeamRepo(key, value),
          onMapRemove: (key) => configStore.setTeamRepo(key, null),
        },
      ],
    },
    {
      label: "Project",
      collapsed: false,
      settings: [
        {
          id: "project-dirs", label: "Project directories", type: "text" as const,
          getValue: () => {
            const dirs = configStore.config.projectDirs ?? [];
            return dirs.length > 0 ? dirs.join(", ") : "auto-detect";
          },
          onTextCommit: (v) => {
            const newDirs = v.split(",").map((s: string) => s.trim()).filter(Boolean);
            configStore.set("projectDirs", newDirs);
          },
        },
      ],
    },
    {
      // One row, because the whole chain — tabs, which statuses land in each,
      // what they mean, and everything that keys off that (parking, up next,
      // tracker writes) — lives on one screen now. Splitting it across four
      // settings categories and a modal stack is what made it confusing.
      label: "Workflow",
      collapsed: false,
      settings: [
        {
          id: "edit-workflow", label: "Configure workflow…", type: "action" as const,
          getValue: () => {
            const tabs = panelViews.filter((v) => v.source === "issues");
            const mapped = tabs.reduce((n, v) => n + (v.states ?? []).length, 0);
            const free = cachedWorkflowStates.filter(
              (st) => !tabs.some((v) => (v.states ?? []).some(
                (x) => x.trim().toLowerCase() === st.name.trim().toLowerCase()))).length;
            const parks = parkedStates().length;
            const tail = parks > 0 ? `${parks} park` : "nothing parks";
            return free > 0 ? `${free} statuses unmapped · ${tail}` : `${mapped} statuses · ${tail}`;
          },
          // The settings screen consumes every keystroke while it is open, so a
          // surface opened from here has to take routing over rather than
          // layering on top. openWorkflowScreen() closes settings first.
          onActivate: () => openWorkflowScreen(),
        },
      ],
    },
    {
      label: "Diagnostics",
      collapsed: false,
      settings: [
        {
          id: "park-status", label: "Parking status", type: "text" as const,
          getValue: () =>
            parkingSetupWarning(derivedStages().parked.length)
            ?? `active — ${currentSessions.filter((x) => sidebar.isParked(x.name)).length} parked`,
        },
        {
          id: "stage-source", label: "Tracker states available", type: "text" as const,
          getValue: () => {
            if (adapters.issueTracker?.authState !== "ok") return "tracker not connected";
            return cachedWorkflowStates.length > 0
              ? `${cachedWorkflowStates.length} states`
              : "none reported";
          },
        },
      ],
    },
    ...currentRepoCategory(),
  ];
}

function toggleSettingsScreen(): void {
  if (settingsScreen.isOpen) {
    settingsScreen.close();
    inputRouter.setModalOpen(inputConsumerActive());
  } else {
    if (ghostPreview.isOpen) closeGhostPreview();
    settingsScreen.open(buildSettingsCategories());
    inputRouter.setModalOpen(true);
  }
  // Settings is a frameless full-screen takeover (see fullScreenLayout) —
  // entering/leaving it changes which layout the sidebar/input router
  // should use even though the terminal geometry itself hasn't changed.
  applyChromeLayout();
  scheduleRender();
}

// --- Workflow screen ---
//
// The one surface that configures the issue pipeline: every tracker status,
// grouped under the tab it feeds, with the behaviour that keys off it below.
// See src/workflow-screen.ts for why it is shaped like that.

/** Issues sitting in each status right now, keyed by lowercased status name. */
function issueCountsByStatus(): Map<string, number> {
  const out = new Map<string, number>();
  for (const issue of pollCoordinator.getGlobalIssues()) {
    const key = (issue.status ?? "").trim().toLowerCase();
    if (key) out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Sessions each status is currently parking. This is what turns "this tab
 * parks" from a claim into an observation — the reported failure was a mapping
 * that looked configured and did nothing.
 */
function parkedCountsByStatus(): Map<string, number> {
  const out = new Map<string, number>();
  for (const session of currentSessions) {
    if (!sidebar.isParked(session.name)) continue;
    const status = pollCoordinator.getContext(session.name)?.issues[0]?.status;
    const key = (status ?? "").trim().toLowerCase();
    if (key) out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** The repo whose overrides the `repo` tier edits, or null when there is none. */
function currentRepoTier(): { label: string; tier: RepoTier } | null {
  const name = currentSessions.find((s) => s.id === currentSessionId)?.name;
  const dir = name ? sessionDir(name) : null;
  if (!dir) return null;
  const key = repoFacts.get(dir).key;
  if (!key) return null;
  return {
    label: key.replace(/\/\.git$/, "").split("/").pop() ?? key,
    tier: {
      idPrefix: "repo-",
      read: (field) => repoSettingsFor(dir)[field as keyof ResolvedRepoSettings],
      write: (field, value) => configStore.setRepoOverride(key, field, value as never),
      scope: (field) =>
        configStore.config.repos?.[key]?.[field] !== undefined ? "override" : "inherited",
      clear: (field) => configStore.clearRepoOverride(key, field),
    },
  };
}

function workflowBands(tier: SettingsTier): WorkflowBand[] {
  const repo = currentRepoTier();
  return [
    {
      label: "Parking",
      hint: "Parking is only safe because it reverses itself.",
      settings: [
        {
          id: "unpark-on", label: "Bring a session back when", type: "multiselect" as const,
          getValue: () => {
            const v = configStore.config.pipeline?.unparkOn ?? DEFAULT_PARKING.unparkOn;
            // Name them. "5 signals" told you a count, not what would happen.
            return v.length ? v.map((t) => UNPARK_TRIGGER_SHORT[t]).join(", ") : "never";
          },
          describe: () => {
            const v = configStore.config.pipeline?.unparkOn ?? DEFAULT_PARKING.unparkOn;
            return v.length === 0
              ? "Nothing brings a parked session back on its own — you would have to notice."
              : `Beats every parking rule, even a manual park: ${
                  v.map((t) => UNPARK_TRIGGER_LABELS[t]).join(", ")}.`;
          },
          getOptions: () => UNPARK_TRIGGERS.map((t) => ({ id: t, label: UNPARK_TRIGGER_LABELS[t] })),
          getSelected: () => configStore.config.pipeline?.unparkOn ?? DEFAULT_PARKING.unparkOn,
          onToggleOption: (id: string) => {
            const cur = (configStore.config.pipeline?.unparkOn ?? DEFAULT_PARKING.unparkOn).slice();
            const at = cur.indexOf(id as UnparkTrigger);
            if (at >= 0) cur.splice(at, 1); else cur.push(id as UnparkTrigger);
            configStore.setPipeline("unparkOn", cur);
            recomputeSessionBands();
          },
        },
        {
          id: "auto-park-idle", label: "Park issue-less sessions after", type: "text" as const,
          getValue: () => {
            const d = configStore.config.pipeline?.autoParkIdleDays ?? null;
            return d === null ? "never" : `${d} ${d === 1 ? "day" : "days"}`;
          },
          // "never" is prose, not an editable number: seeding the prompt with it
          // meant typing a day count produced "never3", which parses to nothing,
          // so this setting could not be switched on from its own prompt.
          getEditValue: () => {
            const d = configStore.config.pipeline?.autoParkIdleDays ?? null;
            return d === null ? "" : String(d);
          },
          describe: () => "Sessions with a linked issue are governed by their tab instead. Blank or 0 turns this off.",
          onTextCommit: (v: string) => {
            const n = parseInt(v, 10);
            configStore.setPipeline("autoParkIdleDays", isNaN(n) || n <= 0 ? null : n);
            recomputeSessionBands();
          },
        },
      ],
    },
    {
      label: "Unstarted work",
      hint: "The mirror of parking: work you have not picked up yet, shown in the sidebar.",
      settings: [
        {
          id: "show-unstarted", label: "Show unstarted work in the sidebar", type: "text" as const,
          getValue: () => formatGhostCap(storedGhostCap()),
          // The number on its own, so the prompt opens on something editable —
          // see the note on SettingDef.getEditValue.
          getEditValue: () => editGhostCap(storedGhostCap()),
          onTextCommit: (v: string) => setGhostCap(parseGhostCap(v)),
          // ◂ ▸ walk never → 1 … 99 → all. Enter still takes a typed number, so
          // the ladder covers the nudges and typing covers the jumps.
          onStep: (delta: number) => setGhostCap(stepGhostCap(storedGhostCap(), delta)),
          describe: () => {
            const n = ghostCap();
            // A number prompt gives no hint of what it accepts, and this one
            // takes a word as well — so the accepted forms are spelled out here,
            // on the line the user is reading when they press Enter.
            if (n === 0) {
              return `◂ ▸ to set a count, or "${GHOST_CAP_ALL}" for every one. Off, no stage shows unstarted work.`;
            }
            // The noun rides along with the quantity so it agrees with it —
            // "Top 3 unstarted issue" read as a typo in every case but n=1.
            const each = n === Infinity
              ? "Every unstarted issue"
              : `Top ${n} unstarted ${n === 1 ? "issue" : "issues"}`;
            // Names the per-stage switch, so the master and the exceptions each
            // point at the other rather than looking like the only control.
            const off = panelViews.filter((v) => v.source === "issues" && !stageShowsUnstarted(v)).length;
            const except = off > 0 ? ` ${off} stage${off === 1 ? "" : "s"} opted out (space above).` : "";
            // What the setting does depends on the grouping axis, so it says so
            // rather than describing a placement the user isn't looking at.
            if (sidebar.getGroupMode() === "stage") {
              return `${each} in each stage, under its own band.${except}`;
            }
            // Off the stage axis the rows collect in one band fed by Up next, so
            // an empty rotation is the one way this can look configured and do
            // nothing. Named in workflow order — the order they come out in.
            const stages = (configStore.config.pipeline?.upNext ?? [])
              .map((id) => panelViews.findIndex((v) => v.id === id))
              .filter((i) => i >= 0)
              .sort((a, b) => a - b)
              .map((i) => panelViews[i]!.label);
            if (stages.length === 0) {
              return "Grouped by stage this fills every band; on this axis it needs a stage in Up next — mark one with u above.";
            }
            return `${each} from each of ${stages.join(", ")}, in one band.${except} Group by stage (^a G) for a band each.`;
          },
        },
      ],
    },
    {
      label: TRANSITIONS_BAND,
      hint: "jmux writes nothing to your tracker until one of these names a state.",
      settings: [
        ...buildRepoRows("transitions", tier === "repo" && repo ? repo.tier : repoDefaultTier()),
        {
          id: "transition-confirm", label: "Confirmation", type: "list" as const,
          getValue: () => transitionConfirmMode(),
          describe: () => "undo-toast writes and offers Ctrl-a Z for 20s; always asks first; never writes silently.",
          options: ["undo-toast", "always", "never"],
          onOptionSelect: (v: string) =>
            configStore.setPipeline("transitionConfirm", v as "always" | "undo-toast" | "never"),
        },
      ],
    },
  ];
}

function buildWorkflowPort(): WorkflowPort {
  return {
    getViews: () => panelViews,
    setViews: (next) => persistViews(next),
    getStatuses: () => cachedWorkflowStates,
    getIssueCounts: issueCountsByStatus,
    getParkedCounts: parkedCountsByStatus,
    getParkedStates: parkedStates,
    toggleParked: (state) => {
      configStore.setPipeline("parkedStates", toggleParkedState(parkedStates(), state));
      recomputeSessionBands();
    },
    unstartedCap: ghostCap,
    getUpNext: () => configStore.config.pipeline?.upNext ?? [],
    toggleUpNext: (viewId) => {
      // Append on add, so the order you add them is the order Ctrl-a u checks.
      const cur = (configStore.config.pipeline?.upNext ?? []).slice();
      const at = cur.indexOf(viewId);
      if (at >= 0) cur.splice(at, 1); else cur.push(viewId);
      configStore.setPipeline("upNext", cur);
      // The Up next set is what the sidebar's ghost band draws from, so adding
      // or dropping a stage changes it immediately.
      recomputeGhosts();
      scheduleRender();
    },
    getBands: workflowBands,
    trackerLabel: () => {
      const type = configStore.config.adapters?.issueTracker?.type;
      if (!type || adapters.issueTracker?.authState !== "ok") return null;
      return type.charAt(0).toUpperCase() + type.slice(1);
    },
    repoLabel: () => currentRepoTier()?.label ?? null,
  };
}

/**
 * Open the workflow screen, closing whatever full-screen surface is up first.
 * Settings hands off to it, and a full-screen surface consumes every keystroke
 * while open — two of them at once would leave one painted and deaf.
 */
function openWorkflowScreen(): void {
  if (settingsScreen.isOpen) settingsScreen.close();
  if (ghostPreview.isOpen) closeGhostPreview();
  closeModal();
  workflowScreen.open(buildWorkflowPort());
  inputRouter.setModalOpen(true);
  applyChromeLayout();
  scheduleRender();
}

function toggleWorkflowScreen(): void {
  if (workflowScreen.isOpen) {
    workflowScreen.close();
    inputRouter.setModalOpen(inputConsumerActive());
    applyChromeLayout();
    scheduleRender();
    return;
  }
  openWorkflowScreen();
}

function buildGhostPreviewPort(): GhostPreviewPort {
  return {
    getIssue: (issueId) =>
      pollCoordinator.getGlobalIssues().find((i) => i.id === issueId) ?? null,

    getPreflight: (issueId) => {
      const issue = pollCoordinator.getGlobalIssues().find((i) => i.id === issueId);
      if (!issue) return null;
      const state = issueSessionStateFor(issue);
      const repoDir = resolveIssueRepoDir(issue, configStore.config, homedir());
      return buildPreflight({
        issueState: state?.state ?? "none",
        linkedSessionName: state?.sessionName,
        repoDir,
        sessionName: resolveIssueSessionName(issue),
        team: issue.team ?? null,
        settings: repoSettingsFor(repoDir),
        trackerPresent: !!adapters.issueTracker,
      });
    },

    onStart: (issueId) => startGhost(issueId),

    onOpenInBrowser: (issueId) => {
      adapters.issueTracker?.openInBrowser(issueId);
    },

    onChangeStatus: (issueId) => {
      const tracker = adapters.issueTracker;
      const issue = pollCoordinator.getGlobalIssues().find((i) => i.id === issueId);
      if (!tracker || !issue) return;
      tracker.getAvailableStatuses(issue.id).then((statuses) => {
        if (statuses.length === 0) return;
        // The request is async and the user is not frozen while it runs. If
        // they left, or moved to another issue, a picker opening now would
        // land over an unrelated screen and write to the wrong issue.
        if (!ghostPreview.isOpen || ghostPreview.getIssueId() !== issue.id) return;
        const listModal = new ListModal({
          items: statuses.map((s) => ({ id: s, label: s })),
          header: `${issue.identifier} — Update Status`,
        });
        listModal.open();
        openModal(listModal, (selected: unknown) => {
          const sel = selected as { id: string };
          if (!sel?.id) return;
          pollCoordinator.optimisticIssueStatus(issue.id, sel.id);
          tracker.updateStatus(issue.id, sel.id)
            .then(() => { pollCoordinator.refreshGlobalItem("issue", issue.id); })
            .catch((e) => {
              // The optimistic write already moved the row. Say so and pull the
              // true value back, rather than leaving a silent lie on screen.
              logError("jmux", `status update failed for ${issue.identifier}: ${(e as Error).message}`);
              showToast(`${issue.identifier} status update failed`);
              pollCoordinator.refreshGlobalItem("issue", issue.id);
            });
        });
      }).catch(() => { /* tracker unreachable; nothing to open */ });
    },
  };
}

/**
 * The session to unpark onto when a glass-opened preview closes.
 *
 * Non-null only when the preview was opened out of the Command Center. Glass
 * parks the interactive client on an internal session and `exitGlass()`
 * deliberately does not switch back — its contract puts that on the caller. A
 * ghost is not a session target, so the preview cannot hand off to
 * `leaveGlass()`; it takes ownership of the unpark instead and defers it until
 * the user actually leaves.
 */
let previewUnparkTarget: string | null = null;

/**
 * Open the preview on a ghost, taking over the main area.
 *
 * The identifier travels with the id because the preview caches it: once an
 * issue drops out of the global list there is no way to recover a human-
 * readable name for the "no longer available" state.
 */
function openGhostPreview(issue: { id: string; identifier: string }): void {
  // One full-screen surface at a time — two would leave one painted and deaf.
  if (settingsScreen.isOpen) settingsScreen.close();
  if (workflowScreen.isOpen) workflowScreen.close();
  closeModal();

  if (inGlass) {
    // Leave the client parked: the preview paints the whole main area, so the
    // parked session is invisible and unparking now would only make the tiles
    // flash. The debt is settled in closeGhostPreview.
    previewUnparkTarget = preGlassSessionId ?? currentSessionId;
    exitGlass();
  }

  // The rail marks the row whose content fills the main area.
  sidebar.setActiveSession("");
  sidebar.setOverviewActive(false);
  sidebar.setFocusedGhost(issue.id);
  sidebar.scrollToActive();

  ghostPreview.open(buildGhostPreviewPort(), issue);
  inputRouter.setModalOpen(true);
  applyChromeLayout();
  scheduleRender();
}

function closeGhostPreview(): void {
  if (!ghostPreview.isOpen) return;
  ghostPreview.close();
  sidebar.setFocusedGhost(null);

  const unpark = previewUnparkTarget;
  previewUnparkTarget = null;
  if (unpark) {
    // Opened out of glass, so the client is still parked on the internal
    // session and something has to put it back on real work.
    void switchSession(unpark);
  } else {
    applySessionRail();
  }

  inputRouter.setModalOpen(inputConsumerActive());
  applyChromeLayout();
  scheduleRender();
}

function handleGhostPreviewInput(data: string): void {
  const wasOpen = ghostPreview.isOpen;
  ghostPreview.handleInput(data);
  // Escape/q closes the screen directly, and a successful start closes it from
  // its own async continuation; both bypass closeGhostPreview, so the chrome
  // and routing are re-synced here the way handleWorkflowInput does it.
  if (wasOpen && !ghostPreview.isOpen) {
    sidebar.setFocusedGhost(null);
    const unpark = previewUnparkTarget;
    previewUnparkTarget = null;
    if (unpark) void switchSession(unpark);
    else applySessionRail();
    applyChromeLayout();
    inputRouter.setModalOpen(inputConsumerActive());
  }
  scheduleRender();
}

function handleWorkflowInput(data: string): void {
  const wasOpen = workflowScreen.isOpen;
  workflowScreen.handleInput(data);
  // The screen closes itself on Escape/q without going through the toggle, so
  // the chrome layout and input routing are re-synced here the same way
  // handleSettingsInput does it.
  if (wasOpen && !workflowScreen.isOpen) {
    applyChromeLayout();
    inputRouter.setModalOpen(inputConsumerActive());
  }
  scheduleRender();
}

/**
 * Whether *something* is currently claiming keyboard input from the pty.
 *
 * Every surface that takes input over has to be counted here. This has been
 * got wrong twice, both times the same way: a settings row closes settings in
 * order to hand off to another surface, and the close path then clears input
 * routing on the way out — leaving the new surface painted and deaf. Asking
 * one question with one answer is what stops the next surface repeating it.
 */
function inputConsumerActive(): boolean {
  return settingsScreen.isOpen || workflowScreen.isOpen || ghostPreview.isOpen
    || activeModal?.isOpen() === true;
}

function handleSettingsInput(data: string): void {
  const wasOpen = settingsScreen.isOpen;
  settingsScreen.handleInput(data);

  if (wasOpen && !settingsScreen.isOpen) {
    // Settings can close itself (Escape/q in navigation mode) without going
    // through toggleSettingsScreen(). Re-sync the chrome layout the same way
    // that path does, or the input router keeps classifying clicks against
    // the stale frameless layout until the next resize.
    applyChromeLayout();
    inputRouter.setModalOpen(inputConsumerActive());
  }

  scheduleRender();
}

function resolveIssueSessionName(issue: import("./adapters/types").Issue): string | null {
  const workflow = configStore.config.issueWorkflow;
  const repoDir = workflow?.teamRepoMap?.[issue.team ?? ""];
  if (!repoDir) return null;

  let branchName: string;
  if (issue.branchName) {
    branchName = issue.branchName;
  } else {
    const template = repoSettingsFor(repoDir.replace("~", homedir())).sessionNameTemplate;
    branchName = template
      .replace("{identifier}", issue.identifier.toLowerCase())
      .replace("{title}", issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));
  }
  return sanitizeTmuxSessionName(branchName);
}

/**
 * Provision (or return to) the session for an issue. Shared by the panel's `n`
 * key and the capture composer's "capture & start", so both go through exactly
 * one implementation of the three-state flow.
 */
async function startWorkOnIssue(
  issue: import("./adapters/types").Issue,
  issueState: "none" | "worktree" | "session",
  linkedSessionName: string | undefined,
): Promise<StartOutcome> {
      // STATE 3: a live session already exists for this issue (either via an
      // explicit L-key link or a workflow-derived name match). Switch to it.
      // Done before the workflow/repoDir check so explicit links work even
      // when the issue's team has no teamRepoMap entry.
      if (issueState === "session" && linkedSessionName) {
        if (!ptyClientName) await resolveClientName();
        if (!ptyClientName) return "failed";
        await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(linkedSessionName)}`);
        return "switched";
      }

      const workflow = configStore.config.issueWorkflow;
      const repoDir = workflow?.teamRepoMap?.[issue.team ?? ""];

      // Automated path: config maps this issue's team to a repo
      if (repoDir) {
        if (!ptyClientName) await resolveClientName();
        if (!ptyClientName) return "failed";

        const session = resolveIssueSessionName(issue);
        if (!session) return "failed";

        const expandedDir = repoDir.replace("~", homedir());
        // Settings resolve against the *issue's* repo, not the session the user
        // happens to be sitting in — the issue panel is a cross-repo union.
        const settings = repoSettingsFor(expandedDir);
        const baseBranch = settings.defaultBaseBranch;

        try {
          // Seed the first user message for Claude by writing the issue prompt
          // to a temp file — the main pane reads it via $(cat ...) and claude
          // takes its content as a positional argument (the documented
          // interactive-seed form). Without this the pane falls back to
          // `exec $SHELL` so the session is usable even if the agent is off.
          const shouldLaunchAgent = settings.autoLaunchAgent && !!adapters.issueTracker;
          let promptTmp: string | null = null;
          if (shouldLaunchAgent) {
            const prompt = adapters.issueTracker!.buildPrompt(issue);
            promptTmp = `/tmp/jmux-prompt-${Date.now()}.md`;
            writeFileSync(promptTmp, prompt);
          }
          // `exec $SHELL` tail keeps the pane alive if claude exits so the user
          // isn't ejected from the session. Use a double-quoted command sub so
          // `cat` reads the prompt verbatim without word-splitting.
          const claudeFragment = promptTmp
            ? `${settings.claudeCommand} "$(cat ${promptTmp})"; rm -f ${promptTmp}; exec $SHELL`
            : `exec $SHELL`;

          // STATE 2: Worktree exists but no session → launch claude directly
          if (issueState === "worktree") {
            const wtPath = `${expandedDir}/${session}`;
            await control.sendCommand(
              `new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(wtPath)} ${tq(claudeFragment)}`,
            );
            await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(session)}`);
            sessionState.addLink(session, { type: "issue", id: issue.id });
            void requestTransition(issue, "session-start");
            return "created";
          }

          // STATE 1: Nothing exists → create worktree + session. Every issue
          // gets a worktree; `wtmIntegration` picks the mechanism only, so
          // both paths land the same `<repo>/<session>` directory and the
          // session name doubles as the branch name (the one-name rule).
          const wtPath = `${expandedDir}/${session}`;
          // Main (left) pane runs claude — but first it has to wait for the
          // sibling setup pane to materialize the worktree directory. Tmux
          // wants a cwd that exists at split time, so we open the pane in
          // the repo root and have the shell cd into the worktree once
          // creation finishes.
          const mainCmd = `while [ ! -d ${tq(wtPath)} ]; do sleep 0.2; done; cd ${tq(wtPath)}; ${claudeFragment}`;
          await control.sendCommand(
            `new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(expandedDir)} ${tq(mainCmd)}`,
          );
          // Setup (right) pane creates the worktree and exits on success — no
          // trailing `exec $SHELL` so the pane auto-closes. On failure we drop
          // to a shell so the user can see the error (without this, the pane
          // would vanish and the main pane would wait forever for a worktree
          // that never gets created). `-d` keeps focus on claude; `-l 30%`
          // makes setup narrow and leaves claude with ~70%.
          const createCmd = buildWorktreeCommand({
            wtm: settings.wtmIntegration,
            session,
            baseBranch,
            noShell: true,
          });
          await control.sendCommand(
            `split-window -h -d -l 30% -t ${tq(session)} -c ${tq(expandedDir)} ${tq(`${createCmd} || exec $SHELL`)}`,
          );
          // The new worktree changes what git reports for these paths.
          repoFacts.clear();

          await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(session)}`);
          sessionState.addLink(session, { type: "issue", id: issue.id });
          void requestTransition(issue, "session-start");
          return "created";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const lines: StyledLine[] = [
            [],
            [{ text: `Failed to create session for ${issue.identifier}`, attrs: { fg: 1, fgMode: 1, bg: theme.surface, bgMode: 2 } }],
            [],
            [{ text: message, attrs: { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 } }],
            [],
            [{ text: "Press q or Esc to close.", attrs: { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 } }],
          ];
          const errorModal = new ContentModal({ lines, title: "Session Creation Failed" });
          errorModal.setTermRows(process.stdout.rows || 24);
          errorModal.open();
          openModal(errorModal, () => {});
        }
        // The catch swallowed the error into a modal, so the promise resolves
        // normally — callers can only tell this apart from success by the
        // outcome, which is why one is returned at all.
        return "failed";
      }

      // Fallback: no config mapping — open manual modal
      const initialDirs = cachedProjectDirs.length > 0 ? cachedProjectDirs : [homedir()];
      const modal = new NewSessionModal(getNewSessionProviders(initialDirs));
      modal.open();
      refreshProjectDirsInBackground((dirs) => {
        modal.updateProjectDirs(dirs);
        scheduleRender();
      });
      openModal(modal, async (value) => {
        const result = value as NewSessionResult;
        const parentClient = ptyClientName;
        if (!parentClient) return;
        try {
          switch (result.type) {
            case "standard": {
              const s = sanitizeTmuxSessionName(result.name);
              await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${s}`)} -s ${tq(s)} -c ${tq(result.dir)}`);
              await control.sendCommand(`switch-client -c ${parentClient} -t ${tq(s)}`);
              sessionState.addLink(s, { type: "issue", id: issue.id });
              break;
            }
            case "existing_worktree": {
              const s = sanitizeTmuxSessionName(result.branch);
              await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${s}`)} -s ${tq(s)} -c ${tq(result.path)}`);
              await control.sendCommand(`switch-client -c ${parentClient} -t ${tq(s)}`);
              sessionState.addLink(s, { type: "issue", id: issue.id });
              break;
            }
          }
        } catch (err) {
          showNewSessionError(result, err);
        }
      });
      // The picker is now up and the user drives from here — neither a success
      // nor a failure, and specifically not something to close a surface over.
      return "handed-off";
}

/**
 * The global issue list narrowed by a view's filter. Every panel read goes
 * through here so a named queue ("QA Failed") means the same thing whether it
 * is being rendered, navigated, or acted on.
 */
/** MR web URL → MR, the join an issue needs to show its own pipeline state. */
function mrsByUrl(): Map<string, import("./adapters/types").MergeRequest> {
  const map = new Map<string, import("./adapters/types").MergeRequest>();
  for (const mr of pollCoordinator.getGlobalMrs()) map.set(mr.webUrl, mr);
  return map;
}

function issuesForView(view: PanelView | undefined): import("./adapters/types").Issue[] {
  const all = pollCoordinator.getGlobalIssues();
  if (!view || view.source !== "issues") return all;
  const stages = derivedStages();
  const stageOf = (issue: { status: string }) =>
    stageForIssue(issue as import("./adapters/types").Issue, stages);
  // effectiveFilter drops `filter.states` for a sectioned view: sections are
  // the unit of classification, and ANDing the two silently hid issues a
  // section had claimed.
  return all.filter((issue) => matchesIssueFilter(issue, effectiveFilter(view), stageOf));
}

/**
 * Every issues queue's contents, in the order its own tab renders them.
 *
 * Ordering reuses buildViewNodes so "the top of the list" means exactly what the
 * panel shows — no second sort implementation to drift. Shared by `Ctrl-a u` and
 * the sidebar's ghost band so both agree on what "next" is.
 */
function orderedIssuesByView(): Map<string, import("./adapters/types").Issue[]> {
  const byView = new Map<string, import("./adapters/types").Issue[]>();
  const states = getIssueSessionStates();
  const mrs = mrsByUrl();
  for (const view of panelViews) {
    if (view.source !== "issues") continue;
    const items = transformIssues(issuesForView(view), new Set(), states, mrs);
    const issues = buildViewNodes(items, view, new Set())
      .filter((n) => n.kind === "item" && n.item.type === "issue")
      .map((n) => (n as Extract<ViewNode, { kind: "item" }>).item.raw as import("./adapters/types").Issue);
    byView.set(view.id, issues);
  }
  return byView;
}

/**
 * The next issue to pull, honouring the configured queue order.
 */
function upNextIssue(): { viewLabel: string; issue: import("./adapters/types").Issue } | null {
  const order = configStore.config.pipeline?.upNext ?? [];
  if (order.length === 0) return null;

  const picked = pickUpNext(order, orderedIssuesByView());
  if (!picked) return null;
  const view = panelViews.find((v) => v.id === picked.viewId);
  return { viewLabel: view?.label ?? picked.viewId, issue: picked.item };
}

/**
 * Turn a ghost row into a real session — the same three-state flow as `n` in the
 * issues panel, deliberately reusing `startWorkOnIssue` rather than duplicating
 * a "create a session for this issue" path that could drift from it.
 *
 * The state has to be looked up rather than assumed. A ghost is by construction
 * an issue with no live *session*, but it may well have a worktree already (an
 * abandoned attempt, or one made outside jmux); passing a hardcoded "none" would
 * send `startWorkOnIssue` down the create-a-worktree path on top of one that
 * exists.
 */
async function startGhost(issueId: string): Promise<StartOutcome> {
  const issue = pollCoordinator.getGlobalIssues().find((i) => i.id === issueId);
  if (!issue) return "gone";
  const state = issueSessionStateFor(issue);
  return startWorkOnIssue(issue, state?.state ?? "none", state?.sessionName);
}

/** Start (or switch to) whatever is at the top of the queue rotation. */
async function startUpNext(): Promise<void> {
  const next = upNextIssue();
  if (!next) return;
  const state = getIssueSessionStates().get(next.issue.id);
  await startWorkOnIssue(next.issue, state?.state ?? "none", state?.sessionName);
}

/**
 * Explicit issue→session links, keyed by issue id.
 *
 * An explicit link (set with the L key) wins over the workflow-derived name so
 * re-linking an issue to a different session is honoured. If several live
 * sessions claim the same issue, the current one wins.
 */
function explicitIssueLinks(): Map<string, string> {
  const currentName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
  const links = new Map<string, string>();
  for (const session of currentSessions) {
    for (const id of sessionState.getLinkedIssueIds(session.name)) {
      const existing = links.get(id);
      if (!existing || session.name === currentName) links.set(id, session.name);
    }
  }
  return links;
}

/**
 * Session state for a single issue.
 *
 * Split out of `getIssueSessionStates` because the ghost preview needs the
 * answer for exactly one issue, on every repaint. The map form walks every
 * global issue and `existsSync`es each candidate worktree path — fine once per
 * poll, a synchronous scan of the whole backlog per frame when pty output is
 * driving repaints.
 *
 * `links` is optional so the batch caller builds the reverse index once instead
 * of once per issue.
 */
function issueSessionStateFor(
  issue: import("./adapters/types").Issue,
  links?: Map<string, string>,
): IssueSessionInfo | undefined {
  const explicit = (links ?? explicitIssueLinks()).get(issue.id);
  if (explicit) return { state: "session", sessionName: explicit };

  const workflow = configStore.config.issueWorkflow;
  if (!workflow?.teamRepoMap) return undefined;
  const session = resolveIssueSessionName(issue);
  if (!session) return undefined;

  if (currentSessions.some((s) => s.name === session)) {
    return { state: "session", sessionName: session };
  }

  const repoDir = workflow.teamRepoMap[issue.team ?? ""];
  if (!repoDir) return undefined;
  const wtPath = `${repoDir.replace("~", homedir())}/${session}`;
  return existsSync(wtPath) ? { state: "worktree", sessionName: session } : undefined;
}

function getIssueSessionStates(): Map<string, IssueSessionInfo> {
  const states = new Map<string, IssueSessionInfo>();
  const links = explicitIssueLinks();
  for (const issue of pollCoordinator.getGlobalIssues()) {
    const info = issueSessionStateFor(issue, links);
    if (info) states.set(issue.id, info);
  }
  return states;
}

/**
 * Select an issue in the panel *if the panel is already showing an issues tab*.
 *
 * Deliberately passive: it never opens the panel, never switches tabs and never
 * takes keyboard focus. Capture exists so you don't lose your place, so it must
 * not yank you somewhere — but if the list is already on screen, leaving the
 * new issue unhighlighted would be its own small lie.
 */
function selectIssueInOpenPanel(issueId: string): void {
  if (!diffPanel.isActive()) return;
  const view = panelViews.find((v) => v.id === infoPanel.activeTab);
  if (!view || view.source !== "issues") return;
  const viewState = viewStates.get(view.id);
  if (!viewState) return;

  const rawItems = transformIssues(issuesForView(view), new Set(), getIssueSessionStates(), mrsByUrl());
  const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
  const index = nodes.findIndex(
    (n) => n.kind === "item" && n.item.type === "issue" && n.item.id === issueId,
  );
  if (index < 0) return;

  viewState.selectedIndex = index;
  viewState.detailScrollOffset = 0;
  const { listRows } = panelViewLayout(layout.ptyRows, viewState);
  if (index >= viewState.scrollOffset + listRows) {
    viewState.scrollOffset = index - listRows + 1;
  } else if (index < viewState.scrollOffset) {
    viewState.scrollOffset = index;
  }
}

function focusPanelOnSessionIssue(sessionName: string): void {
  // sessionState is authoritative for links and is synchronous, so it reflects
  // freshly-added links from onPanelCreateSession even before pollCoordinator
  // has had a chance to resolve a context for the new session.
  const linkedIssueIds = new Set(sessionState.getLinkedIssueIds(sessionName));
  if (linkedIssueIds.size === 0) {
    // No linked issues — clear selection in any issues view so the previous
    // session's issue doesn't stay highlighted.
    for (const view of panelViews) {
      if (view.source !== "issues") continue;
      const viewState = viewStates.get(view.id);
      if (viewState) {
        viewState.selectedIndex = -1;
        viewState.detailScrollOffset = 0;
      }
    }
    return;
  }

  // Find the issues view and locate the linked issue in it
  for (const view of panelViews) {
    if (view.source !== "issues") continue;
    const viewState = viewStates.get(view.id);
    if (!viewState) continue;

    const rawItems = transformIssues(issuesForView(view), linkedIssueIds, getIssueSessionStates(), mrsByUrl());
    const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.kind === "item" && node.item.type === "issue" && linkedIssueIds.has(node.item.id)) {
        viewState.selectedIndex = i;
        viewState.detailScrollOffset = 0;
        // Ensure visible
        const dpRows = layout.ptyRows;
        const { listRows } = panelViewLayout(dpRows, viewState);
        if (i >= viewState.scrollOffset + listRows) {
          viewState.scrollOffset = i - listRows + 1;
        } else if (i < viewState.scrollOffset) {
          viewState.scrollOffset = i;
        }
        // Switch to this view tab
        infoPanel.setActiveTab(view.id);
        inputRouter.setPanelTabsActive(true);
        return;
      }
    }
  }
}

function pickRepoForTeam(teamName: string): void {
  const dirs = cachedProjectDirs.length > 0 ? cachedProjectDirs : [homedir()];
  const dirItems = dirs.map((d) => ({ id: d, label: d.replace(homedir(), "~") }));
  const dirPicker = new ListModal({ items: dirItems, header: `Repository for ${teamName}` });
  dirPicker.open();
  openModal(dirPicker, (dirValue) => {
    const dirSel = dirValue as ListItem;
    configStore.setTeamRepo(teamName, dirSel.id);
  });
}

let viewSaveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedViewSave(view: PanelView): void {
  if (viewSaveTimer) clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(() => {
    viewSaveTimer = null;
    configStore.saveView(view);
  }, 500);
}

const projectDirsCachePath = resolve(homedir(), ".config", "jmux", "cache", "project-dirs.json");

// In-memory cache — populated from disk at startup, refreshed in background
let cachedProjectDirs: string[] = loadProjectDirsCache(projectDirsCachePath);
let projectDirsScanInFlight: Promise<string[]> | null = null;

async function scanProjectDirsAsync(): Promise<string[]> {
  let searchDirs: string[] = (configStore.config.projectDirs ?? []).map((d: string) => d.replace("~", homedir()));
  if (searchDirs.length === 0) {
    searchDirs = ["Code", "Projects", "src", "work", "dev"].map(d => resolve(homedir(), d));
  }
  searchDirs = searchDirs.filter(d => existsSync(d));
  if (searchDirs.length === 0) return [homedir()];
  const proc = Bun.spawn([
    "find", ...searchDirs, "-maxdepth", "4",
    "(", "-name", "node_modules", "-o", "-name", ".git", "-o", "-name", "vendor",
          "-o", "-name", ".cache", "-o", "-name", "target", ")",
    "-prune", "-name", ".git", "-print",
  ], {
    stdout: "pipe", stderr: "ignore",
  });
  const stdout = (await new Response(proc.stdout).text()).trim();
  if (!stdout) return [homedir()];
  const dirs = stdout.split("\n").map(p => p.replace(/\/\.git$/, "")).sort();
  return [homedir(), ...new Set(dirs)];
}

// Kick off a background scan, updating cache + disk + optionally the active modal.
// Returns immediately; the scan runs async. Multiple concurrent calls dedupe.
function refreshProjectDirsInBackground(onUpdate?: (dirs: string[]) => void): void {
  if (projectDirsScanInFlight) {
    // Already scanning — attach to existing scan
    if (onUpdate) {
      projectDirsScanInFlight.then((dirs) => onUpdate(dirs)).catch(() => {});
    }
    return;
  }
  projectDirsScanInFlight = scanProjectDirsAsync();
  projectDirsScanInFlight
    .then((dirs) => {
      cachedProjectDirs = dirs;
      saveProjectDirsCache(projectDirsCachePath, dirs);
      if (onUpdate) onUpdate(dirs);
    })
    .catch(() => {})
    .finally(() => {
      projectDirsScanInFlight = null;
    });
}

function getNewSessionProviders(preScannedDirs: string[]): NewSessionProviders {
  return {
    scanProjectDirs: () => preScannedDirs,
    isBareRepo: (dir) => {
      try {
        const result = Bun.spawnSync(["git", "--git-dir", `${dir}/.git`, "config", "--get", "core.bare"], {
          stdout: "pipe", stderr: "ignore",
        });
        return result.stdout.toString().trim() === "true";
      } catch { return false; }
    },
    getWorktrees: (dir) => {
      const result = Bun.spawnSync(["git", "--git-dir", `${dir}/.git`, "worktree", "list", "--porcelain"], {
        stdout: "pipe", stderr: "ignore",
      });
      const lines = result.stdout.toString().split("\n");
      const worktrees: Array<{ name: string; path: string }> = [];
      let currentPath = "";
      for (const line of lines) {
        if (line.startsWith("worktree ")) currentPath = line.slice(9);
        if (line.startsWith("branch refs/heads/")) {
          worktrees.push({ name: line.slice(18), path: currentPath });
        }
      }
      return worktrees;
    },
    getRemoteBranches: (dir) => {
      const result = Bun.spawnSync(["git", "--git-dir", `${dir}/.git`, "for-each-ref",
        "--format=%(refname:short)", "refs/remotes/origin/"], {
        stdout: "pipe", stderr: "ignore",
      });
      return result.stdout.toString().trim().split("\n")
        .map(b => b.replace("origin/", ""))
        .filter(b => b && b !== "HEAD")
        .sort();
    },
    getDefaultBranch: (dir) => {
      for (const b of ["main", "master", "develop"]) {
        const result = Bun.spawnSync(["git", "--git-dir", `${dir}/.git`, "rev-parse", "--verify", `refs/remotes/origin/${b}`], {
          stdout: "ignore", stderr: "ignore",
        });
        if (result.exitCode === 0) return b;
      }
      return "";
    },
  };
}

async function handlePaletteAction(result: PaletteResult): Promise<void> {
  const { commandId, sublistOptionId } = result;

  // Dynamic: switch to session. Route through leaveGlass so selecting a session
  // from the palette while the Command Center is up tears down the glass first —
  // otherwise the client switches but the render stays on the overview.
  if (commandId.startsWith("switch-session:")) {
    const sessionId = commandId.slice("switch-session:".length);
    await leaveGlass(sessionId);
    return;
  }

  // Dynamic: switch to window
  if (commandId.startsWith("switch-window:")) {
    const windowId = commandId.slice("switch-window:".length);
    await handleTabClick(windowId);
    return;
  }

  // Dynamic: toggle sidebar group (the suffix is the axis-namespaced collapse key)
  if (commandId.startsWith("toggle-group:")) {
    const key = commandId.slice("toggle-group:".length);
    sidebar.toggleGroup(key);
    scheduleRender();
    return;
  }

  // Pin/unpin session
  if (commandId === "pin-session" || commandId === "unpin-session") {
    const currentName = currentSessions.find(s => s.id === currentSessionId)?.name;
    if (currentName) {
      if (commandId === "pin-session") {
        pinnedSessions.add(currentName);
      } else {
        pinnedSessions.delete(currentName);
      }
      sidebar.setPinnedSessions(pinnedSessions);
      configStore.set("pinnedSessions", [...pinnedSessions]);
      scheduleRender();
    }
    return;
  }

  if (commandId === "toggle-park-session") {
    const currentName = currentSessions.find(s => s.id === currentSessionId)?.name;
    if (currentName) toggleParked(currentName);
    return;
  }

  if (commandId === "start-up-next") {
    await startUpNext();
    return;
  }

  if (commandId === "save-view-as-tab") {
    const view = panelViews.find((v) => v.id === infoPanel.activeTab);
    if (!view) return;
    const modal = new InputModal({
      header: "Save view as tab",
      subheader: "Name this queue",
      value: view.label,
    });
    modal.open();
    openModal(modal, async (value) => {
      const label = (value as string).trim();
      if (!label) return;
      // Configure-by-demonstration: the panel's own g/G//? cycling has already
      // shaped this view against real data, so saving is a rename + clone
      // rather than a form the user has to fill in blind.
      const id = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
      configStore.saveView({ ...view, id, label });
      panelViews = parseViews(configStore.config.panelViews);
      viewStates.set(id, createViewState());
      refreshPanelViews();
      // A saved view is a new stage as far as the sidebar is concerned, so the
      // stage band has to be re-derived against it.
      recomputeSessionBands();
      scheduleRender();
    });
    return;
  }

  // Pin the current session's active pane (or move the focused tile) to a
  // chosen/created tab. Writers only set/unset `@jmux-pinned`; the TUI reflects
  // it into Command Center live-mirror tiles — no pane is ever moved or broken.
  if (commandId === "pin-pane" || commandId === "move-tile") {
    const paneId = commandId === "pin-pane"
      ? glassRunner.run(["display-message", "-p", "-t", currentSessionId!, "#{pane_id}"]).lines[0]
      : (glassView?.focusedPaneId() ?? null);
    if (!paneId) return;
    const applyTab = (tabId: string) => {
      for (const cmd of buildPinCommands("pin", paneId, tabId)) glassRunner.run(cmd.args);
      if (commandId === "move-tile") switchCommandCenterTab(tabId); // follow the moved tile
      refreshPinnedPanes();
    };
    if (sublistOptionId === NEW_TAB_OPTION_ID) {
      openInputModalForNewTab((newTabId) => applyTab(newTabId));
    } else if (sublistOptionId) {
      applyTab(sublistOptionId);
    }
    return;
  }

  if (commandId === "unpin-pane" || commandId === "unpin-tile") {
    const paneId = commandId === "unpin-tile"
      ? (glassView?.focusedPaneId() ?? null)
      : glassRunner.run(["display-message", "-p", "-t", currentSessionId!, "#{pane_id}"]).lines[0];
    if (!paneId) return;
    for (const cmd of buildPinCommands("unpin", paneId)) glassRunner.run(cmd.args);
    refreshPinnedPanes();
    return;
  }

  if (commandId === "sidebar-group" && sublistOptionId) {
    applySidebarGroup(sublistOptionId as GroupMode);
    scheduleRender();
    return;
  }
  if (commandId === "sidebar-sort" && sublistOptionId) {
    applySidebarSort(sublistOptionId as SortMode);
    scheduleRender();
    return;
  }
  if (commandId === "sidebar-filter" && sublistOptionId) {
    sidebar.setFilterMode(sublistOptionId as FilterMode);
    scheduleRender();
    return;
  }

  if (commandId === "switch-cc-tab" && sublistOptionId) {
    if (!inGlass) { await enterGlass(); }
    switchCommandCenterTab(sublistOptionId);
    return;
  }

  if (commandId === "new-cc-tab") { openInputModalForNewTab((id) => switchCommandCenterTab(id)); return; }
  if (commandId === "rename-cc-tab") { openInputModalForRenameTab(); return; }
  if (commandId === "delete-cc-tab") { tryDeleteActiveTab(); return; }
  if (commandId === "move-tab-left" || commandId === "move-tab-right") {
    persistTabs(moveTab(commandCenterTabs, activeTabId, commandId === "move-tab-left" ? "left" : "right"));
    scheduleRender();
    return;
  }

  // Static commands — many reuse existing handlers
  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;

  switch (commandId) {
    case "new-issue": {
      openCreateIssueModal();
      return;
    }
    case "new-session": {
      // Open modal immediately with whatever is in the cache (could be empty
      // on a cold first start). Kick off a background rescan and update the
      // modal live when it completes.
      const initialDirs = cachedProjectDirs.length > 0
        ? cachedProjectDirs
        : [homedir()];
      const modal = new NewSessionModal(getNewSessionProviders(initialDirs));
      modal.open();
      refreshProjectDirsInBackground((dirs) => {
        modal.updateProjectDirs(dirs);
        scheduleRender();
      });
      openModal(modal, async (value) => {
        const result = value as NewSessionResult;
        const parentClient = ptyClientName;
        if (!parentClient) return;
        try {
          switch (result.type) {
            case "standard": {
              const session = sanitizeTmuxSessionName(result.name);
              await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(result.dir)}`);
              await control.sendCommand(`switch-client -c ${parentClient} -t ${tq(session)}`);
              break;
            }
            case "existing_worktree": {
              const session = sanitizeTmuxSessionName(result.branch);
              await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(result.path)}`);
              await control.sendCommand(`switch-client -c ${parentClient} -t ${tq(session)}`);
              break;
            }
            case "new_worktree": {
              // Use one sanitized name everywhere so the worktree directory,
              // the `wtm create` argument, and the tmux session all agree —
              // otherwise a user-typed name like `foo.bar` creates a `foo.bar`
              // directory but a `foo_bar` session, drifting the two apart.
              const session = sanitizeTmuxSessionName(result.name);
              const wtPath = `${result.dir}/${session}`;
              const createCmd = buildWorktreeCommand({
                wtm: repoSettingsFor(result.dir).wtmIntegration,
                session,
                baseBranch: result.baseBranch,
                noShell: true,
              });
              const cmd = `${createCmd}; cd ${session}; exec $SHELL`;
              await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(result.dir)} ${tq(cmd)}`);
              const waitCmd = `while [ ! -d ${tq(wtPath)} ]; do sleep 0.2; done; cd ${tq(wtPath)} && exec $SHELL`;
              await control.sendCommand(`split-window -h -d -t ${tq(session)} -c ${tq(result.dir)} ${tq(waitCmd)}`);
              await control.sendCommand(`switch-client -c ${parentClient} -t ${tq(session)}`);
              break;
            }
          }
          // When launched from the Command Center, drop the overview chrome now
          // that the client has switched onto the freshly created session.
          exitGlass();
        } catch (err) {
          showNewSessionError(result, err);
        }
      });
      return;
    }
    case "kill-session":
      await control.sendCommand(`kill-session -t ${tq(currentSessionId!)}`);
      return;
    case "rename-session": {
      const currentName = currentSessions.find(s => s.id === currentSessionId)?.name ?? "";
      const modal = new InputModal({
        header: "Rename Session",
        subheader: `Current: ${currentName}`,
        value: currentName,
      });
      modal.open();
      openModal(modal, async (name) => {
        await control.sendCommand(`rename-session -t ${tq(currentSessionId!)} ${tq(name as string)}`);
      });
      return;
    }
    case "new-window":
      await handleToolbarAction("new-window");
      return;
    case "rename-window": {
      const currentName = currentWindows.find(w => w.active)?.name ?? "";
      const modal = new InputModal({
        header: "Rename Window",
        subheader: `Current: ${currentName}`,
        value: currentName,
      });
      modal.open();
      openModal(modal, async (name) => {
        await control.sendCommand(`rename-window ${tq(name as string)}`);
        fetchWindows();
      });
      return;
    }
    case "close-window":
      await control.sendCommand("kill-window");
      fetchWindows();
      return;
    case "move-window": {
      const currentWindowName = currentWindows.find(w => w.active)?.name ?? "";
      const sessions = currentSessions
        .filter(s => s.id !== currentSessionId)
        .map(s => ({ id: s.id, label: s.name }));
      if (sessions.length === 0) return;
      const modal = new ListModal({
        header: "Move Window",
        subheader: `Moving: ${currentWindowName} \u2192 ?`,
        items: sessions,
      });
      modal.open();
      openModal(modal, async (value) => {
        const selected = value as ListItem;
        await control.sendCommand(`move-window -t ${tq(selected.label + ":")}`);
        fetchWindows();
      });
      return;
    }
    case "split-h":
      await handleToolbarAction("split-h");
      return;
    case "split-v":
      await handleToolbarAction("split-v");
      return;
    case "zoom-pane":
      await control.sendCommand("resize-pane -Z");
      fetchWindows();
      return;
    case "close-pane":
      await control.sendCommand("kill-pane");
      return;
    case "open-claude":
      await handleToolbarAction("claude");
      return;
    case "settings-screen":
      toggleSettingsScreen();
      return;
    case "setting-sidebar-width": {
      const modal = new InputModal({
        header: "Sidebar Width",
        subheader: `Current: ${sidebarWidth} (range: 10-60)`,
        value: String(sidebarWidth),
      });
      modal.open();
      openModal(modal, async (value) => {
        const newWidth = parseInt(value as string, 10);
        if (!isNaN(newWidth) && newWidth >= 10 && newWidth <= 60) {
          configStore.set("sidebarWidth", newWidth);
        }
      });
      return;
    }
    case "setting-panel-width": {
      const modal = new InputModal({
        header: "Panel Width",
        subheader: `Current: ${infoPanelWidth ?? "auto"} (range: 20-120, or "auto")`,
        value: infoPanelWidth !== null ? String(infoPanelWidth) : "auto",
      });
      modal.open();
      openModal(modal, async (value) => {
        const v = (value as string).trim();
        if (v === "auto" || v === "") {
          configStore.set("infoPanelWidth", undefined as any);
        } else {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 20 && n <= 120) {
            configStore.set("infoPanelWidth", n);
          }
        }
      });
      return;
    }
    case "setting-wtm": {
      configStore.setRepoDefault("wtmIntegration", !repoDefaultsView().wtmIntegration);
      return;
    }
    case "setting-claude-command": {
      const modal = new InputModal({
        header: "Claude Command",
        subheader: "Command to launch Claude Code from toolbar (global default)",
        value: repoDefaultsView().claudeCommand,
      });
      modal.open();
      openModal(modal, async (value) => {
        configStore.setRepoDefault("claudeCommand", value as string);
      });
      return;
    }
    case "setting-edit-workflow": {
      openWorkflowScreen();
      return;
    }
    case "setting-open-screen": {
      toggleSettingsScreen();
      return;
    }
    case "setting-project-dirs": {
      let dirs = configStore.config.projectDirs ?? [];
      if (dirs.length === 0) dirs = ["~/Code", "~/Projects", "~/src", "~/work", "~/dev"];
      const modal = new InputModal({
        header: "Project Directories",
        subheader: "Comma-separated list of directories to search",
        value: dirs.join(", "),
      });
      modal.open();
      openModal(modal, async (value) => {
        const newDirs = (value as string).split(",").map(s => s.trim()).filter(Boolean);
        configStore.set("projectDirs", newDirs);
      });
      return;
    }
    case "setting-cache-timers": {
      const current = configStore.config.cacheTimers !== false;
      configStore.set("cacheTimers", !current);
      return;
    }
    case "setting-running-color":
    case "setting-waiting-color":
    case "setting-complete-color": {
      const state: AgentState =
        commandId === "setting-running-color" ? "running"
        : commandId === "setting-waiting-color" ? "waiting"
        : "complete";
      const modal = new ListModal({
        header: `${state.charAt(0).toUpperCase()}${state.slice(1)} State Color`,
        subheader: `Current: ${currentStateColorName(state)}`,
        items: STATE_COLOR_NAMES.map((name) => ({ id: name, label: name })),
      });
      modal.open();
      openModal(modal, async (value) => {
        persistStateColor(state, (value as ListItem).id);
      });
      return;
    }
    case "setting-code-host": {
      const options = [
        { id: "gitlab", label: "GitLab" },
        { id: "github", label: "GitHub" },
        { id: "none", label: "None (disable)" },
      ];
      const current = configStore.config.adapters?.codeHost?.type ?? "none";
      const modal = new ListModal({
        header: "Code Host",
        subheader: `Current: ${current}`,
        items: options,
      });
      modal.open();
      openModal(modal, async (value) => {
        const selected = value as ListItem;
        configStore.setAdapter("codeHost", selected.id === "none" ? null : { type: selected.id });
      });
      return;
    }
    case "setting-issue-tracker": {
      const options = [
        { id: "linear", label: "Linear" },
        { id: "github", label: "GitHub Issues" },
        { id: "none", label: "None (disable)" },
      ];
      const current = configStore.config.adapters?.issueTracker?.type ?? "none";
      const modal = new ListModal({
        header: "Issue Tracker",
        subheader: `Current: ${current}`,
        items: options,
      });
      modal.open();
      openModal(modal, async (value) => {
        const selected = value as ListItem;
        configStore.setAdapter("issueTracker", selected.id === "none" ? null : { type: selected.id });
      });
      return;
    }
    case "setting-default-branch": {
      const modal = new InputModal({
        header: "Default Base Branch",
        subheader: "Branch to create worktrees from (global default)",
        value: repoDefaultsView().defaultBaseBranch,
      });
      modal.open();
      openModal(modal, async (value) => {
        configStore.setRepoDefault("defaultBaseBranch", value as string);
      });
      return;
    }
    case "setting-team-repo-map": {
      const current = configStore.config.issueWorkflow?.teamRepoMap ?? {};
      const entries = Object.entries(current);
      const items: Array<{ id: string; label: string }> = entries.map(([team, repo]) => ({
        id: `edit:${team}`,
        label: `${team} → ${repo}`,
      }));
      items.push({ id: "add", label: "➕ Add new mapping" });
      const modal = new ListModal({ items, header: "Team → Repo Mappings" });
      modal.open();
      openModal(modal, async (value) => {
        const sel = value as ListItem;
        if (sel.id === "add") {
          // Step 2: pick team from Linear
          let teamItems: Array<{ id: string; label: string }> = [];
          if (adapters.issueTracker?.authState === "ok") {
            try {
              const teams = await adapters.issueTracker.getTeams();
              teamItems = teams.map((t) => ({ id: t.name, label: t.name }));
            } catch {}
          }
          if (teamItems.length === 0) {
            // Fallback: manual team name input
            const teamModal = new InputModal({ header: "Team Name", subheader: "Enter the Linear team name", value: "" });
            teamModal.open();
            openModal(teamModal, (teamName) => {
              pickRepoForTeam(teamName as string);
            });
            return;
          }
          const teamPicker = new ListModal({ items: teamItems, header: "Select Team" });
          teamPicker.open();
          openModal(teamPicker, (teamValue) => {
            const teamSel = teamValue as ListItem;
            pickRepoForTeam(teamSel.label);
          });
        } else if (sel.id.startsWith("edit:")) {
          const teamName = sel.id.slice(5);
          const editItems = [
            { id: "change", label: "Change repository path" },
            { id: "remove", label: "Remove mapping" },
          ];
          const editModal = new ListModal({ items: editItems, header: `${teamName} mapping` });
          editModal.open();
          openModal(editModal, async (editValue) => {
            const editSel = editValue as ListItem;
            if (editSel.id === "remove") {
              configStore.setTeamRepo(teamName, null);
            } else {
              pickRepoForTeam(teamName);
            }
          });
        }
      });
      return;
    }
    case "setting-session-template": {
      const modal = new InputModal({
        header: "Session Name Template",
        subheader: "Variables: {identifier}, {title} (global default)",
        value: repoDefaultsView().sessionNameTemplate,
      });
      modal.open();
      openModal(modal, async (value) => {
        configStore.setRepoDefault("sessionNameTemplate", value as string);
      });
      return;
    }
    case "setting-auto-agent": {
      configStore.setRepoDefault("autoLaunchAgent", !repoDefaultsView().autoLaunchAgent);
      return;
    }
    case "link-issue": {
      if (!adapters.issueTracker) return;
      const modal = new InputModal({
        header: "Link Issue",
        subheader: "Search by identifier or title",
        value: "",
      });
      modal.open();
      openModal(modal, async (query) => {
        const results = await adapters.issueTracker!.searchIssues(query as string);
        if (results.length === 0) return;
        const items = results.map((i) => ({ id: i.id, label: `${i.identifier} ${i.title}` }));
        const picker = new ListModal({ items, header: "Select Issue" });
        picker.open();
        openModal(picker, (selected) => {
          const sel = selected as { id: string };
          const issue = results.find((i) => i.id === sel.id);
          if (issue) {
            const sName = currentSessions.find((s) => s.id === currentSessionId)?.name;
            if (sName) {
              sessionState.addLink(sName, { type: "issue", id: issue.id });
              pollCoordinator.addLinkedIssue(sName, issue);
            }
          }
        });
      });
      return;
    }
    case "unlink-issue": {
      const sName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const manualIssues = sessionState.getLinks(sName).filter((l) => l.type === "issue");
      if (manualIssues.length === 0) return;
      const ctx = pollCoordinator.getContext(sName);
      const items = manualIssues.map((l) => {
        const issue = ctx?.issues.find((i) => i.id === l.id);
        return { id: l.id, label: issue ? `${issue.identifier} ${issue.title}` : l.id };
      });
      const modal = new ListModal({ items, header: "Unlink Issue" });
      modal.open();
      openModal(modal, (selected) => {
        const sel = selected as { id: string };
        sessionState.removeLink(sName, { type: "issue", id: sel.id });
        pollCoordinator.removeLinkedIssue(sName, sel.id);
      });
      return;
    }
    case "link-mr": {
      if (!adapters.codeHost) return;
      const modal = new InputModal({
        header: "Link MR",
        subheader: "Search by title",
        value: "",
      });
      modal.open();
      openModal(modal, async (query) => {
        const results = await adapters.codeHost!.searchMergeRequests(query as string);
        if (results.length === 0) return;
        const items = results.map((mr) => ({ id: mr.id, label: `!${mr.id.split(":")[1]} ${mr.title}` }));
        const picker = new ListModal({ items, header: "Select MR" });
        picker.open();
        openModal(picker, (selected) => {
          const sel = selected as { id: string };
          const sName = currentSessions.find((s) => s.id === currentSessionId)?.name;
          if (sName) {
            const mr = results.find((m) => m.id === sel.id);
            if (!mr) return;
            sessionState.addLink(sName, { type: "mr", id: mr.id });
            pollCoordinator.addLinkedMr(sName, mr);
          }
        });
      });
      return;
    }
    case "unlink-mr": {
      const sName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const manualMrs = sessionState.getLinks(sName).filter((l) => l.type === "mr");
      if (manualMrs.length === 0) return;
      const ctx = pollCoordinator.getContext(sName);
      const items = manualMrs.map((l) => {
        const mr = ctx?.mrs.find((m) => m.id === l.id);
        return { id: l.id, label: mr ? `!${l.id.split(":")[1]} ${mr.title}` : l.id };
      });
      const modal = new ListModal({ items, header: "Unlink MR" });
      modal.open();
      openModal(modal, (selected) => {
        const sel = selected as { id: string };
        sessionState.removeLink(sName, { type: "mr", id: sel.id });
        pollCoordinator.removeLinkedMr(sName, sel.id);
      });
      return;
    }
    case "diff-toggle":
      await toggleDiffPanel();
      return;
    case "diff-zoom":
      await zoomDiffPanel();
      return;
  }
}

// --- Toolbar actions ---

async function handleToolbarAction(id: string): Promise<void> {
  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;

  // Window/pane operations go through the control connection so events fire reliably
  switch (id) {
    case "new-window":
      await control.sendCommand(`new-window -t ${ptyClientName} -c '#{pane_current_path}'`);
      fetchWindows();
      return;
    case "split-v":
      await control.sendCommand(`split-window -t ${ptyClientName} -h -c '#{pane_current_path}'`);
      return;
    case "split-h":
      await control.sendCommand(`split-window -t ${ptyClientName} -v -c '#{pane_current_path}'`);
      return;
    case "diff":
    case "panel":
      await toggleDiffPanel();
      return;
    case "claude":
      await control.sendCommand(`split-window -t ${ptyClientName} -h -c '#{pane_current_path}' ${currentRepoSettings().claudeCommand}`);
      return;
    case "settings": {
      const settingsCommands = buildPaletteCommands().filter(c => c.category === "setting");
      palette.open(settingsCommands);
      openModal(palette, (value) => {
        handlePaletteAction(value as PaletteResult);
      });
      return;
    }
  }

}

// --- PTY output pipeline ---

let writesPending = 0;

// OSC 52 clipboard passthrough — buffers across split chunks
const OSC52_START = "\x1b]52;";
let osc52Pending = "";

function forwardOsc52(data: string): void {
  let search = osc52Pending ? osc52Pending + data : data;
  osc52Pending = "";

  let pos = 0;
  while (pos < search.length) {
    const start = search.indexOf(OSC52_START, pos);
    if (start < 0) break;

    // Find terminator: BEL (\x07) or ST (\x1b\\)
    let end = -1;
    let endLen = 0;
    for (let i = start + OSC52_START.length; i < search.length; i++) {
      if (search[i] === "\x07") {
        end = i;
        endLen = 1;
        break;
      }
      if (search[i] === "\x1b" && i + 1 < search.length && search[i + 1] === "\\") {
        end = i;
        endLen = 2;
        break;
      }
    }

    if (end >= 0) {
      process.stdout.write(search.slice(start, end + endLen));
      pos = end + endLen;
    } else {
      // Incomplete — buffer for next chunk (cap at 512KB to avoid leaks)
      const remainder = search.slice(start);
      if (remainder.length < 512 * 1024) {
        osc52Pending = remainder;
      }
      return;
    }
  }
}

pty.onData((data: string) => {
  forwardOsc52(data);

  writesPending++;
  bridge.write(data).then(() => {
    writesPending--;
    if (writesPending === 0) {
      scheduleRender();
    }
  });
});

// --- Stdin ---

// stdin was wired to `stdinGate` right after the OSC 11 query was sent (near the
// top of startup), so the terminal-background reply couldn't be dropped during
// boot. The input pipeline (InputRouter, scheduleRender) is now live, so open the
// gate: any keystrokes buffered during boot flush to the router, further input
// flows straight through, and a themed frame is painted.
stdinReady = true;
stdinGate.markReady();
scheduleRender();

// Re-query the terminal background periodically so a live theme switch (e.g.
// toggling the terminal's light/dark theme without restarting jmux) is picked
// up. The reply is peeled off by the gate and only re-themes when the color
// actually changes (see onBackground's dedupe), so a steady theme costs a tiny
// query every few seconds and nothing more. Torn down in cleanupSync().
const THEME_REQUERY_INTERVAL_MS = 2000;
themeRequeryInterval = setInterval(() => {
  stdinGate.rearm();
  process.stdout.write(OSC11_QUERY);
}, THEME_REQUERY_INTERVAL_MS);

// --- Resize ---

process.on("SIGWINCH", () => {
  if (activeModal) {
    closeModal();
  }
  // A terminal resize invalidates the geometry the drag was hit-tested
  // against — the handle may not exist at the new size — so drop the drag
  // and any live resize it had queued.
  clearPendingDragResize();
  inputRouter.cancelDrag();
  relayout();
  if (inGlass) resizeGlass();
  maybeReprobeCellSize();
});

// --- Config file watcher ---

let configWatcher: ReturnType<typeof import("fs").watch> | null = null;
try {
  const { watch } = await import("fs");
  configWatcher = watch(configStore.configPath, () => {
    const updated = configStore.reload();
    const newWidth = updated.sidebarWidth || 26;
    // No claudeCommand to refresh here: it is resolved per repo at each use
    // site, so an external config edit takes effect on the next resolution.
    const newCacheTimers = updated.cacheTimers !== false;
    if (newCacheTimers !== cacheTimersEnabled) {
      cacheTimersEnabled = newCacheTimers;
      sidebar.cacheTimersEnabled = newCacheTimers;
      if (newCacheTimers && otelReceiver.getActiveSessionIds().length > 0) {
        startCacheTimerTick();
      } else if (!newCacheTimers) {
        stopCacheTimerTick();
      }
      scheduleRender();
    }

    const newPinned = new Set<string>(updated.pinnedSessions ?? []);
    if (newPinned.size !== pinnedSessions.size || [...newPinned].some(n => !pinnedSessions.has(n))) {
      pinnedSessions = newPinned;
      sidebar.setPinnedSessions(pinnedSessions);
      scheduleRender();
    }

    // Hot-apply screen-signature detection: both the table and the on/off
    // switch, so adding a signature takes effect without a restart.
    screenSignatures = [
      ...compileSignatures(updated.agentScreenSignatures),
      ...compileSignatures(BUILTIN_SIGNATURES),
    ];
    if (updated.agentScreenDetection === true) startScreenScan();
    else stopScreenScan();

    // Hot-apply the inline-image switch. `maxRows` needs nothing here — the
    // port reads it live — but turning the feature off has to take the plane
    // down, which is the one thing a live read can't do.
    applyImageSupport();

    // Hot-apply agent-state indicator colors to sidebar + Command Center.
    const newStateColors = resolveStateColors(updated.stateColors);
    sidebar.setStateColors(newStateColors);
    glassView?.setStateColors(newStateColors);
    scheduleRender();

    // Reload the Command Center tab registry (palette CRUD + hand-edits land here).
    {
      const before = stripVisibleFor(commandCenterTabs);
      commandCenterTabs = normalizeTabs(updated.commandCenterTabs);
      const clamped = clampTabSelection(commandCenterTabs, activeTabId, lastActiveTabId);
      activeTabId = clamped.activeTabId;
      lastActiveTabId = clamped.lastActiveTabId;
      if (inGlass) {
        refreshPinnedPanes();         // re-fold vanished tab ids; rebuild specs + summary
        glassView?.setActiveTab(activeTabId);
      }
      const after = stripVisibleFor(commandCenterTabs);
      if (before !== after) { resizeGlass(); }  // strip appeared/disappeared → glass height changed
      scheduleRender();
    }

    const needsResize = newWidth !== sidebarWidth;

    if (needsResize) {
      sidebarWidth = newWidth;
      relayout();
    }

    infoPanelSplitRatio = updated.infoPanelSplitRatio ?? DEFAULT_PANEL_SPLIT_RATIO;

    // Hot-apply diff panel config changes
    const prevPanelWidth = infoPanelWidth;
    infoPanelWidth = updated.infoPanelWidth ?? null;
    diffPanelSplitRatio = updated.diffPanel?.splitRatio ?? 0.4;
    hunkCommand = updated.diffPanel?.hunkCommand ?? "hunk";

    if (prevPanelWidth !== infoPanelWidth && diffPanel.state === "split") {
      relayout();
    }
  });
} catch {
  // Config file may not exist yet — watcher will fail silently
}

// --- Update check ---

async function checkForUpdates(): Promise<void> {
  try {
    const resp = await fetch(
      "https://api.github.com/repos/jarredkenny/jmux/releases/latest",
      { headers: { "Accept": "application/vnd.github.v3+json" } },
    );
    if (!resp.ok) return;
    const data = await resp.json() as { tag_name?: string };
    const latest = data.tag_name?.replace(/^v/, "");
    if (latest && latest !== VERSION) {
      sidebar.setVersion(VERSION, latest);
      scheduleRender();
    }
  } catch {
    // Offline or rate-limited — no problem
  }
}

async function showVersionInfo(): Promise<void> {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/jarredkenny/jmux/releases?per_page=10`,
      { headers: { Accept: "application/vnd.github.v3+json" } },
    );
    if (!resp.ok) return;
    const releases = await resp.json() as Array<{
      tag_name: string; name?: string; published_at?: string; body?: string;
    }>;

    const currentTag = `v${VERSION}`;
    const lines: StyledLine[] = [[]];

    // An update indicator with no way to act on it is a dead end, and the right
    // command differs per channel — brew, the installer, and npm each want
    // something different. Detection is channel.ts's job; this only renders it.
    const latestTag = releases[0]?.tag_name;
    if (latestTag && latestTag !== currentTag) {
      lines.push([
        { text: "Update available — run ", attrs: { ...neutralFg(8), bg: theme.surface, bgMode: 2 } },
        { text: upgradeCommand(currentChannel()), attrs: { fg: 2, fgMode: 1, bold: true, bg: theme.surface, bgMode: 2 } },
      ]);
      lines.push([]);
    }

    // Match ContentModal.preferredWidth() then subtract its 2-col padding each side.
    const termCols = process.stdout.columns || 80;
    const modalWidth = Math.min(Math.max(50, Math.round(termCols * 0.7)), 90);
    const contentWidth = Math.max(20, modalWidth - 4);

    for (const r of releases) {
      const tag = r.tag_name;
      const date = (r.published_at || "").split("T")[0];
      const name = r.name || tag;
      const isCurrent = tag === currentTag;

      if (isCurrent) {
        lines.push([
          { text: name, attrs: { fg: 2, fgMode: 1, bold: true, bg: theme.surface, bgMode: 2 } },
          { text: "  \u2190 current", attrs: { fg: 2, fgMode: 1, bg: theme.surface, bgMode: 2 } },
        ]);
      } else {
        lines.push([{ text: name, attrs: { bold: true, bg: theme.surface, bgMode: 2 } }]);
      }
      lines.push([{ text: date, attrs: { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 } }]);
      lines.push([]);

      const body = (r.body || "").trim();
      if (body) {
        const rendered = renderMarkdownToStyledLines(body, contentWidth, {
          baseAttrs: { bg: theme.surface, bgMode: 2 },
        });
        for (const line of rendered) {
          lines.push(line);
        }
        lines.push([]);
      }
      lines.push([{ text: "\u2500".repeat(40), attrs: { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 } }]);
      lines.push([]);
    }
    lines.push([{ text: "github.com/jarredkenny/jmux/releases", attrs: { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 } }]);

    const modal = new ContentModal({ lines, title: "jmux changelog" });
    modal.setTermRows(process.stdout.rows || 24);
    modal.open();
    openModal(modal, () => {});
  } catch {
    // Network error — silently fail
  }
}

// Check for updates in the background (non-blocking)
checkForUpdates();

// Warm the project-dirs cache in the background so Ctrl-a+n is instant
refreshProjectDirsInBackground();

// --- Control mode events ---

control.onEvent((event: ControlEvent) => {
  switch (event.type) {
    case "sessions-changed":
      if (!startupComplete) return;
      fetchSessions();
      fetchWindows();
      break;
    case "session-renamed": {
      if (!startupComplete) return;
      // tmux sends: %session-renamed $session_id new_name
      const parts = event.args.split(" ");
      if (parts.length >= 2) {
        const sessionId = parts[0];
        const newName = parts.slice(1).join(" ");
        const oldName = currentSessions.find((s) => s.id === sessionId)?.name;
        if (oldName && oldName !== newName) {
          sessionState.renameSession(oldName, newName);
          if (pinnedSessions.has(oldName)) {
            pinnedSessions.delete(oldName);
            pinnedSessions.add(newName);
            sidebar.setPinnedSessions(pinnedSessions);
            configStore.set("pinnedSessions", [...pinnedSessions]);
          }
        }
      }
      fetchSessions();
      fetchWindows();
      break;
    }
    case "session-changed":
      // This fires for the CONTROL client — ignore during startup since
      // the control client may be on a different session than the PTY client
      if (!startupComplete) break;
      break;
    case "client-session-changed":
      // This fires when the PTY client switches sessions — authoritative
      resolveClientName().then(async () => {
        applySessionRail();
        if (startupComplete) {
          await syncControlClient();
          fetchWindows();
          if (diffPanel.isActive() && !diffPanel.hunkExited) {
            const dpCols = getDiffPanelCols();
            const dpRows = layout.ptyRows;
            await spawnHunk(dpCols, dpRows);
          }
          // Sync issue panel and snapshotter to the new session's linked issue
          const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name;
          if (sessionName) {
            snapshotter?.onFocused(sessionName);
            await pollCoordinator.setActiveSession(sessionName);
            focusPanelOnSessionIssue(sessionName);
          }
        }
        renderFrame();
      });
      break;
    case "window-close":
      if (startupComplete) {
        fetchWindows();
        // A closed window may have hosted a pinned or auto-detected pane (e.g. the
        // user exited a Claude agent). Reconcile Command Center membership so the
        // dead pane's tile is torn down rather than left drifting onto a surviving
        // sibling window. When the last tile goes, the glass shows its empty state.
        if (inGlass || pinnedTracker.size > 0 || autoPinAgentPanes) refreshPinnedPanes();
      }
      break;
    case "window-add":
    case "window-renamed":
    case "session-window-changed":
      if (startupComplete) fetchWindows();
      break;
    case "subscription-changed":
      if (!startupComplete) break;
      if (event.name === "agent-state" || event.name === "agent-state-since") {
        void fetchAgentState();
      } else if (event.name === "windows") {
        fetchWindows();
      } else if (event.name === "pinned-panes") {
        refreshPinnedPanes();
      }
      break;
  }
});

// --- Git branch lookup ---

async function lookupSessionDetails(sessions: SessionInfo[]): Promise<void> {
  const home = process.env.HOME || "";
  for (const session of sessions) {
    try {
      const lines = await control.sendCommand(
        `display-message -t '${session.id}' -p '#{pane_current_path}'`,
      );
      const cwd = (lines[0] || "").trim();
      if (!cwd) continue;
      const directory = cwd.startsWith(home)
        ? "~" + cwd.slice(home.length)
        : cwd;
      const branch = await $`git -C ${cwd} branch --show-current`
        .text()
        .catch(() => "");
      const gitBranch = branch.trim() || undefined;

      // Detect wtm worktree — .git is a file pointing to a bare repo
      let project: string | undefined;
      try {
        const commonDir = await $`git -C ${cwd} rev-parse --git-common-dir`
          .text()
          .catch(() => "");
        const gitDir = await $`git -C ${cwd} rev-parse --git-dir`
          .text()
          .catch(() => "");
        if (commonDir.trim() && gitDir.trim() && commonDir.trim() !== gitDir.trim()) {
          // In a worktree — commonDir points to the bare repo's .git
          // Bare repo structure: /path/to/project/.git → project name is parent dir basename
          const resolved = resolve(cwd, commonDir.trim());
          const bareRoot = dirname(resolved);
          project = bareRoot.split("/").pop();
        }
      } catch {
        // Not a worktree
      }

      // Write to persistent cache
      sessionDetailsCache.set(session.id, { directory, path: cwd, gitBranch, project });
      session.directory = directory;
      session.gitBranch = gitBranch;
      session.project = project;
    } catch {
      // Session may not exist or no git repo
    }
  }
  // Rebuild currentSessions with cached data
  currentSessions = currentSessions.map((s) => {
    const cached = sessionDetailsCache.get(s.id);
    return cached ? { ...s, ...cached } : s;
  });
  sidebar.updateSessions(currentSessions);
  // Paths are known only now, so this is where sessions that existed at
  // startup first become resolvable.
  registerSessionsWithPoller(currentSessions);
  renderFrame();
}

// --- Window tabs ---

async function fetchWindows(): Promise<void> {
  try {
    const target = currentSessionId ? `-t '${currentSessionId}'` : "";
    const lines = await control.sendCommand(
      `list-windows ${target} -F '#{window_id}:#{window_index}:#{window_name}:#{window_active}:#{window_bell_flag}:#{window_zoomed_flag}'`,
    );
    const windows: import("./types").WindowTab[] = lines
      .filter((l) => l.length > 0)
      .map((line) => {
        const [windowId, index, name, active, bell, zoomed] = line.split(":");
        return {
          windowId,
          index: parseInt(index, 10),
          name,
          active: active === "1",
          bell: bell === "1",
          zoomed: zoomed === "1",
        };
      });

    if (windowBranchesEnabled) {
      // Resolve each window's cwd serially — concurrent control-mode commands
      // can interleave replies — then resolve branches concurrently, since the
      // git lookups are independent and run as non-blocking async subprocesses.
      const cwdByWindow = new Map<string, string>();
      for (const win of windows) {
        try {
          const cwdLines = await control.sendCommand(
            `display-message -t ${win.windowId} -p '#{pane_current_path}'`,
          );
          const cwd = cwdLines.find((l) => l.length > 0);
          if (cwd) cwdByWindow.set(win.windowId, cwd);
        } catch {
          // pane gone / session shutting down
        }
      }
      await Promise.all(
        windows.map(async (win) => {
          const cwd = cwdByWindow.get(win.windowId);
          if (!cwd) return;
          const branch = await gitBranchForPath(cwd);
          if (branch) win.branch = branch;
        }),
      );
    }

    currentWindows = windows;
    scheduleRender();
  } catch {
    // Session may be shutting down
  }
}

/**
 * Resolve the current git branch for a directory via a non-blocking subprocess.
 * Returns null when the path isn't a git work tree (or git isn't available).
 */
async function gitBranchForPath(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, "branch", "--show-current"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return null;
    const branch = out.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Agent state is read per *pane*, not per session, so two agents split into one
 * session don't clobber each other. A pane-context read of `@jmux-agent-state`
 * falls back to the session option when the pane has none of its own, which is
 * what keeps session-scoped writers (an un-migrated agent integration, or the
 * snapshot restore path) working unchanged — see AgentStateTracker's note.
 */
const AGENT_STATE_FORMAT = [
  "#{pane_id}",
  "#{session_id}",
  "#{@jmux-agent-state}",
  "#{@jmux-agent-state-since}",
].join(US);

async function fetchAgentState(): Promise<void> {
  const result = await control.sendCommand(
    `list-panes -a -f "${INTERNAL_SESSION_FILTER}" -F '${AGENT_STATE_FORMAT}'`,
  );
  const activePaneIds: string[] = [];
  for (const line of result) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [paneId, sessionId, rawState, rawSince] = splitFields(trimmed);
    if (!paneId || !sessionId) continue;
    activePaneIds.push(paneId);
    agentStateTracker.apply(paneId, sessionId, rawState || null, rawSince || null);
  }
  agentStateTracker.pruneExcept(activePaneIds);
}

/**
 * Screen-signature tier. Panes running an agent jmux has no integration for
 * report nothing at all; this reads their visible text and writes the same tmux
 * options a hook would, so everything downstream — tracker, rollup, sidebar,
 * Command Center — is unchanged and unaware.
 *
 * `@jmux-agent-source screen` records the provenance so a derived state is
 * distinguishable from one an agent actually reported.
 */
const SCREEN_SCAN_FORMAT = [
  "#{pane_id}",
  "#{pane_current_command}",
  "#{@jmux-agent-kind}",
  "#{@jmux-agent-state}",
  "#{@jmux-agent-source}",
].join(US);

// Compiled separately rather than spread into one literal: the config value is
// hand-edited JSON, and spreading a non-iterable like `{}` throws before
// compileSignatures could sanitise it — at module scope, that is a boot failure.
// User entries come first so they win for the same command.
let screenSignatures = [
  ...compileSignatures(configStore.config.agentScreenSignatures),
  ...compileSignatures(BUILTIN_SIGNATURES),
];
let screenScanInterval: ReturnType<typeof setInterval> | null = null;
let screenScanInFlight = false;

/**
 * Retract a screen-derived state. Only ever called for panes whose
 * `@jmux-agent-source` is `screen`, so this can never erase a state an agent
 * reported about itself.
 */
async function clearScreenState(paneId: string): Promise<void> {
  await control
    .sendCommand(
      `set-option -pu -t ${tq(paneId)} @jmux-agent-state ; ` +
        `set-option -pu -t ${tq(paneId)} @jmux-agent-state-since ; ` +
        `set-option -pu -t ${tq(paneId)} @jmux-agent-source`,
    )
    .catch(() => {});
}

async function scanAgentScreens(): Promise<void> {
  if (screenScanInFlight || screenSignatures.length === 0) return;
  screenScanInFlight = true;
  try {
    const rows = await control.sendCommand(
      `list-panes -a -f "${INTERNAL_SESSION_FILTER}" -F '${SCREEN_SCAN_FORMAT}'`,
    );
    for (const line of rows) {
      if (!line.trim()) continue;
      const [paneId, command, kind, currentState, source] = splitFields(line.trim());
      if (!paneId) continue;

      // Capturing is the expensive part — a whole screen buffer per pane per
      // tick over the control channel. The command is already in hand, so skip
      // every pane no signature could match rather than reading them all.
      if (!hasSignatureFor(command ?? "", screenSignatures)) {
        // A pane we previously classified has stopped running its agent (the
        // command is now a shell). Nothing else will ever clear our write, so a
        // stale badge would sit in the sidebar forever.
        if (source === "screen") await clearScreenState(paneId);
        continue;
      }

      const screen = await control
        .sendCommand(`capture-pane -p -t ${tq(paneId)}`)
        .catch(() => [] as string[]);
      const derived = classifyPaneScreen(command ?? "", screen.join("\n"), screenSignatures);
      if (derived === null) {
        // Still an agent pane, but its screen no longer matches any state we
        // know. Drop our stale guess rather than leaving it to rot.
        if (source === "screen") await clearScreenState(paneId);
        continue;
      }
      if (!screenTierMayWrite(kind ?? "", derived)) continue;

      // Only rewrite on an actual transition. Re-asserting the same state every
      // tick would reset @jmux-agent-state-since and destroy the elapsed timer,
      // which is the same trap the PreToolUse hook guards against.
      if (currentState === derived && source === "screen") continue;

      const since = Math.floor(Date.now() / 1000);
      await control
        .sendCommand(
          `set-option -p -t ${tq(paneId)} @jmux-agent-state ${derived} ; ` +
            `set-option -p -t ${tq(paneId)} @jmux-agent-state-since ${since} ; ` +
            `set-option -p -t ${tq(paneId)} @jmux-agent-source screen`,
        )
        .catch(() => {});
    }
  } catch {
    // A failed scan is a missed tick, not an error worth surfacing.
  } finally {
    screenScanInFlight = false;
  }
}

function startScreenScan(): void {
  if (screenScanInterval || configStore.config.agentScreenDetection !== true) return;
  screenScanInterval = setInterval(() => void scanAgentScreens(), 2000);
}

function stopScreenScan(): void {
  if (!screenScanInterval) return;
  clearInterval(screenScanInterval);
  screenScanInterval = null;
  // Retract everything the tier ever wrote. Without this, turning detection off
  // freezes its last guesses on screen permanently — the scanner that would
  // have corrected them is gone, and tmux outlives jmux, so the ghosts survive
  // a restart too.
  void purgeScreenStates();
}

/** Clear screen-derived state from every pane still carrying it. */
async function purgeScreenStates(): Promise<void> {
  try {
    const rows = await control.sendCommand(
      `list-panes -a -F '#{pane_id}${US}#{@jmux-agent-source}'`,
    );
    for (const line of rows) {
      if (!line.trim()) continue;
      const [paneId, source] = splitFields(line.trim());
      if (paneId && source === "screen") await clearScreenState(paneId);
    }
  } catch {
    // Best-effort cleanup; a failure here is not worth surfacing.
  }
}

async function ensureParkSession(): Promise<void> {
  // Scratch session the main client parks on while the glass is up. Created up
  // front (hidden via the internal-session filter) so it's ready when needed.
  await control.sendCommand(`new-session -d -s ${PARK_SESSION}`).catch(() => {});
}

/**
 * Reflect the per-pane `@jmux-pinned` option into the tracker and the sidebar's
 * Overview list. Non-destructive: panes are never moved — the glass renders live
 * mirrors of them (see GlassView). Runs on the pinned-panes subscription, on
 * pin/unpin, and once at startup.
 */
const PIN_LABEL_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{pane_title}",
  "#{pane_current_command}",
  "#{pane_current_path}",
].join(US);

function refreshPinnedPanes(): void {
  const state = parsePaneStateLines(
    glassRunner.run(["list-panes", "-a", "-F", PANE_STATE_FORMAT]).lines,
  );
  // Reflect raw @jmux-pinned values into the tracker (value, not just presence).
  for (const paneId of state.live.keys()) {
    pinnedTracker.apply(paneId, state.pins.get(paneId) ?? null);
  }
  pinnedTracker.pruneExcept([...state.live.keys()]);

  // Per-pane labels + home session names for building entries/specs.
  const labelByPane = new Map<string, { label: string; sessionName: string }>();
  for (const row of glassRunner.run(["list-panes", "-a", "-F", PIN_LABEL_FORMAT]).lines) {
    const [paneId, sessionName, paneTitle, cmd, path] = splitFields(row);
    if (!paneId) continue;
    labelByPane.set(paneId, {
      sessionName: sessionName ?? "",
      label: buildPaneLabel({
        sessionName: sessionName ?? "",
        paneTitle: paneTitle ?? "",
        paneCurrentCommand: cmd ?? "",
        paneCurrentPath: path ?? "",
      }),
    });
  }

  // Effective Command Center membership = manual pins ∪ auto-detected agent
  // panes (when the setting is on). Auto panes are derived each refresh and are
  // NOT written to @jmux-pinned.
  const effective = new Set(pinnedTracker.all());
  if (autoPinAgentPanes) {
    const rows = parseAgentDetectLines(
      glassRunner.run(["list-panes", "-a", "-F", AGENT_DETECT_FORMAT]).lines,
    );
    for (const id of detectAgentPanes(rows, agentPaneRegex)) effective.add(id);
  }

  // Deterministic order (by session name, then pane id) so tiles/counts keep a
  // stable arrangement across detach/reattach and restarts — set iteration
  // order reflects tmux's arbitrary list-panes order otherwise.
  const paneNum = (id: string): number => parseInt(id.replace(/^%/, ""), 10) || 0;
  const orderedPaneIds = [...effective]
    .filter((id) => state.live.has(id) && labelByPane.has(id))
    .sort((a, b) => {
      const sa = labelByPane.get(a)!.sessionName;
      const sb = labelByPane.get(b)!.sessionName;
      if (sa !== sb) return sa < sb ? -1 : 1;
      return paneNum(a) - paneNum(b);
    });

  const entries: PinnedPaneEntry[] = [];
  const specs: GlassTileSpec[] = [];
  const stateByTab = new Map<string, (AgentState | null)[]>();
  for (const paneId of orderedPaneIds) {
    const loc = state.live.get(paneId)!;
    const meta = labelByPane.get(paneId)!;
    // Per-pane, not the session rollup: each tile mirrors one agent, so a
    // sibling agent blocked in another pane must not paint this tile WAITING.
    // Falls back to the session value automatically for session-scoped writers,
    // because the pane-context read inherits.
    const agentState = agentStateTracker.getPaneState(paneId);
    const tabId = resolveTabId(pinnedTracker.getValue(paneId) ?? null, commandCenterTabs);
    entries.push({
      paneId,
      homeSessionName: meta.sessionName,
      label: meta.label,
      agentState,
    });
    specs.push({ paneId, sessionId: loc.sessionId, windowId: loc.windowId, label: meta.label, agentState, tabId });
    const arr = stateByTab.get(tabId) ?? [];
    arr.push(agentState);
    stateByTab.set(tabId, arr);
  }
  sidebar.setPinnedPanes(entries);

  // Per-tab summary for the strip dots.
  summaryByTab = new Map<string, AgentState | null>();
  for (const tab of commandCenterTabs) {
    summaryByTab.set(tab.id, summarizeTabState(stateByTab.get(tab.id) ?? []));
  }

  if (inGlass) glassView?.setTiles(specs, activeTabId);
  scheduleRender();
}

function ensureGlassView(): GlassView {
  if (!glassView) {
    glassView = new GlassView({
      socketName,
      configFile,
      jmuxDir,
      runner: (args) => glassRunner.run(args),
      minTileWidth: 80,
      minTileHeight: 10,
      onFrame: scheduleRender,
      stateColors: resolveStateColors(configStore.config.stateColors),
    });
  }
  return glassView;
}

function resizeGlass(): void {
  if (!glassView) return;
  // Command Center is a frameless full-screen takeover — size its tiles
  // (and the real mirrored PTYs behind them) against fullScreenLayout's
  // content band, not the shared toolbar-ful layout's smaller one, or the
  // tiles would leave a gap where the toolbar/footer chrome used to be.
  const totalCols = fullScreenLayout.termCols;
  const contentCols = sidebarShown ? totalCols - fullScreenLayout.main.x : totalCols;
  const stripRows = stripVisibleFor(commandCenterTabs) ? STRIP_ROWS : 0;
  const contentRows = Math.max(1, fullScreenLayout.contentRows - stripRows);
  glassView.resize(contentCols, contentRows);
}

async function enterGlass(): Promise<void> {
  // Captured before anything else: parking the client below fires
  // %client-session-changed, which rewrites currentSessionId to the internal
  // park session. Anything that later needs "the real session we came from" —
  // the ghost preview's unpark — has to read it from here.
  preGlassSessionId = currentSessionId;
  if (ghostPreview.isOpen) closeGhostPreview();
  ensureGlassView();
  inGlass = true;
  applyChromeLayout(); // frameless layout now governs the sidebar/input router
  // Restore last-active tab; fall back to default if it no longer exists.
  activeTabId = commandCenterTabs.some((t) => t.id === lastActiveTabId)
    ? lastActiveTabId
    : defaultTabId(commandCenterTabs);
  sidebar.setActiveSession(""); // clear the session highlight while in the glass
  sidebar.setOverviewActive(true);
  // Park the main client so it doesn't constrain the pinned sessions' sizes.
  if (!ptyClientName) await resolveClientName();
  if (ptyClientName) {
    await control
      .sendCommand(`switch-client -c ${ptyClientName} -t ${PARK_SESSION}`)
      .catch(() => {});
  }
  resizeGlass();
  refreshPinnedPanes(); // builds + applies tile specs (inGlass is true)
  scheduleRender();
}

function switchCommandCenterTab(tabId: string): void {
  if (!commandCenterTabs.some((t) => t.id === tabId)) return;
  activeTabId = tabId;
  lastActiveTabId = tabId;
  glassView?.setActiveTab(tabId);
  scheduleRender();
}

/** Switch to the prev/next tab relative to the active one, wrapping around. */
function switchCommandCenterTabRelative(delta: number): void {
  const n = commandCenterTabs.length;
  if (n === 0) return;
  const cur = commandCenterTabs.findIndex((t) => t.id === activeTabId);
  const base = cur < 0 ? 0 : cur;
  const next = ((base + delta) % n + n) % n; // wrap in both directions
  switchCommandCenterTab(commandCenterTabs[next].id);
}

/**
 * Surface a Command-Center validation error (empty/duplicate/too-long tab name,
 * non-empty/default tab delete) using the same short-lived ContentModal pattern
 * as session-creation failures — jmux has no toast system.
 */
function showCcError(message: string): void {
  const lines: StyledLine[] = [
    [],
    [{ text: message, attrs: { fg: 1, fgMode: 1, bg: theme.surface, bgMode: 2 } }],
    [],
    [{ text: "Press q or Esc to close.", attrs: { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 } }],
  ];
  const modal = new ContentModal({ lines, title: "Command Center" });
  modal.setTermRows(process.stdout.rows || 24);
  modal.open();
  openModal(modal, () => {});
  scheduleRender();
}

function persistTabs(next: TabEntry[]): void {
  commandCenterTabs = next;
  configStore.set("commandCenterTabs", next);
  // Clamp active/last-active if they vanished.
  if (!next.some((t) => t.id === activeTabId)) activeTabId = defaultTabId(next);
  if (!next.some((t) => t.id === lastActiveTabId)) lastActiveTabId = defaultTabId(next);
  if (inGlass) refreshPinnedPanes();
}

function openInputModalForNewTab(then: (tabId: string) => void): void {
  const modal = new InputModal({ header: "New tab name", placeholder: "e.g. Backend" });
  modal.open();
  openModal(modal, (value) => {
    const result = addTab(commandCenterTabs, String(value));
    if (!result.ok) { showCcError(result.error); return; }
    const created = result.tabs[result.tabs.length - 1];
    persistTabs(result.tabs);
    then(created.id);
  });
}

function openInputModalForRenameTab(): void {
  const current = commandCenterTabs.find((t) => t.id === activeTabId);
  if (!current) return;
  const modal = new InputModal({ header: "Rename tab", value: current.name });
  modal.open();
  openModal(modal, (value) => {
    const result = renameTab(commandCenterTabs, activeTabId, String(value));
    if (!result.ok) { showCcError(result.error); return; }
    persistTabs(result.tabs);
  });
}

function tryDeleteActiveTab(): void {
  const memberCount = pinnedTracker.all().filter(
    (p) => resolveTabId(pinnedTracker.getValue(p) ?? null, commandCenterTabs) === activeTabId,
  ).length;
  const result = deleteTab(commandCenterTabs, activeTabId, memberCount);
  if (!result.ok) { showCcError(result.error); return; }
  persistTabs(result.tabs);
  switchCommandCenterTab(defaultTabId(commandCenterTabs));
}

/**
 * Tear down the Command Center chrome (tiles + overview highlight) without
 * switching sessions. The caller is responsible for moving the PTY client onto
 * a real session — otherwise the main view renders the parked session. No-op
 * when the glass isn't up.
 */
function exitGlass(): void {
  if (!inGlass) return;
  inGlass = false;
  applyChromeLayout(); // back to the shared toolbar-ful layout
  glassView?.teardown();
  sidebar.setOverviewActive(false);
}

async function leaveGlass(sessionId: string): Promise<void> {
  if (!inGlass) {
    switchSession(sessionId);
    return;
  }
  exitGlass();
  await switchSession(sessionId); // unparks the main client onto the session
}

/**
 * Detach the interactive client — the Command Center equivalent of a normal
 * Ctrl-a d. In glass, keystrokes are routed to the focused tile's mirror client,
 * so prefix+d would detach that tile, not jmux. We replay prefix+d straight to
 * the main PTY instead: that detaches cleanly even while the client is parked on
 * the internal session (verified), whereas `detach-client -c` over the control
 * channel does NOT reliably detach the interactive client. The PTY then closes,
 * firing pty.onExit → cleanup(), which tears down the glass tiles.
 */
function detachClient(): void {
  pty.write("\x01d");
}

async function handleTabClick(windowId: string): Promise<void> {
  try {
    await control.sendCommand(`select-window -t ${windowId}`);
    await fetchWindows();
  } catch {
    // Window may have been closed
  }
}

// --- Startup sequence ---

async function start(): Promise<void> {
  // Wait for first PTY data (tmux is ready) using a one-shot flag
  await new Promise<void>((resolve) => {
    let resolved = false;
    pty.onData(function firstData() {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });
  });

  // Start control mode
  await control.start({ socketName, configFile });
  // Apply theme-derived pane fade colors now that the control channel is up
  // (a theme detected during boot is already in `theme`).
  controlStarted = true;
  applyPaneStyles();

  // The tmux server has already loaded config at startup (TmuxPty and the
  // Restorer both pass `-f <configFile>`), and JMUX_DIR is exported in
  // process.env so tmux subprocesses inherit it. We do NOT source-file
  // here — doing so via control mode causes its nested commands to emit
  // many %begin/%end blocks asynchronously, which scrambles the FIFO
  // pending-queue matching and corrupts subsequent command responses.
  await control.sendCommand("set-environment -g JMUX 1");

  // Config generation. `-f` is honored only when tmux *starts* a server, so
  // attaching to a server left running by an older jmux silently keeps that
  // version's bindings. Read the stamp before writing ours, or every server
  // looks current.
  try {
    const running = await control.sendCommand(`show-option -gqv ${GENERATION_OPTION}`);
    const verdict = compareGeneration(Array.isArray(running) ? running.join("") : String(running ?? ""), jmuxDir);
    if (verdict.kind === "stale") {
      const notice = staleGenerationNotice(verdict);
      logError("config-generation", `server ${verdict.running} != assets ${verdict.expected}`);
      // Shown once, on the surface the user is already looking at. Silently
      // logging it would reproduce the original bug: the upgrade appears to
      // have worked and none of the new bindings do anything.
      const lines: StyledLine[] = notice.map((text) => [
        { text, attrs: { bg: theme.surface, bgMode: 2 } },
      ]);
      const modal = new ContentModal({ lines, title: "tmux is running an older config" });
      modal.setTermRows(process.stdout.rows || 24);
      modal.open();
      openModal(modal, () => {});
    }
    await control.sendCommand(stampCommand(jmuxDir));
  } catch (err) {
    // A server that won't answer about its generation is not a reason to fail
    // startup — the check is a courtesy, not a dependency. But swallowing the
    // reason silently means the check can stop working and never say so, which
    // is how this shipped not working the first time.
    logError("config-generation", `check skipped: ${(err as Error).message}`);
  }

  // Start OTLP receiver and inject OTel env vars
  const otelPort = await otelReceiver.start();
  await control.sendCommand("set-environment -g CLAUDE_CODE_ENABLE_TELEMETRY 1");
  await control.sendCommand("set-environment -g OTEL_LOGS_EXPORTER otlp");
  await control.sendCommand("set-environment -g OTEL_EXPORTER_OTLP_PROTOCOL http/json");
  await control.sendCommand(`set-environment -g OTEL_EXPORTER_OTLP_ENDPOINT http://127.0.0.1:${otelPort}`);

  // Resolve client and session — retry until the PTY client registers
  await fetchSessions();

  // Set per-session resource attributes for all existing sessions.
  // Note: set-environment only affects new panes/windows in these sessions —
  // already-running shells won't pick up the change until they restart.
  for (const session of currentSessions) {
    await control.sendCommand(
      `set-environment -t ${tq(session.name)} OTEL_RESOURCE_ATTRIBUTES ${tq(`tmux_session_name=${session.name}`)}`,
    );
  }

  for (let i = 0; i < 20 && !currentSessionId; i++) {
    await resolveClientName();
    if (!currentSessionId) {
      await new Promise<void>((r) => {
        // Wait for next PTY data rather than fixed delay — that's the signal tmux is ready
        const handler = () => { pty.offData(handler); r(); };
        pty.onData(handler);
      });
    }
  }
  await syncControlClient();
  await fetchWindows();
  await fetchAgentState();
  await ensureParkSession();
  refreshPinnedPanes();

  // One-time legacy migration: previous jmux versions wrote @jmux-attention=1
  // via a Stop hook. That option is now an orchestrator/human-gate signal owned
  // by `jmux ctl session attention`, so we must NOT clear it on every launch —
  // that would clobber a flag Sonny set. Instead clear stale legacy flags
  // exactly once per tmux server, guarded by a server-global marker, then leave
  // orchestrator-set flags untouched across subsequent restarts.
  const legacyClearedMarker = await control
    .sendCommand("show-option -gqv @jmux-attention-legacy-cleared")
    .catch(() => [] as string[]);
  const alreadyCleared = legacyClearedMarker.some((l) => l.trim() === "1");
  if (!alreadyCleared) {
    for (const session of currentSessions) {
      void control
        .sendCommand(`set-option -t ${tq(session.id)} -u @jmux-attention`)
        .catch(() => {});
    }
    void control
      .sendCommand("set-option -g @jmux-attention-legacy-cleared 1")
      .catch(() => {});
  }

  startupComplete = true;

  // Screen-signature tier for agents with no hook or extension integration.
  //
  // Purge first, unconditionally: tmux outlives jmux, so any derived state on
  // disk is from a previous run and is stale by definition — the screen it was
  // read from is long gone. Without this, state written before a quit or crash
  // is permanent whenever detection is subsequently off, since the scanner that
  // would retract it never starts. When detection *is* on, the scanner
  // re-derives within one tick.
  void purgeScreenStates();
  // Opt-in, so this is a no-op unless the user turned it on.
  startScreenScan();

  // --- Snapshotter wiring ---
  if (configStore.config.snapshot?.enabled !== false) {
    const {
      Snapshotter,
      SnapshotModel,
      ProductionFileSystem: SnapFs,
      ProductionTmuxRunner: SnapRunner,
      ProductionClock: SnapClock,
      LockRetrier,
    } = await import("./snapshot");

    const snapFs = new SnapFs();
    const snapClock = new SnapClock();
    const lockPath = `${boot.snapshotDir}/.lock`;

    // Construct + wire the Snapshotter around an already-acquired lock. Called
    // immediately when boot holds the lock, or later by the LockRetrier once a
    // locked-out boot reclaims it.
    const startSnapshotter = async (
      lock: import("./snapshot/deps").Lock,
    ): Promise<void> => {
      const snapshotModel = new SnapshotModel(process.env.JMUX_VERSION ?? "dev");
      snapshotModel.setSocket(socketName ?? "default");

      snapshotter = new Snapshotter({
        dir: boot.snapshotDir,
        model: snapshotModel,
        fs: snapFs,
        runner: new SnapRunner(socketName ?? null),
        clock: snapClock,
        debounceMs: 200,
        scrollbackIntervalMs: configStore.config.snapshot?.scrollbackIntervalMs ?? 5000,
        scrollbackMaxBytes: configStore.config.snapshot?.scrollbackMaxBytes ?? 2 * 1024 * 1024,
        lock,
        staleMs: 60_000,
        captureIntervalMs: 15_000,
        healthPersistPath: `${boot.snapshotDir}/health.json`,
        onHealthChange: () => scheduleRender(),
      });

      await snapshotter.start();

      // Seed the model with current live tmux state
      await snapshotter.onSessionsChanged();

      // Seed the snapshot model with current agent-state records. fetchAgentState()
      // ran before snapshotter existed, so its updates went through the optional
      // chain (`snapshotter?.onAgentState(...)`) and were no-ops. Replay them now
      // so a capture-then-restart-then-restore cycle preserves agent state.
      for (const session of currentSessions) {
        const record = agentStateTracker.getRecord(session.id);
        if (!record) continue;
        snapshotter.onAgentState(session.name, {
          state: record.state,
          since: new Date(record.since).toISOString(),
        });
      }

      // Subscribe to TmuxControl events that affect the model
      control.onEvent((e: ControlEvent) => {
        switch (e.type) {
          case "sessions-changed":
            void snapshotter!.onSessionsChanged();
            break;
          case "session-renamed":
            // Model rename + re-derive in one pass
            if (e.args) {
              const parts = e.args.split(" ");
              if (parts.length >= 2) {
                const sessionId = parts[0];
                const newName = parts.slice(1).join(" ");
                const oldName = currentSessions.find((s) => s.id === sessionId)?.name;
                if (oldName && oldName !== newName) {
                  void snapshotter!.onSessionRenamed(oldName, newName);
                }
              }
            }
            void snapshotter!.onSessionsChanged();
            break;
          case "window-add":
          case "window-close":
          case "window-renamed":
            void snapshotter!.onSessionsChanged();
            break;
        }
      });

      // On control reconnect, do a full re-derivation
      control.onReconnected(() => {
        void snapshotter!.onSessionsChanged();
      });

      // On permanent control channel loss, surface the degraded chip and stop captures
      control.onLost(() => {
        controlChannelLost = true;
        void snapshotter?.stop();
        scheduleRender();
      });

      // SessionState link changes
      sessionState.onChange((name) => {
        snapshotter!.onLinks(name, sessionState.getLinks(name));
      });

      // OtelReceiver updates
      otelReceiver.onSessionUpdate((name) => {
        const snap = otelReceiver.getSessionSnapshot(name);
        snapshotter!.onOtel(name, snap);
      });

      // Seed focus with the initial session
      const initialFocusName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? null;
      snapshotter.onFocused(initialFocusName);
      scheduleRender(); // reflect the now-healthy snapshot chip
    };

    if (!boot.lockedOut && boot.snapshotLock) {
      const lock = boot.snapshotLock;
      // Ownership transfers to the Snapshotter; clear the boot copy so cleanup()
      // releases via snapshotter.stop() and never double-releases.
      boot.snapshotLock = null;
      await startSnapshotter(lock);
    } else if (boot.lockedOut) {
      // Locked out at boot. A held lock is not necessarily a LIVE holder — an
      // orphaned lock left by a crashed instance looks live until it ages past
      // the stale window, and boot decides lockedOut only once. Retry in the
      // background so snapshotting starts as soon as the lock is reclaimable
      // (stale orphan) or freed (a genuine other jmux exits), instead of staying
      // disabled for this whole process lifetime.
      lockRetrier = new LockRetrier({
        fs: snapFs,
        path: lockPath,
        clock: snapClock,
        intervalMs: 10_000,
        onAcquired: (lock) => {
          void startSnapshotter(lock);
        },
        onCompromised: (e) => snapshotter?.handleCompromised(e),
      });
      lockRetrier.start();
    }
  }

  // Sync issue panel to the initial session
  const initialSessionName = currentSessions.find((s) => s.id === currentSessionId)?.name;
  if (initialSessionName) {
    await pollCoordinator.setActiveSession(initialSessionName);
    focusPanelOnSessionIssue(initialSessionName);
  }

  renderFrame();

  // First-run welcome screen
  if (configStore.ensureExists()) {

    const g: CellAttrs = { fg: 2, fgMode: 1, bg: theme.surface, bgMode: 2 };
    const b: CellAttrs = { bold: true, bg: theme.surface, bgMode: 2 };
    const d: CellAttrs = { ...neutralFg(8), dim: true, bg: theme.surface, bgMode: 2 };
    const n: CellAttrs = { bg: theme.surface, bgMode: 2 };
    const c: CellAttrs = { fg: 6, fgMode: 1, bg: theme.surface, bgMode: 2 };
    const y: CellAttrs = { fg: 3, fgMode: 1, bg: theme.surface, bgMode: 2 };

    const welcomeLines: StyledLine[] = [
      [{ text: "The terminal workspace for agentic development", attrs: d }],
      [],
      [{ text: "\u2500".repeat(44), attrs: d }],
      [],
      [{ text: "Essential keybindings", attrs: b }],
      [],
      [{ text: "Ctrl-Shift-Up/Down", attrs: g }, { text: "     Switch between sessions", attrs: n }],
      [{ text: "Ctrl-a", attrs: g }, { text: " then ", attrs: n }, { text: "n", attrs: g }, { text: "          New session", attrs: n }],
      [{ text: "Ctrl-a", attrs: g }, { text: " then ", attrs: n }, { text: "c", attrs: g }, { text: "          New window (tab)", attrs: n }],
      [{ text: "Ctrl-a", attrs: g }, { text: " then ", attrs: n }, { text: "|", attrs: g }, { text: "          Split pane horizontally", attrs: n }],
      [{ text: "Ctrl-a", attrs: g }, { text: " then ", attrs: n }, { text: "-", attrs: g }, { text: "          Split pane vertically", attrs: n }],
      [{ text: "Shift-Arrow", attrs: g }, { text: "            Move between panes", attrs: n }],
      [{ text: "Ctrl-a", attrs: g }, { text: " then ", attrs: n }, { text: "p", attrs: g }, { text: "          Command palette", attrs: n }],
      [],
      [{ text: "\u2500".repeat(44), attrs: d }],
      [],
      [{ text: "The sidebar", attrs: b }, { text: " on the left shows all your sessions.", attrs: n }],
      [{ text: "\u25CF", attrs: g }, { text: " Green dot = new output    ", attrs: n }, { text: "!", attrs: y }, { text: " Orange = needs review", attrs: n }],
      [{ text: "Click a session to switch to it.", attrs: n }],
      [],
      [{ text: "\u2500".repeat(44), attrs: d }],
      [],
      [{ text: "Next steps", attrs: b }],
      [],
      [{ text: "1.", attrs: c }, { text: " Try ", attrs: n }, { text: "Ctrl-a p", attrs: g }, { text: " to open the command palette", attrs: n }],
      [{ text: "2.", attrs: c }, { text: " Run ", attrs: n }, { text: "jmux --install-agent-hooks", attrs: g }, { text: " for Claude Code notifications", attrs: n }],
      [{ text: "3.", attrs: c }, { text: " Full guide: ", attrs: n }, { text: "github.com/jarredkenny/jmux", attrs: d }],
    ];

    const welcomeModal = new ContentModal({ lines: welcomeLines, title: "Welcome to jmux" });
    welcomeModal.setTermRows(process.stdout.rows || 24);
    welcomeModal.open();
    openModal(welcomeModal, () => {});
  }

  // Subscribe to per-pane agent-state user options. These only ever act as a
  // *trigger* — the payload is discarded and fetchAgentState() re-queries — so
  // the format just has to change whenever any pane's value does.
  //
  // The nesting is required: `#{S:}` loops every session but `#{P:}` alone only
  // covers panes of the *current window*, so a bare pane loop would silently
  // miss every unfocused window. `#{S:#{W:#{P:}}}` enumerates the whole server.
  await control.registerSubscription(
    "agent-state",
    1,
    "#{S:#{W:#{P:#{pane_id}=#{@jmux-agent-state} }}}",
  );
  await control.registerSubscription(
    "agent-state-since",
    1,
    "#{S:#{W:#{P:#{pane_id}=#{@jmux-agent-state-since} }}}",
  );

  // Subscribe to window count + active window + name — fires on add/remove/switch/rename
  await control.registerSubscription(
    "windows",
    1,
    "#{session_windows} #{window_index} #{window_name} #{window_zoomed_flag}",
  );

  // Subscribe to per-pane pin flag — fires whenever any pane's @jmux-pinned changes.
  await control.registerSubscription(
    "pinned-panes",
    1,
    "#{P:#{pane_id}=#{@jmux-pinned} }",
  );
}

// --- Cleanup ---

function cleanupSync(): void {
  killDiffProcess();
  glassView?.teardown(); // detach any Command Center mirror clients explicitly
  pollCoordinator.stop();
  otelReceiver.stop();
  stopCacheTimerTick();
  if (themeRequeryInterval !== null) { clearInterval(themeRequeryInterval); themeRequeryInterval = null; }
  if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
  if (viewSaveTimer !== null) { clearTimeout(viewSaveTimer); viewSaveTimer = null; }
  configWatcher?.close();
  control.close().catch(() => {});
  process.stdout.write("\x1b[?2004l"); // disable bracketed paste mode
  process.stdout.write("\x1b[?1000l"); // disable mouse button tracking
  process.stdout.write("\x1b[?1003l"); // disable mouse motion tracking
  process.stdout.write("\x1b[?1006l"); // disable SGR mouse mode
  // Free every image the terminal is holding for us. Leaving the alternate
  // screen clears the placements, but the transmitted data outlives it — the
  // terminal keeps it until told otherwise, and jmux exiting is the last chance
  // to tell it.
  process.stdout.write(renderer.teardownImages());
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  if (demoCtx && demoCleanup) {
    demoCleanup(demoCtx);
  }
}

async function cleanup(): Promise<void> {
  // Stop retrying to acquire the lock (a locked-out boot may still be polling).
  lockRetrier?.stop();
  if (snapshotter) {
    await snapshotter.stop().catch(() => undefined);
  } else if (boot?.snapshotLock) {
    // The Snapshotter never took ownership (startup failed or was aborted before
    // its construction). Release the boot lock ourselves so a partial startup
    // can't leak it — the exact class of orphan that deadlocked this feature.
    await boot.snapshotLock.release().catch(() => undefined);
  }
  cleanupSync();
  process.exit(0);
}

pty.onExit(() => void cleanup());
process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());
process.on("SIGHUP", () => void cleanup());

// --- Go ---

start().catch((e) => {
  logCrash("boot", e);
  void cleanup();
});
