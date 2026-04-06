import { $ } from "bun";
import { TmuxPty } from "./tmux-pty";
import { ScreenBridge } from "./screen-bridge";
import { Renderer, getToolbarButtonRanges, type ToolbarConfig } from "./renderer";
import { InputRouter } from "./input-router";
import { Sidebar } from "./sidebar";
import { TmuxControl, type ControlEvent } from "./tmux-control";
import type { SessionInfo } from "./types";
import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";

// --- CLI commands (run and exit before TUI) ---

const VERSION = "0.7.3";

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
  Ctrl-a i                 Settings
  Ctrl-a j                 Window picker (fzf)
  Ctrl-a c                 New window
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
let toolbarEnabled = userConfig.toolbar !== false; // default on
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

// Toolbar buttons
function makeToolbar(): ToolbarConfig {
  return {
    buttons: [
      { label: "⬒", id: "split-v" },
      { label: "⬓", id: "split-h" },
      { label: "◈", id: "claude", fg: (0xE8 << 16) | (0xA0 << 8) | 0xB4, fgMode: 2 },
      { label: "⚙", id: "settings" },
    ],
    mainCols,
  };
}

// Enter alternate screen, raw mode, enable mouse tracking
process.stdout.write("\x1b[?1049h");
process.stdout.write("\x1b[?1000h"); // mouse button tracking
process.stdout.write("\x1b[?1002h"); // mouse drag tracking
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
      "list-clients -F '#{client_name}:#{client_pid}:#{client_session}'",
    );
    const pid = pty.pid.toString();
    for (const line of lines) {
      const parts = line.split(":");
      if (parts[1] === pid) {
        ptyClientName = parts[0];
        // Set the initial active session
        const clientSessionName = parts[2];
        if (clientSessionName) {
          const match = currentSessions.find((s) => s.name === clientSessionName);
          if (match) {
            currentSessionId = match.id;
            sidebar.setActiveSession(match.id);
          }
        }
        return;
      }
    }
  } catch {
    // Retry on next session switch
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
  renderer.render(grid, cursor, sidebarShown ? sidebar.getGrid() : null, tb);
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
      const ranges = getToolbarButtonRanges(tb);
      for (const { id, startCol, endCol } of ranges) {
        if (col >= startCol && col <= endCol) {
          handleToolbarAction(id);
          return;
        }
      }
    },
    onSessionPrev: () => switchByOffset(-1),
    onSessionNext: () => switchByOffset(1),
  },
  sidebarShown,
  toolbarEnabled,
);

// --- Toolbar actions ---

async function handleToolbarAction(id: string): Promise<void> {
  if (!ptyClientName) await resolveClientName();
  if (!ptyClientName) return;
  const args = ["tmux"];
  if (socketName) args.push("-L", socketName);
  switch (id) {
    case "split-v":
      args.push("split-window", "-t", ptyClientName, "-h", "-c", "#{pane_current_path}");
      break;
    case "split-h":
      args.push("split-window", "-t", ptyClientName, "-v", "-c", "#{pane_current_path}");
      break;
    case "claude":
      args.push("split-window", "-t", ptyClientName, "-h", "-c", "#{pane_current_path}", claudeCommand);
      break;
    case "settings": {
      const settingsScript = resolve(jmuxDir, "config", "settings.sh");
      args.push("display-popup", "-c", ptyClientName, "-E", "-w", "50%", "-h", "40%", "-b", "heavy", "-S", "fg=#4f565d", settingsScript);
      break;
    }
    default:
      return;
  }
  Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
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
    const newToolbar = updated.toolbar !== false;
    const newClaudeCmd = (updated.claudeCommand as string) || "claude";
    claudeCommand = newClaudeCmd;

    const needsResize = newWidth !== sidebarWidth || newToolbar !== toolbarEnabled;
    sidebarWidth = newWidth;
    toolbarEnabled = newToolbar;
    inputRouter.setToolbarEnabled(newToolbar);

    if (needsResize) {
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
      fetchSessions();
      break;
    case "session-changed":
      currentSessionId = event.args;
      sidebar.setActiveSession(event.args);
      renderFrame();
      break;
    case "client-session-changed":
      // A client (possibly our PTY client) switched sessions — re-resolve
      resolveClientName().then(() => renderFrame());
      break;
    case "subscription-changed":
      if (event.name === "attention") {
        fetchSessions();
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

  // Re-apply our config to the running server — handles the case where
  // we attached to an existing server that loaded ~/.tmux.conf
  // Set JMUX_DIR in tmux's global environment so config bindings can reference it
  await control.sendCommand(`set-environment -g JMUX_DIR ${jmuxDir}`);
  await control.sendCommand("set-environment -g JMUX 1");
  await control.sendCommand(`source-file ${configFile}`);
  // Re-enable automatic-rename on all windows — clears any application-set names
  try {
    const windowLines = await control.sendCommand(
      "list-windows -a -F '#{window_id}'"
    );
    for (const line of windowLines) {
      const winId = line.trim();
      if (winId) {
        await control.sendCommand(`set-option -w -t ${winId} automatic-rename on`);
      }
    }
  } catch {
    // Non-critical — windows will rename on next command change
  }

  // Fetch initial sessions, then resolve client name (needs sessions list)
  await fetchSessions();
  await resolveClientName();
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
}

// --- Cleanup ---

function cleanup(): void {
  control.close().catch(() => {});
  process.stdout.write("\x1b[?2004l"); // disable bracketed paste mode
  process.stdout.write("\x1b[?1000l"); // disable mouse button tracking
  process.stdout.write("\x1b[?1002l"); // disable mouse drag tracking
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
