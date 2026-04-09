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
  sanitizeTmuxSessionName,
  type NewSessionResult,
  type NewSessionProviders,
} from "./new-session-modal";
import type { CellAttrs } from "./cell-grid";
import type { Modal } from "./modal";
import { MODAL_BG } from "./modal";
import { TmuxControl, type ControlEvent } from "./tmux-control";
import type { SessionInfo, WindowTab, PaletteCommand, PaletteResult } from "./types";
import { loadProjectDirsCache, saveProjectDirsCache } from "./project-dirs-cache";
import { OtelReceiver } from "./otel-receiver";
import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";

// --- CLI commands (run and exit before TUI) ---

const VERSION = "0.9.7";

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
  --install-agent-hooks    Install Claude Code attention flag hooks
  -v, --version            Show version
  -h, --help               Show this help

Examples:
  jmux                     Start with default session
  jmux my-project          Start with named session
  jmux -L work             Use isolated tmux server
  jmux --install-agent-hooks  Set up Claude Code integration

Keybindings:
  Ctrl-Shift-Up/Down       Switch sessions
  Ctrl-a n                 New session / worktree
  Ctrl-a c                 New window
  Ctrl-a z                 Toggle pane zoom
  Ctrl-a Arrows            Resize panes
  Ctrl-a p                 Command palette
  Ctrl-a i                 Settings
  Click sidebar            Switch to session

https://github.com/jarredkenny/jmux`;

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

// Read sidebar width from user config, fall back to default
function loadUserConfig(): Record<string, any> {
  const configPath = resolve(homedir(), ".config", "jmux", "config.json");
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, "utf-8"));
    }
  } catch {
    // Invalid config — use defaults
  }
  return {};
}
const userConfig = loadUserConfig();
let sidebarWidth = (userConfig.sidebarWidth as number) || 26;
const BORDER_WIDTH = 1;
function sidebarTotal(): number { return sidebarWidth + BORDER_WIDTH; }
const toolbarEnabled = true;
let claudeCommand = (userConfig.claudeCommand as string) || "claude";
let cacheTimersEnabled = (userConfig.cacheTimers as boolean) !== false;

// Resolve paths relative to source
const jmuxDir = resolve(dirname(import.meta.dir));
const configFile = resolve(jmuxDir, "config", "tmux.conf");

// Parse args: jmux [session] [--socket name]
let sessionName: string | undefined;
let socketName: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--socket" || arg === "-L") {
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
let startupComplete = false;

function makeToolbar(): ToolbarConfig {
  return {
    buttons: [
      { label: "＋", id: "new-window" },
      { label: "⏸", id: "split-v" },
      { label: "⏏", id: "split-h" },
      { label: "◈", id: "claude", fg: (0xE8 << 16) | (0xA0 << 8) | 0xB4, fgMode: 2 },
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
const control = new TmuxControl();

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

    // Prune cache timer state for dead sessions (keyed by name)
    const liveNames = sessions.map((s) => s.name);
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
      await control.sendCommand(`switch-client -t '${currentSessionId}'`);
    } catch { /* non-critical */ }
  }
}

async function switchSession(sessionId: string): Promise<void> {
  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;

  try {
    await control.sendCommand(
      `switch-client -c ${ptyClientName} -t '${sessionId}'`,
    );
    currentSessionId = sessionId;
    sidebar.setActiveSession(sessionId);
    sidebar.scrollToActive();
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
  renderer.render(
    grid, cursor,
    sidebarShown ? sidebar.getGrid() : null,
    tb,
    modalGrid,
    modalCursorPos,
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
    control.sendCommand(`set-option -t '${id}' -u @jmux-attention`).catch(() => {});
  }
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
    onModalInput: (data) => {
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

  let settings: Record<string, any> = {};
  try {
    const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
    if (existsSync(cfgPath)) settings = JSON.parse(readFileSync(cfgPath, "utf-8"));
  } catch {}

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
  );

  // Settings
  commands.push({
    id: "setting-sidebar-width",
    label: "Sidebar width",
    category: "setting",
  });

  commands.push({
    id: "setting-wtm",
    label: `wtm integration: ${settings.wtmIntegration !== false ? "on" : "off"}`,
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
    label: `Cache timers: ${settings.cacheTimers !== false ? "on" : "off"}`,
    category: "setting",
  });

  return commands;
}

async function applySetting(key: string, value: string | number | boolean | string[], type: string): Promise<void> {
  const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
  try {
    let config: Record<string, any> = {};
    if (existsSync(cfgPath)) {
      config = JSON.parse(readFileSync(cfgPath, "utf-8"));
    }
    if (type === "number") {
      config[key] = typeof value === "number" ? value : parseInt(String(value), 10);
    } else if (type === "boolean") {
      config[key] = value;
    } else if (type === "array") {
      config[key] = value;
    } else {
      config[key] = value;
    }
    const dir = dirname(cfgPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(config, null, 2) + "\n");
  } catch {
    // Non-critical
  }
}

const projectDirsCachePath = resolve(homedir(), ".config", "jmux", "cache", "project-dirs.json");

// In-memory cache — populated from disk at startup, refreshed in background
let cachedProjectDirs: string[] = loadProjectDirsCache(projectDirsCachePath);
let projectDirsScanInFlight: Promise<string[]> | null = null;

async function scanProjectDirsAsync(): Promise<string[]> {
  const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
  let searchDirs: string[] = [];
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    searchDirs = (cfg.projectDirs ?? []).map((d: string) => d.replace("~", homedir()));
  } catch {}
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

  // Static commands — many reuse existing handlers
  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;

  switch (commandId) {
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
              await control.sendCommand(`new-session -d -e 'OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}' -s '${session}' -c '${result.dir}'`);
              await control.sendCommand(`switch-client -c ${parentClient} -t '${session}'`);
              break;
            }
            case "existing_worktree": {
              const session = sanitizeTmuxSessionName(result.branch);
              await control.sendCommand(`new-session -d -e 'OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}' -s '${session}' -c '${result.path}'`);
              await control.sendCommand(`switch-client -c ${parentClient} -t '${session}'`);
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
              await control.sendCommand(`new-session -d -e 'OTEL_RESOURCE_ATTRIBUTES=tmux_session_name=${session}' -s '${session}' -c '${result.dir}' '${cmd}'`);
              const waitCmd = `while [ ! -d '${wtPath}' ]; do sleep 0.2; done; cd '${wtPath}' && exec $SHELL`;
              await control.sendCommand(`split-window -h -d -t '${session}' -c '${result.dir}' '${waitCmd}'`);
              await control.sendCommand(`select-pane -t '${session}.0'`);
              await control.sendCommand(`switch-client -c ${parentClient} -t '${session}'`);
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
      await control.sendCommand(`kill-session -t '${currentSessionId}'`);
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
        await control.sendCommand(`rename-session -t '${currentSessionId}' '${name}'`);
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
        await control.sendCommand(`rename-window '${name}'`);
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
        await control.sendCommand(`move-window -t '${selected.label}:'`);
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
          await applySetting("sidebarWidth", newWidth, "number");
        }
      });
      return;
    }
    case "setting-wtm": {
      let wtmSettings: Record<string, any> = {};
      try {
        const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
        if (existsSync(cfgPath)) wtmSettings = JSON.parse(readFileSync(cfgPath, "utf-8"));
      } catch {}
      const current = wtmSettings.wtmIntegration !== false;
      await applySetting("wtmIntegration", !current, "boolean");
      return;
    }
    case "setting-claude-command": {
      let current = "claude";
      try {
        const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
          current = cfg.claudeCommand ?? "claude";
        }
      } catch {}
      const modal = new InputModal({
        header: "Claude Command",
        subheader: "Command to launch Claude Code from toolbar",
        value: current,
      });
      modal.open();
      openModal(modal, async (value) => {
        await applySetting("claudeCommand", value as string, "string");
      });
      return;
    }
    case "setting-project-dirs": {
      let dirs: string[] = [];
      try {
        const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
        if (existsSync(cfgPath)) {
          const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
          dirs = cfg.projectDirs ?? [];
        }
      } catch {}
      if (dirs.length === 0) dirs = ["~/Code", "~/Projects", "~/src", "~/work", "~/dev"];
      const modal = new InputModal({
        header: "Project Directories",
        subheader: "Comma-separated list of directories to search",
        value: dirs.join(", "),
      });
      modal.open();
      openModal(modal, async (value) => {
        const newDirs = (value as string).split(",").map(s => s.trim()).filter(Boolean);
        await applySetting("projectDirs", newDirs, "array");
      });
      return;
    }
    case "setting-cache-timers": {
      let ctSettings: Record<string, any> = {};
      try {
        const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
        if (existsSync(cfgPath)) ctSettings = JSON.parse(readFileSync(cfgPath, "utf-8"));
      } catch {}
      const current = ctSettings.cacheTimers !== false;
      await applySetting("cacheTimers", !current, "boolean");
      return;
    }
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
  const newMainCols = newSidebarVisible ? newCols - sidebarTotal() : newCols;
  const newPtyRows = toolbarEnabled ? newRows - 1 : newRows;

  mainCols = newMainCols;
  sidebarShown = newSidebarVisible;
  inputRouter.setSidebarVisible(newSidebarVisible);
  pty.resize(newMainCols, newPtyRows);
  bridge.resize(newMainCols, newPtyRows);
  sidebar.resize(sidebarWidth, newRows);
  renderFrame();
});

// --- Config file watcher ---

const configPath = resolve(homedir(), ".config", "jmux", "config.json");
try {
  const { watch } = await import("fs");
  watch(configPath, () => {
    const updated = loadUserConfig();
    const newWidth = (updated.sidebarWidth as number) || 26;
    const newClaudeCmd = (updated.claudeCommand as string) || "claude";
    claudeCommand = newClaudeCmd;
    const newCacheTimers = (updated.cacheTimers as boolean) !== false;
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
    case "session-renamed":
      if (!startupComplete) return;
      fetchSessions();
      fetchWindows();
      break;
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
      `set-environment -t '${session.name}' OTEL_RESOURCE_ATTRIBUTES 'tmux_session_name=${session.name}'`,
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
  const configDir = resolve(homedir(), ".config", "jmux");
  const configPath = resolve(configDir, "config.json");
  if (!existsSync(configPath)) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({}, null, 2) + "\n");

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
  otelReceiver.stop();
  stopCacheTimerTick();
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
  process.exit(0);
}

pty.onExit(() => cleanup());
process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());

// --- Go ---

start().catch(() => cleanup());
