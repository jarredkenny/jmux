import { $ } from "bun";
import { TmuxPty } from "./tmux-pty";
import { ScreenBridge } from "./screen-bridge";
import { Renderer, getToolbarButtonRanges, getToolbarTabRanges, getModalPosition, type ToolbarConfig } from "./renderer";
import { InputRouter } from "./input-router";
import { Sidebar } from "./sidebar";
import { CommandPalette } from "./command-palette";
import { InputModal } from "./input-modal";
import { ListModal, type ListItem } from "./list-modal";
import { ContentModal, type StyledLine } from "./content-modal";
import {
  NewSessionModal,
  tq,
  type NewSessionResult,
  type NewSessionProviders,
} from "./new-session-modal";
import { CreateIssueModal, type CreateIssueResult } from "./create-issue-modal";
import type { CellAttrs } from "./cell-grid";
import { createGrid } from "./cell-grid";
import type { Modal } from "./modal";
import { MODAL_BG } from "./modal";
import { TmuxControl, type ControlEvent } from "./tmux-control";
import { DiffPanel } from "./diff-panel";
import { InfoPanel } from "./info-panel";
import { parseViews, cycleGroupBy, cycleSortBy, toggleSortOrder, type PanelView } from "./panel-view";
import { transformIssues, transformMrs, buildViewNodes, renderView, createViewState, type ViewState, type ViewNode, type IssueSessionState } from "./panel-view-renderer";
import { createAdapters } from "./adapters/registry";
import { PollCoordinator } from "./adapters/poll-coordinator";
import { SessionState } from "./session-state";
import type { SessionContext } from "./adapters/types";
import type { DemoContext } from "./demo/setup";
import type { SessionInfo, WindowTab, PaletteCommand, PaletteResult } from "./types";
import { loadProjectDirsCache, saveProjectDirsCache } from "./project-dirs-cache";
import { ConfigStore, sanitizeTmuxSessionName } from "./config";
import { OtelReceiver } from "./otel-receiver";
import { logError } from "./log";
import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";

// --- CLI commands (run and exit before TUI) ---

const VERSION = "0.13.0";

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

  // Ensure .claude directory exists
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Read existing settings or start fresh
  let settings: Record<string, any> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch {
      console.error("Error: could not parse ~/.claude/settings.json");
      process.exit(1);
    }
  }

  // Check if hook already exists
  const stopHooks = settings.hooks?.Stop;
  if (stopHooks) {
    const alreadyInstalled = stopHooks.some((entry: any) =>
      entry.hooks?.some((h: any) => h.command?.includes("@jmux-attention")),
    );
    if (alreadyInstalled) {
      console.log("jmux agent hooks are already installed.");
      return;
    }
  }

  // Add the hook
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.Stop) settings.hooks.Stop = [];

  settings.hooks.Stop.push({
    hooks: [
      {
        type: "command",
        command: "tmux set-option @jmux-attention 1 2>/dev/null || true",
        timeout: 5,
      },
    ],
  });

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log("Installed jmux agent hooks in ~/.claude/settings.json");
  console.log("");
  console.log("When Claude Code finishes a response, your jmux sidebar");
  console.log("will show an orange ! on that session.");
}

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
function sidebarTotal(): number { return sidebarWidth + BORDER_WIDTH; }
const toolbarEnabled = true;
let claudeCommand = configStore.config.claudeCommand || "claude";
let cacheTimersEnabled = configStore.config.cacheTimers !== false;
let pinnedSessions = new Set<string>(configStore.config.pinnedSessions ?? []);
let diffPanelSplitRatio = configStore.config.diffPanel?.splitRatio ?? 0.4;
let hunkCommand = configStore.config.diffPanel?.hunkCommand ?? "hunk";

// Resolve paths relative to source
const jmuxDir = resolve(dirname(import.meta.dir));
const configFile = resolve(jmuxDir, "config", "tmux.conf");

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
const sidebarVisible = cols >= 80;
let mainCols = sidebarVisible ? cols - sidebarTotal() : cols;
const ptyRows = toolbarEnabled ? rows - 1 : rows;

// Toolbar buttons and window tabs
let hoveredToolbarButton: string | null = null;
let currentWindows: WindowTab[] = [];
let hoveredTabId: string | null = null;
let hoveredPanelTabId: string | null = null;
let startupComplete = false;

function makeToolbar(): ToolbarConfig {
  return {
    buttons: [
      { label: "◈", id: "panel", fg: diffPanel.isActive() ? ((0xF0 << 16) | (0x88 << 8) | 0x3E) : undefined, fgMode: diffPanel.isActive() ? 2 : undefined },
      { label: "＋", id: "new-window" },
      { label: "⏸", id: "split-v" },
      { label: "⏏", id: "split-h" },
      { label: "λ", id: "claude", fg: (0xE8 << 16) | (0xA0 << 8) | 0xB4, fgMode: 2 },
      { label: "⚙", id: "settings" },
    ],
    mainCols,
    hoveredButton: hoveredToolbarButton,
    tabs: currentWindows,
    hoveredTabId,
  };
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
process.stdin.resume();

// Core components
const pty = new TmuxPty({ sessionName, socketName, configFile, jmuxDir, cols: mainCols, rows: ptyRows });
const bridge = new ScreenBridge(mainCols, ptyRows);
const renderer = new Renderer();
const sidebar = new Sidebar(sidebarWidth, rows);
const otelReceiver = new OtelReceiver();
sidebar.cacheTimersEnabled = cacheTimersEnabled;
sidebar.setPinnedSessions(pinnedSessions);
const control = new TmuxControl();
const diffPanel = new DiffPanel();
let diffBridge: ScreenBridge | null = null;
let diffPty: import("bun-pty").Terminal | null = null;
let diffPanelFocused = false;
const settingsScreen = new SettingsScreen();

import { SettingsScreen, type SettingDef, type SettingsCategory, type SettingsAction } from "./settings-screen";

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

const sessionStatePath = demoCtx?.statePath ?? resolve(homedir(), ".config", "jmux", "state.json");
const sessionState = new SessionState(sessionStatePath);

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
  inputRouter.setDiffPanel(getDiffPanelCols(), focused);
  // Dim/undim the tmux active pane to visually show focus has moved
  if (focused) {
    control.sendCommand("select-pane -P 'fg=#6b7280'").catch(() => {});
  } else {
    control.sendCommand("select-pane -P ''").catch(() => {});
  }
  scheduleRender();
}

let currentSessionId: string | null = null;
let ptyClientName: string | null = null;
let sidebarShown = sidebarVisible;
let currentSessions: SessionInfo[] = [];

sidebar.setVersion(VERSION);
const lastViewedTimestamps = new Map<string, number>();
const sessionDetailsCache = new Map<string, { directory?: string; gitBranch?: string; project?: string }>();

let cacheTimerInterval: ReturnType<typeof setInterval> | null = null;

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
  const state = otelReceiver.getTimerState(sessionName);
  sidebar.setCacheTimer(session.id, state);
  startCacheTimerTick();
  scheduleRender();
};

function switchByOffset(offset: number): void {
  const ids = sidebar.getDisplayOrderIds();
  if (ids.length === 0) return;
  const currentIdx = ids.indexOf(currentSessionId ?? "");
  const base = currentIdx >= 0 ? currentIdx : 0;
  const newIdx = (base + offset + ids.length) % ids.length;
  switchSession(ids[newIdx]);
}

// --- Diff panel lifecycle ---

function getDiffPanelCols(): number {
  if (!diffPanel.isActive()) return 0;
  const totalCols = process.stdout.columns || 80;
  const sidebarCols = sidebarShown ? sidebarTotal() : 0;
  const available = totalCols - sidebarCols;
  if (diffPanel.state === "full") return available;
  return diffPanel.calcPanelCols(available, diffPanelSplitRatio);
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
    diffBridge!.write(data).then(() => scheduleRender());
  });

  pty_.onExit(() => {
    // Guard: if a newer hunk process replaced us, don't clobber its state
    if (diffPty !== pty_) return;
    diffPanel.setHunkExited(true);
    diffPty = null;
    scheduleRender();
  });
}

function resizeDiffPanel(): void {
  if (!diffPty || !diffBridge) return;
  const cols = getDiffPanelCols();
  const rows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
  diffPty.resize(cols, rows);
  diffBridge.resize(cols, rows);
}

async function toggleDiffPanel(): Promise<void> {
  const wasActive = diffPanel.isActive();
  diffPanel.toggle();

  const totalCols = process.stdout.columns || 80;
  const sidebarCols = sidebarShown ? sidebarTotal() : 0;
  const available = totalCols - sidebarCols;
  const ptyRowsNow = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);

  if (!wasActive && diffPanel.state === "split") {
    // off → split: shrink tmux, spawn hunk, focus the panel
    const panelCols = diffPanel.calcPanelCols(available, diffPanelSplitRatio);
    const newMainCols = available - panelCols - 1; // -1 for divider
    mainCols = newMainCols;
    pty.resize(newMainCols, ptyRowsNow);
    bridge.resize(newMainCols, ptyRowsNow);
    setDiffFocus(true);
    inputRouter.setMainCols(newMainCols);
    await spawnHunk(panelCols, ptyRowsNow);
  } else if (wasActive && diffPanel.state === "off") {
    // split/full → off: kill hunk, resize tmux back
    killDiffProcess();
    mainCols = available;
    setDiffFocus(false);
    inputRouter.setDiffPanel(0, false);
    inputRouter.setMainCols(available);
    pty.resize(available, ptyRowsNow);
    bridge.resize(available, ptyRowsNow);
  }

  scheduleRender();
}

async function zoomDiffPanel(): Promise<void> {
  if (!diffPanel.isActive()) return;
  diffPanel.toggleZoom();

  const totalCols = process.stdout.columns || 80;
  const sidebarCols = sidebarShown ? sidebarTotal() : 0;
  const available = totalCols - sidebarCols;
  const ptyRowsNow = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);

  if (diffPanel.state === "full") {
    // split → full: resize tmux to full width (invisible), resize hunk to full
    mainCols = available;
    pty.resize(available, ptyRowsNow);
    bridge.resize(available, ptyRowsNow);
    setDiffFocus(true);
    inputRouter.setMainCols(0);
    if (diffPty && diffBridge) {
      diffPty.resize(available, ptyRowsNow);
      diffBridge.resize(available, ptyRowsNow);
    }
  } else if (diffPanel.state === "split") {
    // full → split: shrink tmux back, resize hunk to panel width
    const panelCols = diffPanel.calcPanelCols(available, diffPanelSplitRatio);
    mainCols = available - panelCols - 1;
    pty.resize(mainCols, ptyRowsNow);
    bridge.resize(mainCols, ptyRowsNow);
    inputRouter.setDiffPanel(panelCols, diffPanelFocused);
    inputRouter.setMainCols(mainCols);
    if (diffPty && diffBridge) {
      diffPty.resize(panelCols, ptyRowsNow);
      diffBridge.resize(panelCols, ptyRowsNow);
    }
  }

  scheduleRender();
}

// --- Session data helpers ---

async function fetchSessions(): Promise<void> {
  try {
    const lines = await control.sendCommand(
      "list-sessions -F '#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}:#{@jmux-attention}'",
    );
    const sessions: SessionInfo[] = lines
      .filter((l) => l.length > 0)
      .map((line) => {
        const [id, name, activity, attached, windows, attn] = line.split(":");
        const cached = sessionDetailsCache.get(id);
        return {
          id,
          name,
          activity: parseInt(activity, 10) || 0,
          attached: attached === "1",
          attention: attn === "1",
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
    sidebar.setActiveSession(sessionId);
    sidebar.scrollToActive();
    const sessionName = currentSessions.find((s) => s.id === sessionId)?.name;
    if (sessionName) {
      pollCoordinator.setActiveSession(sessionName);
      // Auto-focus the session's linked issue in the panel
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

function renderFrame(): void {
  if (writesPending > 0) return;

  // Settings screen replaces main content
  if (settingsScreen.isOpen) {
    const sidebarGrid = sidebarShown ? sidebar.getGrid() : null;
    const totalCols = process.stdout.columns || 80;
    const contentCols = sidebarShown ? totalCols - sidebarTotal() : totalCols;
    const contentRows = process.stdout.rows || 24;
    const settingsGrid = settingsScreen.render(contentCols, contentRows);
    renderer.render(
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

  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  const tb = toolbarEnabled ? makeToolbar() : null;
  let modalGrid: import("./types").CellGrid | null = null;
  let modalCursorPos: { row: number; col: number } | null = null;
  if (activeModal?.isOpen()) {
    const termCols = process.stdout.columns || 80;
    const termRows = process.stdout.rows || 24;
    const modalWidth = activeModal.preferredWidth(termCols);
    modalGrid = activeModal.getGrid(modalWidth);
    const pos = getModalPosition(termCols, termRows, modalWidth, modalGrid.rows);
    const cursorPos = activeModal.getCursorPosition();
    if (cursorPos) {
      modalCursorPos = { row: pos.startRow + cursorPos.row, col: pos.startCol + cursorPos.col };
    }
  }
  let diffPanelArg: { grid: import("./types").CellGrid; mode: "split" | "full"; focused: boolean; tabBar?: import("./types").CellGrid } | undefined;
  if (diffPanel.isActive()) {
    const dpCols = getDiffPanelCols();
    const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);

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

        const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
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
    grid, cursor,
    sidebarShown ? sidebar.getGrid() : null,
    tb,
    modalGrid,
    modalCursorPos,
    diffPanelArg,
  );
}

function scheduleRender(): void {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderFrame();
  }, 16); // ~60fps cap
}

// --- Indicator clearing on interaction ---

function clearSessionIndicators(): void {
  if (!currentSessionId) return;
  const id = currentSessionId;

  // Only clear if there's something to clear
  const needsActivityClear = sidebar.hasActivity(id);
  const needsAttentionClear = sidebar.hasAttention(id);
  if (!needsActivityClear && !needsAttentionClear) return;

  lastViewedTimestamps.set(id, Math.floor(Date.now() / 1000));
  sidebar.setActivity(id, false);
  scheduleRender();

  if (needsAttentionClear) {
    control.sendCommand(`set-option -t ${tq(id)} -u @jmux-attention`).catch(() => {});
  }
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

const inputRouter = new InputRouter(
  {
    sidebarCols: sidebarWidth,
    onPtyData: (data) => {
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
      const session = sidebar.getSessionByRow(row);
      if (session) switchSession(session.id);
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
      infoPanel.prevTab();
      inputRouter.setPanelTabsActive(infoPanel.activeTab !== "diff");
      scheduleRender();
    },
    onPanelNextTab: () => {
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
      const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
      if (viewState.selectedIndex < nodes.length - 1) {
        viewState.selectedIndex++;
        viewState.detailScrollOffset = 0; // reset detail scroll on item change
        // Scroll list if selection goes below visible area
        const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
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
      const rawItems = view.source === "issues"
        ? transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates())
        : view.filter.scope === "reviewing"
          ? transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds)
          : transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
      const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
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
      const rawItems = transformIssues(pollCoordinator.getGlobalIssues(), new Set<string>(), getIssueSessionStates());
      const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
      const selected = nodes[viewState.selectedIndex];
      if (selected?.kind !== "item" || selected.item.type !== "issue") return;
      const issue = selected.item.raw as import("./adapters/types").Issue;
      const issueState = selected.item.issueSessionState ?? "none";

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
          // STATE 3: Session already exists → just switch
          if (issueState === "session") {
            await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(session)}`);
            return;
          }

          // STATE 2: Worktree exists but no session → create session in existing worktree
          if (issueState === "worktree") {
            const wtPath = `${expandedDir}/${session}`;
            await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(wtPath)}`);
            await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(session)}`);
            sessionState.addLink(session, { type: "issue", id: issue.id });

            // Auto-launch agent
            if (workflow?.autoLaunchAgent !== false && issue.description) {
              const prompt = `You are working on ${issue.identifier}: ${issue.title}\n\n${issue.description}\n\nStart by understanding the relevant code, then propose an approach.`;
              const tmpFile = `/tmp/jmux-prompt-${Date.now()}.md`;
              writeFileSync(tmpFile, prompt);
              const agentCmd = `${claudeCommand} --message-file ${tmpFile}; rm -f ${tmpFile}`;
              await control.sendCommand(`split-window -h -t ${tq(session)} -c ${tq(wtPath)} ${tq(agentCmd)}`);
            }
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
            const cmd = `wtm create ${session} --from ${baseBranch} --no-shell; cd ${session}; exec $SHELL`;
            await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(expandedDir)} ${tq(cmd)}`);
            const waitCmd = `while [ ! -d ${tq(wtPath)} ]; do sleep 0.2; done; cd ${tq(wtPath)} && exec $SHELL`;
            await control.sendCommand(`split-window -h -d -t ${tq(session)} -c ${tq(expandedDir)} ${tq(waitCmd)}`);
          } else {
            Bun.spawnSync(["git", "checkout", "-b", branchName, baseBranch], { cwd: expandedDir, stdout: "ignore", stderr: "ignore" });
            await control.sendCommand(`new-session -d -e ${tq(`OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}`)} -s ${tq(session)} -c ${tq(expandedDir)}`);
          }

          await control.sendCommand(`switch-client -c ${ptyClientName} -t ${tq(session)}`);
          sessionState.addLink(session, { type: "issue", id: issue.id });

          // Auto-launch agent
          if (workflow?.autoLaunchAgent !== false && issue.description) {
            const prompt = `You are working on ${issue.identifier}: ${issue.title}\n\n${issue.description}\n\nStart by understanding the relevant code, then propose an approach.`;
            const tmpFile = `/tmp/jmux-prompt-${Date.now()}.md`;
            writeFileSync(tmpFile, prompt);
            const wtPath = isBare ? `${expandedDir}/${session}` : expandedDir;
            const agentCmd = `${claudeCommand} --message-file ${tmpFile}; rm -f ${tmpFile}`;
            await control.sendCommand(`split-window -h -t ${tq(session)} -c ${tq(wtPath)} ${tq(agentCmd)}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const lines: StyledLine[] = [
            [],
            [{ text: `Failed to create session for ${issue.identifier}`, attrs: { fg: 1, fgMode: 1, bg: MODAL_BG, bgMode: 2 } }],
            [],
            [{ text: message, attrs: { fg: 8, fgMode: 1, dim: true, bg: MODAL_BG, bgMode: 2 } }],
            [],
            [{ text: "Press q or Esc to close.", attrs: { fg: 8, fgMode: 1, dim: true, bg: MODAL_BG, bgMode: 2 } }],
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
      const rawItems = view.source === "issues"
        ? transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates())
        : view.filter.scope === "reviewing"
          ? transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds)
          : transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
      const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
      const selected = nodes[viewState.selectedIndex];
      if (selected?.kind !== "item") return;
      if (!sessionName) return;
      if (selected.item.type === "issue") {
        sessionState.addLink(sessionName, { type: "issue", id: selected.item.id });
      } else {
        sessionState.addLink(sessionName, { type: "mr", id: selected.item.id });
      }
      pollCoordinator.setActiveSession(sessionName);
      scheduleRender();
    },
    onPanelScroll: (delta, row) => {
      const view = panelViews.find((v) => v.id === infoPanel.activeTab);
      if (!view) return;
      const viewState = viewStates.get(view.id);
      if (!viewState) return;

      // Determine if scroll is in list area or detail area
      const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
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
      const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
      const listRows = Math.max(3, Math.floor((dpRows - 2 - 1) * 0.5));
      if (row >= listRows) return; // click was in detail area — ignore
      // row is relative to panel content (after toolbar row)
      const nodeIndex = row + viewState.scrollOffset;
      if (nodeIndex >= 0) {
        const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
        const ctx = pollCoordinator.getContext(sessionName);
        const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
        const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);
        const rawItems = view.source === "issues"
          ? transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates())
          : view.filter.scope === "reviewing"
            ? transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds)
            : transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
        const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
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

      // Create issue — doesn't require a selected item
      if (key === "c" && view.source === "issues" && adapters.issueTracker?.authState === "ok") {
        openCreateIssueModal();
        return;
      }

      const viewState = viewStates.get(view.id);
      if (!viewState) return;
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
      const linkedMrIds = new Set(ctx?.mrs.map((m) => m.id) ?? []);
      const rawItems = view.source === "issues"
        ? transformIssues(pollCoordinator.getGlobalIssues(), linkedIssueIds, getIssueSessionStates())
        : view.filter.scope === "reviewing"
          ? transformMrs(pollCoordinator.getGlobalReviewMrs(), linkedMrIds)
          : transformMrs(pollCoordinator.getGlobalMrs(), linkedMrIds);
      const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
      const selected = nodes[viewState.selectedIndex];
      if (selected?.kind !== "item") return;

      if (selected.item.type === "mr" && adapters.codeHost) {
        const mr = selected.item.raw as import("./adapters/types").MergeRequest;
        if (key === "o") adapters.codeHost.openInBrowser(mr.id);
        if (key === "r") adapters.codeHost.markReady(mr.id).then(() => { pollCoordinator.refreshGlobalItem("mr", mr.id); scheduleRender(); });
        if (key === "a") adapters.codeHost.approve(mr.id).then(() => { pollCoordinator.refreshGlobalItem("mr", mr.id); scheduleRender(); });
      }
      if (selected.item.type === "issue" && adapters.issueTracker) {
        const issue = selected.item.raw as import("./adapters/types").Issue;
        if (key === "o") adapters.issueTracker.openInBrowser(issue.id);
        if (key === "y") {
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
                adapters.issueTracker!.updateStatus(issue.id, sel.id).then(() => { pollCoordinator.refreshGlobalItem("issue", issue.id); scheduleRender(); });
              }
            });
          });
        }
      }
    },
  },
  sidebarShown,
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
    [{ text: message, attrs: { fg: 1, fgMode: 1, bg: MODAL_BG, bgMode: 2 } }],
    [],
    [{ text: hint, attrs: { fg: 8, fgMode: 1, dim: true, bg: MODAL_BG, bgMode: 2 } }],
    [],
    [{ text: "Press q or Esc to close.", attrs: { fg: 8, fgMode: 1, dim: true, bg: MODAL_BG, bgMode: 2 } }],
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
          id: "cache-timers", label: "Cache timers", type: "boolean" as const,
          getValue: () => cacheTimersEnabled ? "on" : "off",
          onToggle: () => {
            cacheTimersEnabled = !cacheTimersEnabled;
            sidebar.cacheTimersEnabled = cacheTimersEnabled;
            configStore.set("cacheTimers", cacheTimersEnabled);
          },
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

function getIssueSessionStates(): Map<string, IssueSessionState> {
  const states = new Map<string, IssueSessionState>();
  const workflow = configStore.config.issueWorkflow;
  if (!workflow?.teamRepoMap) return states;

  const sessionNames = new Set(currentSessions.map((s) => s.name));

  for (const issue of pollCoordinator.getGlobalIssues()) {
    const session = resolveIssueSessionName(issue);
    if (!session) continue;

    if (sessionNames.has(session)) {
      states.set(issue.id, "session");
    } else {
      const repoDir = workflow.teamRepoMap[issue.team ?? ""];
      if (repoDir) {
        const expandedDir = repoDir.replace("~", homedir());
        const wtPath = `${expandedDir}/${session}`;
        if (existsSync(wtPath)) {
          states.set(issue.id, "worktree");
        }
      }
    }
  }
  return states;
}

function focusPanelOnSessionIssue(sessionName: string): void {
  // Find the first issue linked to this session
  const ctx = pollCoordinator.getContext(sessionName);
  const linkedIssueIds = new Set(ctx?.issues.map((i) => i.id) ?? []);
  if (linkedIssueIds.size === 0) return;

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
        const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
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

  // Dynamic: switch to session
  if (commandId.startsWith("switch-session:")) {
    const sessionId = commandId.slice("switch-session:".length);
    await switchSession(sessionId);
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
              pollCoordinator.setActiveSession(sName);
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
        pollCoordinator.setActiveSession(sName);
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
            sessionState.addLink(sName, { type: "mr", id: sel.id });
            pollCoordinator.setActiveSession(sName);
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
        pollCoordinator.setActiveSession(sName);
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

process.stdin.on("data", (data: Buffer) => {
  inputRouter.handleInput(data.toString());
});

// --- Resize ---

process.on("SIGWINCH", () => {
  if (activeModal) {
    closeModal();
  }
  const newCols = process.stdout.columns || 80;
  const newRows = process.stdout.rows || 24;
  const newSidebarVisible = newCols >= 80;
  const newPtyRows = toolbarEnabled ? newRows - 1 : newRows;
  const sidebarCols = newSidebarVisible ? sidebarTotal() : 0;
  const available = newCols - sidebarCols;

  sidebarShown = newSidebarVisible;
  inputRouter.setSidebarVisible(newSidebarVisible);
  sidebar.resize(sidebarWidth, newRows);

  if (diffPanel.state === "split") {
    const panelCols = diffPanel.calcPanelCols(available, diffPanelSplitRatio);
    const newMainCols = available - panelCols - 1;
    mainCols = newMainCols;
    pty.resize(newMainCols, newPtyRows);
    bridge.resize(newMainCols, newPtyRows);
    inputRouter.setDiffPanel(panelCols, diffPanelFocused);
    inputRouter.setMainCols(newMainCols);
    if (diffPty && diffBridge) {
      diffPty.resize(panelCols, newPtyRows);
      diffBridge.resize(panelCols, newPtyRows);
    }
  } else if (diffPanel.state === "full") {
    mainCols = available;
    pty.resize(available, newPtyRows);
    bridge.resize(available, newPtyRows);
    inputRouter.setDiffPanel(available, diffPanelFocused);
    inputRouter.setMainCols(available);
    if (diffPty && diffBridge) {
      diffPty.resize(available, newPtyRows);
      diffBridge.resize(available, newPtyRows);
    }
  } else {
    const newMainCols = available;
    mainCols = newMainCols;
    pty.resize(newMainCols, newPtyRows);
    bridge.resize(newMainCols, newPtyRows);
    inputRouter.setDiffPanel(0, false);
    inputRouter.setMainCols(newMainCols);
  }

  renderFrame();
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

    const needsResize = newWidth !== sidebarWidth;

    if (needsResize) {
      sidebarWidth = newWidth;
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      const newSidebarVisible = cols >= 80;
      const newMainCols = newSidebarVisible ? cols - sidebarTotal() : cols;
      const newPtyRows = toolbarEnabled ? rows - 1 : rows;

      mainCols = newMainCols;
      sidebarShown = newSidebarVisible;
      inputRouter.setSidebarVisible(newSidebarVisible);
      pty.resize(newMainCols, newPtyRows);
      bridge.resize(newMainCols, newPtyRows);
      sidebar.resize(sidebarWidth, rows);
      renderFrame();
    }

    // Hot-apply diff panel config changes
    diffPanelSplitRatio = updated.diffPanel?.splitRatio ?? 0.4;
    hunkCommand = updated.diffPanel?.hunkCommand ?? "hunk";
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

    for (const r of releases) {
      const tag = r.tag_name;
      const date = (r.published_at || "").split("T")[0];
      const name = r.name || tag;
      const isCurrent = tag === currentTag;

      if (isCurrent) {
        lines.push([
          { text: name, attrs: { fg: 2, fgMode: 1, bold: true, bg: MODAL_BG, bgMode: 2 } },
          { text: "  \u2190 current", attrs: { fg: 2, fgMode: 1, bg: MODAL_BG, bgMode: 2 } },
        ]);
      } else {
        lines.push([{ text: name, attrs: { bold: true, bg: MODAL_BG, bgMode: 2 } }]);
      }
      lines.push([{ text: date, attrs: { fg: 8, fgMode: 1, dim: true, bg: MODAL_BG, bgMode: 2 } }]);
      lines.push([]);

      const body = (r.body || "").trim();
      if (body) {
        for (const line of body.split("\n")) {
          const formatted = line.replace(/^## (.*)/, "$1").replace(/^- /, "\u2022 ");
          const isHeader = line.startsWith("## ");
          lines.push([{
            text: formatted,
            attrs: isHeader
              ? { bold: true, bg: MODAL_BG, bgMode: 2 }
              : { bg: MODAL_BG, bgMode: 2 },
          }]);
        }
        lines.push([]);
      }
      lines.push([{ text: "\u2500".repeat(40), attrs: { fg: 8, fgMode: 1, dim: true, bg: MODAL_BG, bgMode: 2 } }]);
      lines.push([]);
    }
    lines.push([{ text: "github.com/jarredkenny/jmux/releases", attrs: { fg: 8, fgMode: 1, dim: true, bg: MODAL_BG, bgMode: 2 } }]);

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
      const parts = event.args.split(" ");
      if (parts.length >= 2) {
        const oldName = parts[0];
        const newName = parts[1];
        sessionState.renameSession(oldName, newName);
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
            const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
            await spawnHunk(dpCols, dpRows);
          }
        }
        renderFrame();
      });
      break;
    case "window-add":
    case "window-close":
    case "window-renamed":
    case "session-window-changed":
      if (startupComplete) fetchWindows();
      break;
    case "subscription-changed":
      if (!startupComplete) break;
      if (event.name === "attention") {
        fetchSessions();
      } else if (event.name === "windows") {
        fetchWindows();
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
    currentWindows = lines
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
    scheduleRender();
  } catch {
    // Session may be shutting down
  }
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

  // Re-apply our config to the running server
  await control.sendCommand(`set-environment -g JMUX_DIR ${jmuxDir}`);
  await control.sendCommand("set-environment -g JMUX 1");
  await control.sendCommand(`source-file ${configFile}`);

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
  startupComplete = true;
  renderFrame();

  // First-run welcome screen
  if (configStore.ensureExists()) {

    const g: CellAttrs = { fg: 2, fgMode: 1, bg: MODAL_BG, bgMode: 2 };
    const b: CellAttrs = { bold: true, bg: MODAL_BG, bgMode: 2 };
    const d: CellAttrs = { fg: 8, fgMode: 1, dim: true, bg: MODAL_BG, bgMode: 2 };
    const n: CellAttrs = { bg: MODAL_BG, bgMode: 2 };
    const c: CellAttrs = { fg: 6, fgMode: 1, bg: MODAL_BG, bgMode: 2 };
    const y: CellAttrs = { fg: 3, fgMode: 1, bg: MODAL_BG, bgMode: 2 };

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

  // Subscribe to @jmux-attention across all sessions
  await control.registerSubscription(
    "attention",
    1,
    "#{S:#{session_id}=#{@jmux-attention} }",
  );

  // Subscribe to window count + active window + name — fires on add/remove/switch/rename
  await control.registerSubscription(
    "windows",
    1,
    "#{session_windows} #{window_index} #{window_name} #{window_zoomed_flag}",
  );
}

// --- Cleanup ---

function cleanup(): void {
  killDiffProcess();
  pollCoordinator.stop();
  otelReceiver.stop();
  stopCacheTimerTick();
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
  process.exit(0);
}

pty.onExit(() => cleanup());
process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());

// --- Go ---

start().catch(() => cleanup());
