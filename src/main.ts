import { $ } from "bun";
import { TmuxPty } from "./tmux-pty";
import { ScreenBridge } from "./screen-bridge";
import { Renderer, getToolbarButtonRanges, getToolbarTabRanges, getModalPosition, type ToolbarConfig } from "./renderer";
import { InputRouter } from "./input-router";
import { Sidebar, rebuildSidebarColors, type PinnedPaneEntry } from "./sidebar";
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
import { CreateIssueModal, type CreateIssueResult } from "./create-issue-modal";
import { buildPinCommands } from "./cli/pane";
import type { CellAttrs } from "./cell-grid";
import { createGrid } from "./cell-grid";
import type { Modal } from "./modal";
import { rebuildModalAttrs } from "./modal";
import {
  theme,
  neutralFg,
  setTheme,
  deriveTheme,
  pack,
  toHex,
  accentFor,
  OSC11_QUERY,
} from "./theme";
import { StdinGate } from "./stdin-gate";
import { TmuxControl, type ControlEvent } from "./tmux-control";
import { DiffPanel } from "./diff-panel";
import { InfoPanel, rebuildInfoPanelColors } from "./info-panel";
import { parseViews, cycleGroupBy, cycleSortBy, toggleSortOrder, type PanelView } from "./panel-view";
import { transformIssues, transformMrs, buildViewNodes, renderView, createViewState, filterItems, rebuildPanelViewColors, type ViewState, type ViewNode, type IssueSessionInfo } from "./panel-view-renderer";
import { createAdapters } from "./adapters/registry";
import { PollCoordinator } from "./adapters/poll-coordinator";
import { SessionState } from "./session-state";
import type { SessionContext } from "./adapters/types";
import type { DemoContext } from "./demo/setup";
import type { SessionInfo, WindowTab, PaletteCommand, PaletteResult, AgentState } from "./types";
import { loadProjectDirsCache, saveProjectDirsCache } from "./project-dirs-cache";
import { ConfigStore, sanitizeTmuxSessionName } from "./config";
import { resolveStateColors, STATE_COLOR_NAMES, DEFAULT_STATE_COLORS } from "./state-colors";
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
import { computeFrameLayout, type FrameLayout } from "./frame-layout";
import { AgentStateTracker, coerceStaleAgentState } from "./agent-state";
import { logError } from "./log";
import { installHooks, type ClaudeSettings } from "./hook-installer";
import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
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
  --install-agent-hooks    Install Claude Code attention flag hooks
  -v, --version            Show version
  -h, --help               Show this help

Examples:
  jmux                     Start with default session
  jmux my-project          Start with named session
  jmux -L work             Use isolated tmux server
  jmux --install-agent-hooks  Set up Claude Code integration

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

if (process.argv.includes("--install-agent-hooks")) {
  installAgentHooks();
  process.exit(0);
}

function installAgentHooks(): void {
  const claudeDir = resolve(homedir(), ".claude");
  const settingsPath = resolve(claudeDir, "settings.json");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error("Error: could not parse ~/.claude/settings.json");
      process.exit(1);
    }
  }

  const outcome = installHooks(settings);

  if (outcome.kind === "noop") {
    console.log("jmux agent hooks are already installed.");
    return;
  }

  writeFileSync(settingsPath, JSON.stringify(outcome.settings, null, 2) + "\n");

  if (outcome.kind === "migrated") {
    console.log("Migrated jmux Stop hook to the new agent-state hooks");
    console.log("(UserPromptSubmit, PermissionRequest, PreToolUse, Stop).");
    console.log("Restart Claude Code in any open session to pick them up.");
  } else {
    console.log("Installed jmux agent hooks in ~/.claude/settings.json");
    console.log("");
    console.log("Your jmux sidebar will now show RUNNING / WAITING / COMPLETE");
    console.log("for each Claude Code session.");
  }
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
  demoCtx = mod.setupDemo();
  demoCleanup = mod.cleanupDemo;
}

const configStore = new ConfigStore(demoCtx?.configPath);
let sidebarWidth = configStore.config.sidebarWidth || 26;
const BORDER_WIDTH = 1;
const toolbarEnabled = true;
// Opt-in second toolbar row showing each window's git branch. Read once at
// startup; changing it requires a restart (toolbarHeight feeds PTY sizing).
const windowBranchesEnabled = configStore.config.windowBranches === true;
const toolbarHeight = toolbarEnabled ? (windowBranchesEnabled ? 2 : 1) : 0;
let claudeCommand = configStore.config.claudeCommand || "claude";
let cacheTimersEnabled = configStore.config.cacheTimers !== false;
let autoPinAgentPanes = configStore.config.autoPinAgentPanes === true;
let agentPaneRegex = configStore.config.agentPaneCommandRegex ?? "codex";
let pinnedSessions = new Set<string>(configStore.config.pinnedSessions ?? []);
let infoPanelWidth: number | null = configStore.config.infoPanelWidth ?? null;
let diffPanelSplitRatio = configStore.config.diffPanel?.splitRatio ?? 0.4;
let hunkCommand = configStore.config.diffPanel?.hunkCommand ?? "hunk";

// Resolve paths relative to source
const jmuxDir = resolve(dirname(import.meta.dir));
const configFile = resolve(jmuxDir, "config", "tmux.conf");
// Export JMUX_DIR so every tmux subprocess (PTY, control, Restorer) inherits
// it. The config file expands "$JMUX_DIR/config/defaults.conf", which is
// resolved at config-load time against the tmux server's environment — which
// is inherited from this process. Setting it here means we don't need to
// `set-environment -g JMUX_DIR ...` after control-mode attaches.
process.env.JMUX_DIR = jmuxDir;

// Parse args: jmux [session] [--socket name] [--demo]
let sessionName: string | undefined;
let socketName: string | undefined = demoCtx?.socketName;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--demo") {
    continue; // already handled above
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

async function preflight(): Promise<void> {
  const missing: string[] = [];
  if (!hasCommand(["tmux", "-V"])) {
    missing.push("tmux");
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
  frameRulesEnabled: false,
  footerEnabled: false,
});
let mainCols = layout.main.w;

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
  const snapshotChip = snapshotChipLabel(getSnapshotHealth());
  return {
    buttons: [
      { label: "◈", id: "panel", fg: diffPanel.isActive() ? accentFor((0xF0 << 16) | (0x88 << 8) | 0x3E) : undefined, fgMode: diffPanel.isActive() ? 2 : undefined },
      { label: "＋", id: "new-window" },
      { label: "⏸", id: "split-v" },
      { label: "⏏", id: "split-h" },
      { label: "λ", id: "claude", fg: accentFor((0xE8 << 16) | (0xA0 << 8) | 0xB4), fgMode: 2 },
      { label: "⚙", id: "settings" },
    ],
    mainCols,
    hoveredButton: hoveredToolbarButton,
    tabs: currentWindows,
    hoveredTabId,
    statusChip: snapshotChip,
  };
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
    claudeCommand: opts.config.claudeCommand ?? "claude",
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
    rebuildModalAttrs();
    rebuildSidebarColors();
    rebuildInfoPanelColors();
    rebuildSettingsColors();
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
const sidebar = new Sidebar(sidebarWidth, rows);
sidebar.setStateColors(resolveStateColors(configStore.config.stateColors));
const agentStateTracker = new AgentStateTracker();
agentStateTracker.onChange((sessionId) => {
  const record = agentStateTracker.getRecord(sessionId);
  sidebar.setAgentStateRecord(sessionId, record);

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
    // Chain the two writes so we never leave the session with state=running
    // and since=stale-from-waiting. Fire-and-forget; failures are harmless.
    void (async () => {
      try {
        await control.sendCommand(`set-option -t ${tq(id)} @jmux-agent-state running`);
        await control.sendCommand(
          `set-option -t ${tq(id)} @jmux-agent-state-since ${Math.floor(Date.now() / 1000)}`,
        );
      } catch {
        // Best-effort: control-channel failure leaves the previous state intact.
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

import { SettingsScreen, rebuildSettingsColors, type SettingDef, type SettingsCategory, type SettingsAction } from "./settings-screen";

const adapters = demoCtx
  ? { codeHost: demoCtx.codeHost, issueTracker: demoCtx.issueTracker }
  : createAdapters(configStore.config.adapters);
const infoPanel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
const panelViews = parseViews(configStore.config.panelViews);
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
  const visibleViews = panelViews.filter((v) => {
    if (v.source === "issues") return adapters.issueTracker?.authState === "ok";
    if (v.source === "mrs") return adapters.codeHost?.authState === "ok";
    return false;
  });
  infoPanel.updateConfig({
    viewIds: visibleViews.map((v) => v.id),
    viewLabels: new Map(visibleViews.map((v) => [v.id, v.label])),
  });
}

const pollCoordinator = new PollCoordinator({
  codeHost: adapters.codeHost,
  issueTracker: adapters.issueTracker,
  onUpdate: (sessionName) => {
    sidebar.setSessionContexts(pollCoordinator.getAllContexts());
    if (sessionName === "__global__") refreshTeams();
    scheduleRender();
  },
  getSessionDir: (name) => {
    const session = currentSessions.find((s) => s.name === name);
    return session ? (sessionDetailsCache.get(session.id)?.directory ?? null) : null;
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
const sessionDetailsCache = new Map<string, { directory?: string; gitBranch?: string; project?: string }>();

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

function switchByOffset(offset: number): void {
  const ids = sidebar.getDisplayOrderIds();
  // Virtual cycle with the Overview as the first stop: [Overview, ...sessions].
  const n = ids.length + 1;
  let curPos: number;
  if (inGlass) {
    curPos = 0;
  } else {
    const idx = ids.indexOf(currentSessionId ?? "");
    curPos = idx >= 0 ? idx + 1 : Math.min(1, ids.length);
  }
  const newPos = (((curPos + offset) % n) + n) % n;
  if (newPos === 0) {
    if (!inGlass) void enterGlass();
    return;
  }
  const target = ids[newPos - 1];
  if (inGlass) void leaveGlass(target);
  else switchSession(target);
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
    // Chrome (rule rows + footer) is implemented in frame-layout.ts but not
    // yet turned on anywhere in production; both flags stay false until the
    // rendering tasks that actually draw this chrome land.
    frameRulesEnabled: false,
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

  mainCols = layout.main.w;
  sidebarShown = layout.sidebar !== null;

  pty.resize(layout.main.w, layout.ptyRows);
  bridge.resize(layout.main.w, layout.ptyRows);

  if (diffPty && diffBridge && layout.panel) {
    diffPty.resize(layout.panel.w, layout.ptyRows);
    diffBridge.resize(layout.panel.w, layout.ptyRows);
  }

  inputRouter.setLayout(layout);

  sidebar.resize(sidebarWidth, layout.termRows);

  scheduleRender();
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
      const dir = sessionDetailsCache.get(session.id)?.directory;
      if (dir) pollCoordinator.addSession(session.name, dir);
    }
    for (const [name] of pollCoordinator.getAllContexts()) {
      if (!knownSessions.has(name)) pollCoordinator.removeSession(name);
    }
    sidebar.setSessionContexts(pollCoordinator.getAllContexts());

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
          sidebar.setActiveSession(sessionId);
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
function computeModalOverlay(): {
  grid: import("./types").CellGrid;
  cursor: { row: number; col: number } | null;
} | null {
  if (!activeModal?.isOpen()) return null;
  const termCols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const modalWidth = activeModal.preferredWidth(termCols);
  const grid = activeModal.getGrid(modalWidth);
  const pos = getModalPosition(termCols, termRows, modalWidth, grid.rows);
  const cursorPos = activeModal.getCursorPosition();
  const cursor = cursorPos
    ? { row: pos.startRow + cursorPos.row, col: pos.startCol + cursorPos.col }
    : null;
  return { grid, cursor };
}

function renderFrame(): void {
  if (writesPending > 0) return;

  // Settings screen replaces main content
  if (settingsScreen.isOpen) {
    const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
    const totalCols = layout.termCols;
    const contentCols = sidebarShown ? totalCols - layout.main.x : totalCols;
    const contentRows = process.stdout.rows || 24;
    const settingsGrid = settingsScreen.render(contentCols, contentRows);
    renderer.render(
      layout,
      settingsGrid,
      { x: 0, y: 0 },
      sidebarGrid,
      null, // no toolbar
      null, // no modal
      null, // no modal cursor
      undefined, // no diff panel
    );
    return;
  }

  // Pane-of-glass (Overview) replaces main content; toolbar hidden. Modals
  // (e.g. the command palette) still composite on top — otherwise they open
  // invisibly while the Command Center is up.
  if (inGlass && glassView) {
    const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
    const overlay = computeModalOverlay();
    const stripVisible = stripVisibleFor(commandCenterTabs);
    const totalCols = layout.termCols;
    const contentCols = sidebarShown ? totalCols - layout.main.x : totalCols;

    let content = glassView.getGrid();
    let cursor = glassView.getFocusedCursor() ?? { x: 0, y: 0 };

    if (stripVisible) {
      const palette = resolveStateColors(configStore.config.stateColors);
      const stripInput = { tabs: commandCenterTabs, activeTabId, summaryByTab, width: contentCols, palette };
      currentStripChips = layoutStrip(stripInput);
      const strip = renderStrip(stripInput, currentStripChips);
      const combined = createGrid(contentCols, (process.stdout.rows || 24));
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

    renderer.render(layout, content, cursor, sidebarGrid, null, overlay?.grid ?? null, overlay?.cursor ?? null, undefined);
    return;
  }

  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  const tb = toolbarEnabled ? makeToolbar() : null;
  const overlay = computeModalOverlay();
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
          rawItems = transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates());
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
        contentGrid = renderView(nodes, dpCols, dpRows, viewState);
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
  const sessionDir = sessionDetailsCache.get(currentSessionId ?? "")?.directory ?? null;
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

function openCreateIssueModal(): void {
  if (!adapters.issueTracker || adapters.issueTracker.authState !== "ok") return;
  if (cachedTeams.length === 0) return;

  const preselectedTeamId = resolvePreselectedTeamId();
  const modal = new CreateIssueModal({ teams: cachedTeams, preselectedTeamId });
  modal.open();
  openModal(modal, async (value) => {
    const result = value as CreateIssueResult;
    try {
      const issue = await adapters.issueTracker!.createIssue(result.teamId, result.title, result.description);
      pollCoordinator.addGlobalIssue(issue);
      scheduleRender();
    } catch (e) {
      logError("jmux", `failed to create issue: ${(e as Error).message}`);
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
    onSidebarClick: (row) => {
      if (sidebar.isVersionRow(row)) {
        showVersionInfo();
        return;
      }
      const groupLabel = sidebar.getGroupByRow(row);
      if (groupLabel) {
        sidebar.toggleGroup(groupLabel);
        scheduleRender();
        return;
      }
      const sel = sidebar.getSelectionByRow(row);
      if (sel?.type === "overview" || sel?.type === "pinnedPane") {
        void enterGlass();
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
      } else {
        if (hoveredToolbarButton !== null) { hoveredToolbarButton = null; changed = true; }
        if (hoveredTabId !== null) { hoveredTabId = null; changed = true; }
        if (sidebar.getHoveredRow() !== null) { sidebar.setHoveredRow(null); changed = true; }
      }
      if (changed) scheduleRender();
    },
    onModalToggle: () => togglePalette(),
    onNewSession: () => handlePaletteAction({ commandId: "new-session" }),
    onSettings: () => handleToolbarAction("settings"),
    onSettingsScreen: () => toggleSettingsScreen(),
    onModalInput: (data) => {
      // Settings screen consumes input when open
      if (settingsScreen.isOpen) {
        handleSettingsInput(data);
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
        rawItems = transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates());
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
        const listRows = Math.max(3, Math.floor((dpRows - 2 - 1) * 0.5));
        if (viewState.selectedIndex >= viewState.scrollOffset + listRows) {
          viewState.scrollOffset = viewState.selectedIndex - listRows + 1;
        }
        scheduleRender();
      }
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
        ? transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates())
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
      let rawItems = transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates());
      if (viewState.filterQuery) rawItems = filterItems(rawItems, viewState.filterQuery);
      const effectiveView = viewState.filterQuery ? { ...view, groupBy: "none" as const } : view;
      const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
      const selected = nodes[viewState.selectedIndex];
      if (selected?.kind !== "item" || selected.item.type !== "issue") return;
      const issue = selected.item.raw as import("./adapters/types").Issue;
      const issueState = selected.item.issueSessionState ?? "none";
      const linkedSessionName = selected.item.linkedSessionName;

      // STATE 3: a live session already exists for this issue (either via an
      // explicit L-key link or a workflow-derived name match). Switch to it.
      // Done before the workflow/repoDir check so explicit links work even
      // when the issue's team has no teamRepoMap entry.
      if (issueState === "session" && linkedSessionName) {
        if (!ptyClientName) await resolveClientName();
        if (!ptyClientName) return;
        await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(linkedSessionName)}`);
        return;
      }

      const workflow = configStore.config.issueWorkflow;
      const repoDir = workflow?.teamRepoMap?.[issue.team ?? ""];

      // Automated path: config maps this issue's team to a repo
      if (repoDir) {
        if (!ptyClientName) await resolveClientName();
        if (!ptyClientName) return;

        const session = resolveIssueSessionName(issue);
        if (!session) return;

        const expandedDir = repoDir.replace("~", homedir());
        const baseBranch = workflow?.defaultBaseBranch ?? "main";

        try {
          // Seed the first user message for Claude by writing the issue prompt
          // to a temp file — the main pane reads it via $(cat ...) and claude
          // takes its content as a positional argument (the documented
          // interactive-seed form). Without this the pane falls back to
          // `exec $SHELL` so the session is usable even if the agent is off.
          const shouldLaunchAgent = workflow?.autoLaunchAgent !== false && !!adapters.issueTracker;
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
            ? `${claudeCommand} "$(cat ${promptTmp})"; rm -f ${promptTmp}; exec $SHELL`
            : `exec $SHELL`;

          // STATE 2: Worktree exists but no session → launch claude directly
          if (issueState === "worktree") {
            const wtPath = `${expandedDir}/${session}`;
            await control.sendCommand(
              `new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(wtPath)} ${tq(claudeFragment)}`,
            );
            await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(session)}`);
            sessionState.addLink(session, { type: "issue", id: issue.id });
            return;
          }

          // STATE 1: Nothing exists → create worktree + session
          const isBare = Bun.spawnSync(
            ["git", "--git-dir", `${expandedDir}/.git`, "config", "--get", "core.bare"],
            { stdout: "pipe", stderr: "ignore" },
          ).stdout.toString().trim() === "true";

          // Use Linear's branch name for the git branch
          let branchName: string;
          if (issue.branchName) {
            branchName = issue.branchName;
          } else {
            const template = workflow?.sessionNameTemplate ?? "{identifier}";
            branchName = template
              .replace("{identifier}", issue.identifier.toLowerCase())
              .replace("{title}", issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));
          }

          if (isBare) {
            const wtPath = `${expandedDir}/${session}`;
            // Main (left) pane runs claude — but first it has to wait for the
            // sibling setup pane to materialize the worktree directory. Tmux
            // wants a cwd that exists at split time, so we open the pane in
            // the bare repo root and have the shell cd into the worktree once
            // wtm finishes.
            const mainCmd = `while [ ! -d ${tq(wtPath)} ]; do sleep 0.2; done; cd ${tq(wtPath)}; ${claudeFragment}`;
            await control.sendCommand(
              `new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(expandedDir)} ${tq(mainCmd)}`,
            );
            // Setup (right) pane runs wtm and exits on success — no trailing
            // `exec $SHELL` so the pane auto-closes. On failure we drop to a
            // shell so the user can see the error (without this, the pane
            // would vanish and the main pane would wait forever for a worktree
            // that never gets created). `-d` keeps focus on claude; `-l 30%`
            // makes setup narrow and leaves claude with ~70%.
            const setupCmd = `wtm create ${session} --from ${baseBranch} --no-shell || exec $SHELL`;
            await control.sendCommand(
              `split-window -h -d -l 30% -t ${tq(session)} -c ${tq(expandedDir)} ${tq(setupCmd)}`,
            );
          } else {
            Bun.spawnSync(["git", "checkout", "-b", branchName, baseBranch], { cwd: expandedDir, stdout: "ignore", stderr: "ignore" });
            await control.sendCommand(
              `new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(expandedDir)} ${tq(claudeFragment)}`,
            );
          }

          await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(session)}`);
          sessionState.addLink(session, { type: "issue", id: issue.id });
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
        return;
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
        ? transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates())
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
      const listRows = Math.max(3, Math.floor((dpRows - 2 - 1) * 0.5));

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
      const listRows = Math.max(3, Math.floor((dpRows - 2 - 1) * 0.5));
      if (row >= listRows) return; // click was in detail area — ignore
      // row is relative to panel content (after toolbar row)
      const nodeIndex = row + viewState.scrollOffset;
      if (nodeIndex >= 0) {
        const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
        const ctx = pollCoordinator.getContext(sessionName);
        const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
        const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);
        let rawItems = view.source === "issues"
          ? transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates())
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
        ? transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates())
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
  inputRouter.setModalOpen(false);
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

  // Dynamic: collapse/expand groups
  for (const group of sidebar.getGroups()) {
    commands.push({
      id: `toggle-group:${group.label}`,
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

  commands.push({
    id: "setting-wtm",
    label: `wtm integration: ${cfg.wtmIntegration !== false ? "on" : "off"}`,
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
    label: `Default base branch: ${wf?.defaultBaseBranch ?? "main"}`,
    category: "setting",
  });
  commands.push({
    id: "setting-team-repo-map",
    label: `Team → repo mappings (${Object.keys(wf?.teamRepoMap ?? {}).length})`,
    category: "setting",
  });
  commands.push({
    id: "setting-session-template",
    label: `Session name template: ${wf?.sessionNameTemplate ?? "{identifier}"}`,
    category: "setting",
  });
  commands.push({
    id: "setting-auto-worktree",
    label: `Auto-create worktree: ${wf?.autoCreateWorktree !== false ? "on" : "off"}`,
    category: "setting",
  });
  commands.push({
    id: "setting-auto-agent",
    label: `Auto-launch agent: ${wf?.autoLaunchAgent !== false ? "on" : "off"}`,
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

  return commands;
}

function currentStateColorName(state: AgentState): string {
  return configStore.config.stateColors?.[state] ?? DEFAULT_STATE_COLORS[state];
}

function persistStateColor(state: AgentState, name: string): void {
  configStore.set("stateColors", { ...configStore.config.stateColors, [state]: name });
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
      label: "Adapters",
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
        {
          id: "claude-command", label: "Claude command", type: "text" as const,
          getValue: () => claudeCommand,
          onTextCommit: (v) => { claudeCommand = v; configStore.set("claudeCommand", v); },
        },
      ],
    },
    {
      label: "Issue Workflow",
      collapsed: false,
      settings: [
        {
          id: "default-branch", label: "Default base branch", type: "text" as const,
          getValue: () => wf()?.defaultBaseBranch ?? "main",
          onTextCommit: (v) => configStore.setWorkflow("defaultBaseBranch", v),
        },
        {
          id: "session-template", label: "Session name template", type: "text" as const,
          getValue: () => wf()?.sessionNameTemplate ?? "{identifier}",
          onTextCommit: (v) => configStore.setWorkflow("sessionNameTemplate", v),
        },
        {
          id: "auto-worktree", label: "Auto-create worktree", type: "boolean" as const,
          getValue: () => wf()?.autoCreateWorktree !== false ? "on" : "off",
          onToggle: () => configStore.setWorkflow("autoCreateWorktree", wf()?.autoCreateWorktree === false),
        },
        {
          id: "auto-agent", label: "Auto-launch agent", type: "boolean" as const,
          getValue: () => wf()?.autoLaunchAgent !== false ? "on" : "off",
          onToggle: () => configStore.setWorkflow("autoLaunchAgent", wf()?.autoLaunchAgent === false),
        },
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
  ];
}

function toggleSettingsScreen(): void {
  if (settingsScreen.isOpen) {
    settingsScreen.close();
    inputRouter.setModalOpen(false);
  } else {
    settingsScreen.open(buildSettingsCategories());
    inputRouter.setModalOpen(true);
  }
  scheduleRender();
}

function handleSettingsInput(data: string): void {
  settingsScreen.handleInput(data);

  if (!settingsScreen.isOpen) {
    inputRouter.setModalOpen(false);
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
    const template = workflow?.sessionNameTemplate ?? "{identifier}";
    branchName = template
      .replace("{identifier}", issue.identifier.toLowerCase())
      .replace("{title}", issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));
  }
  return sanitizeTmuxSessionName(branchName);
}

function getIssueSessionStates(): Map<string, IssueSessionInfo> {
  const states = new Map<string, IssueSessionInfo>();
  const workflow = configStore.config.issueWorkflow;
  const sessionNames = new Set(currentSessions.map((s) => s.name));
  const currentName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";

  // Build a reverse index from sessionState: issue id -> live session name.
  // An explicit link (set via the L key) wins over the workflow-derived name
  // so that re-linking an issue to a different session is honoured by `n`.
  // If multiple live sessions claim the same issue, prefer the current session.
  const explicitLinks = new Map<string, string>();
  for (const sessionName of sessionNames) {
    for (const id of sessionState.getLinkedIssueIds(sessionName)) {
      const existing = explicitLinks.get(id);
      if (!existing || sessionName === currentName) {
        explicitLinks.set(id, sessionName);
      }
    }
  }

  for (const issue of pollCoordinator.getGlobalIssues()) {
    const explicit = explicitLinks.get(issue.id);
    if (explicit) {
      states.set(issue.id, { state: "session", sessionName: explicit });
      continue;
    }

    if (!workflow?.teamRepoMap) continue;
    const session = resolveIssueSessionName(issue);
    if (!session) continue;

    if (sessionNames.has(session)) {
      states.set(issue.id, { state: "session", sessionName: session });
    } else {
      const repoDir = workflow.teamRepoMap[issue.team ?? ""];
      if (repoDir) {
        const expandedDir = repoDir.replace("~", homedir());
        const wtPath = `${expandedDir}/${session}`;
        if (existsSync(wtPath)) {
          states.set(issue.id, { state: "worktree", sessionName: session });
        }
      }
    }
  }
  return states;
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

    const rawItems = transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates());
    const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.kind === "item" && node.item.type === "issue" && linkedIssueIds.has(node.item.id)) {
        viewState.selectedIndex = i;
        viewState.detailScrollOffset = 0;
        // Ensure visible
        const dpRows = layout.ptyRows;
        const listRows = Math.max(3, Math.floor((dpRows - 2 - 1) * 0.5));
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

  // Dynamic: toggle sidebar group
  if (commandId.startsWith("toggle-group:")) {
    const label = commandId.slice("toggle-group:".length);
    sidebar.toggleGroup(label);
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
              const cmd = `wtm create ${session} --from ${result.baseBranch} --no-shell; cd ${session}; exec $SHELL`;
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
      const current = configStore.config.wtmIntegration !== false;
      configStore.set("wtmIntegration", !current);
      return;
    }
    case "setting-claude-command": {
      const current = configStore.config.claudeCommand ?? "claude";
      const modal = new InputModal({
        header: "Claude Command",
        subheader: "Command to launch Claude Code from toolbar",
        value: current,
      });
      modal.open();
      openModal(modal, async (value) => {
        configStore.set("claudeCommand", value as string);
      });
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
      const current = configStore.config.issueWorkflow?.defaultBaseBranch ?? "main";
      const modal = new InputModal({
        header: "Default Base Branch",
        subheader: "Branch to create worktrees from",
        value: current,
      });
      modal.open();
      openModal(modal, async (value) => {
        configStore.setWorkflow("defaultBaseBranch", value as string);
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
      const current = configStore.config.issueWorkflow?.sessionNameTemplate ?? "{identifier}";
      const modal = new InputModal({
        header: "Session Name Template",
        subheader: "Variables: {identifier}, {title}",
        value: current,
      });
      modal.open();
      openModal(modal, async (value) => {
        configStore.setWorkflow("sessionNameTemplate", value as string);
      });
      return;
    }
    case "setting-auto-worktree": {
      const current = configStore.config.issueWorkflow?.autoCreateWorktree !== false;
      configStore.setWorkflow("autoCreateWorktree", !current);
      return;
    }
    case "setting-auto-agent": {
      const current = configStore.config.issueWorkflow?.autoLaunchAgent !== false;
      configStore.setWorkflow("autoLaunchAgent", !current);
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
      await control.sendCommand(`split-window -t ${ptyClientName} -h -c '#{pane_current_path}' ${claudeCommand}`);
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
  relayout();
  if (inGlass) resizeGlass();
});

// --- Config file watcher ---

let configWatcher: ReturnType<typeof import("fs").watch> | null = null;
try {
  const { watch } = await import("fs");
  configWatcher = watch(configStore.configPath, () => {
    const updated = configStore.reload();
    const newWidth = updated.sidebarWidth || 26;
    const newClaudeCmd = updated.claudeCommand || "claude";
    claudeCommand = newClaudeCmd;
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
        sidebar.setActiveSession(currentSessionId ?? "");
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
      sessionDetailsCache.set(session.id, { directory, gitBranch, project });
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

async function fetchAgentState(): Promise<void> {
  const result = await control.sendCommand(
    `list-sessions -f "${INTERNAL_SESSION_FILTER}" -F '#{session_id}:#{@jmux-agent-state}:#{@jmux-agent-state-since}'`,
  );
  const activeIds: string[] = [];
  for (const line of result) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon1 = trimmed.indexOf(":");
    const colon2 = trimmed.indexOf(":", colon1 + 1);
    if (colon1 < 0 || colon2 < 0) continue;
    const id = trimmed.slice(0, colon1);
    const rawState = trimmed.slice(colon1 + 1, colon2);
    const rawSince = trimmed.slice(colon2 + 1);
    activeIds.push(id);
    agentStateTracker.apply(id, rawState || null, rawSince || null);
  }
  agentStateTracker.pruneExcept(activeIds);
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
    const agentState = agentStateTracker.getState(loc.sessionId);
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
  const totalCols = layout.termCols;
  const contentCols = sidebarShown ? totalCols - layout.main.x : totalCols;
  const stripRows = stripVisibleFor(commandCenterTabs) ? STRIP_ROWS : 0;
  const contentRows = (process.stdout.rows || 24) - stripRows;
  glassView.resize(contentCols, contentRows);
}

async function enterGlass(): Promise<void> {
  ensureGlassView();
  inGlass = true;
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

  // Subscribe to per-session agent-state user options. Each subscription is a
  // space-separated list of "<session_id>=<value>" pairs across all sessions.
  await control.registerSubscription(
    "agent-state",
    1,
    "#{S:#{session_id}=#{@jmux-agent-state} }",
  );
  await control.registerSubscription(
    "agent-state-since",
    1,
    "#{S:#{session_id}=#{@jmux-agent-state-since} }",
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
