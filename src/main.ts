import { $ } from "bun";
import { TmuxPty } from "./tmux-pty";
import { ScreenBridge } from "./screen-bridge";
import { Renderer, getToolbarButtonRanges, getToolbarTabRanges, getPalettePosition, type ToolbarConfig } from "./renderer";
import { InputRouter } from "./input-router";
import { Sidebar } from "./sidebar";
import { CommandPalette } from "./command-palette";
import { TmuxControl, type ControlEvent } from "./tmux-control";
import type { SessionInfo, WindowTab, PaletteCommand, PaletteResult } from "./types";
import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";

// --- CLI commands (run and exit before TUI) ---

const VERSION = "0.8.0";

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
  Ctrl-a j                 Window picker (fzf)
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
async function preflight(): Promise<void> {
  const missing: string[] = [];
  if (Bun.spawnSync(["tmux", "-V"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) {
    missing.push("tmux");
  }
  if (Bun.spawnSync(["fzf", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode !== 0) {
    missing.push("fzf");
  }
  if (missing.length === 0) return;

  const isMac = process.platform === "darwin";
  const hasBrew = isMac && Bun.spawnSync(["brew", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  const hasApt = !isMac && Bun.spawnSync(["apt", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;

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
      const args = hasBrew
        ? ["brew", "install", ...missing]
        : ["sudo", "apt", "install", "-y", ...missing];
      const result = Bun.spawnSync(args, { stdout: "inherit", stderr: "inherit" });
      if (result.exitCode !== 0) {
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
const control = new TmuxControl();

let currentSessionId: string | null = null;
let ptyClientName: string | null = null;
let sidebarShown = sidebarVisible;
let currentSessions: SessionInfo[] = [];

sidebar.setVersion(VERSION);
const lastViewedTimestamps = new Map<string, number>();
const sessionDetailsCache = new Map<string, { directory?: string; gitBranch?: string; project?: string }>();

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
  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  const tb = toolbarEnabled ? makeToolbar() : null;
  let paletteGrid: import("./types").CellGrid | null = null;
  let paletteCursor: { row: number; col: number } | null = null;
  if (palette.isOpen()) {
    const ptyRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
    const paletteWidth = Math.min(Math.max(40, Math.round(mainCols * 0.7)), 80);
    paletteGrid = palette.getGrid(paletteWidth);
    const pos = getPalettePosition(mainCols, ptyRows, paletteWidth, paletteGrid.rows, toolbarEnabled ? 1 : 0);
    paletteCursor = { row: pos.startRow, col: pos.startCol + palette.getCursorCol() };
  }
  renderer.render(
    grid, cursor,
    sidebarShown ? sidebar.getGrid() : null,
    tb,
    paletteGrid,
    paletteCursor,
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
    onPaletteInput: (data) => {
      if (!palette.isOpen()) return;
      const action = palette.handleInput(data);
      switch (action.type) {
        case "consumed":
          scheduleRender();
          break;
        case "closed":
          closePalette();
          break;
        case "execute":
          closePalette();
          handlePaletteAction(action.result);
          break;
      }
    },
    onSessionPrev: () => switchByOffset(-1),
    onSessionNext: () => switchByOffset(1),
  },
  sidebarShown,
);

const palette = new CommandPalette();

function togglePalette(): void {
  if (palette.isOpen()) {
    closePalette();
  } else {
    openPalette();
  }
}

function openPalette(): void {
  const commands = buildPaletteCommands();
  palette.open(commands);
  inputRouter.setPaletteOpen(true);
  renderFrame();
}

function closePalette(): void {
  palette.close();
  inputRouter.setPaletteOpen(false);
  renderFrame();
}

function buildPaletteCommands(): PaletteCommand[] {
  const commands: PaletteCommand[] = [];

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

  // Static commands
  commands.push(
    { id: "new-session", label: "New session", category: "session" },
    { id: "kill-session", label: "Kill session", category: "session" },
    { id: "rename-session", label: "Rename session", category: "session" },
    { id: "new-window", label: "New window", category: "window" },
    { id: "close-window", label: "Close window", category: "window" },
    { id: "move-window", label: "Move window to session", category: "window" },
    { id: "split-h", label: "Split horizontal", category: "pane" },
    { id: "split-v", label: "Split vertical", category: "pane" },
    { id: "zoom-pane", label: "Zoom pane", category: "pane" },
    { id: "close-pane", label: "Close pane", category: "pane" },
    { id: "window-picker", label: "Window picker", category: "other" },
    { id: "open-claude", label: "Open Claude", category: "other" },
  );

  // Settings with sub-lists
  commands.push({
    id: "setting-sidebar-width",
    label: "Sidebar width",
    category: "setting",
    sublist: [20, 22, 24, 26, 28, 30, 34].map((w) => ({
      id: String(w),
      label: String(w),
      current: w === sidebarWidth,
    })),
  });

  commands.push({
    id: "setting-claude-command",
    label: "Claude command",
    category: "setting",
    sublist: [
      { id: "claude", label: "claude", current: claudeCommand === "claude" },
      { id: "claude --dangerously-skip-permissions", label: "claude --dangerously-skip-permissions", current: claudeCommand === "claude --dangerously-skip-permissions" },
    ],
  });

  // Project directories — falls back to settings popup
  commands.push({
    id: "setting-project-dirs",
    label: "Project directories",
    category: "setting",
  });

  return commands;
}

async function applySetting(key: string, value: string | number, type: string): Promise<void> {
  const cfgPath = resolve(homedir(), ".config", "jmux", "config.json");
  try {
    let config: Record<string, any> = {};
    if (existsSync(cfgPath)) {
      config = JSON.parse(readFileSync(cfgPath, "utf-8"));
    }
    if (type === "number") {
      config[key] = typeof value === "number" ? value : parseInt(String(value), 10);
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

  // Settings with sub-list values
  if (commandId === "setting-sidebar-width" && sublistOptionId) {
    const newWidth = parseInt(sublistOptionId, 10);
    if (!isNaN(newWidth)) {
      await applySetting("sidebarWidth", newWidth, "number");
    }
    return;
  }
  if (commandId === "setting-claude-command" && sublistOptionId) {
    await applySetting("claudeCommand", sublistOptionId, "string");
    return;
  }

  // Static commands — many reuse existing handlers
  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;

  switch (commandId) {
    case "new-session":
      spawnTmuxPopup({ w: "60%", h: "70%" }, resolve(jmuxDir, "config", "new-session.sh"));
      return;
    case "kill-session":
      await control.sendCommand(`kill-session -t '${currentSessionId}'`);
      return;
    case "rename-session":
      spawnTmuxPopup({ w: "40%", h: "8" }, resolve(jmuxDir, "config", "rename-session.sh"));
      return;
    case "new-window":
      await handleToolbarAction("new-window");
      return;
    case "close-window":
      await control.sendCommand("kill-window");
      fetchWindows();
      return;
    case "move-window":
      spawnTmuxPopup({ w: "40%", h: "50%" }, resolve(jmuxDir, "config", "move-window.sh"));
      return;
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
    case "window-picker":
      spawnTmuxPopup({ w: "30%", h: "100%", x: "0", y: "0" },
        "sh", "-c", "tmux list-windows -F '#I: #W#{?window_active, *, }' | fzf --reverse --no-info --prompt=' Window> ' --pointer='▸' --color='bg:#0c1117,fg:#6b7280,hl:#fbd4b8,fg+:#b5bcc9,hl+:#fbd4b8,pointer:#9fe8c3,prompt:#9fe8c3' | cut -d: -f1 | xargs -I{} tmux select-window -t :{}");
      return;
    case "open-claude":
      await handleToolbarAction("claude");
      return;
    case "setting-project-dirs":
      spawnTmuxPopup({ w: "50%", h: "40%" }, resolve(jmuxDir, "config", "settings.sh"));
      return;
  }
}

function spawnTmuxPopup(opts: { w: string; h: string; x?: string; y?: string }, ...cmd: string[]): void {
  const args = ["tmux"];
  if (socketName) args.push("-L", socketName);
  args.push("display-popup", "-c", ptyClientName!, "-E");
  if (opts.x !== undefined) args.push("-x", opts.x);
  if (opts.y !== undefined) args.push("-y", opts.y);
  args.push("-w", opts.w, "-h", opts.h, "-b", "heavy", "-S", "fg=#4f565d", ...cmd);
  Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
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
  }

  // Non-window actions — popups need a real PTY
  switch (id) {
    case "settings":
      spawnTmuxPopup({ w: "50%", h: "40%" }, resolve(jmuxDir, "config", "settings.sh"));
      return;
    default:
      return;
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
  if (palette.isOpen()) {
    closePalette();
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
  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;
  const tag = `v${VERSION}`;
  const cmd = `${jmuxDir}/config/release-notes.sh ${tag}`;
  const termCols = process.stdout.columns || 80;
  const termRows = process.stdout.rows || 24;
  const popupW = Math.max(40, Math.round(termCols * 0.7));
  const popupH = Math.max(12, Math.round(termRows * 0.8));
  const args = ["tmux"];
  if (socketName) args.push("-L", socketName);
  args.push("display-popup", "-c", ptyClientName, "-E", "-w", String(popupW), "-h", String(popupH), "-b", "heavy", "-S", "fg=#4f565d", "sh", "-c", cmd);
  Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
}

// Check for updates in the background (non-blocking)
checkForUpdates();

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
  await control.sendCommand(`set-environment -g JMUX_PID ${process.pid}`);
  await control.sendCommand(`source-file ${configFile}`);

  // Resolve client and session — retry until the PTY client registers
  await fetchSessions();
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
    if (!ptyClientName) await resolveClientName();
    if (ptyClientName) {
      const welcomeScript = resolve(jmuxDir, "config", "welcome.sh");
      const args = ["tmux"];
      if (socketName) args.push("-L", socketName);
      args.push("display-popup", "-c", ptyClientName, "-E", "-w", "55%", "-h", "60%", "-b", "heavy", "-S", "fg=#4f565d", welcomeScript);
      Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    }
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
process.on("SIGUSR1", () => {
  togglePalette();
});

// --- Go ---

start().catch(() => cleanup());
