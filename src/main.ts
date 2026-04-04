import { $ } from "bun";
import { TmuxPty } from "./tmux-pty";
import { ScreenBridge } from "./screen-bridge";
import { Renderer } from "./renderer";
import { InputRouter } from "./input-router";
import { Sidebar } from "./sidebar";
import { TmuxControl, type ControlEvent } from "./tmux-control";
import type { SessionInfo } from "./types";
import { resolve, dirname } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";

// --- CLI commands (run and exit before TUI) ---

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

// --- TUI startup ---

const SIDEBAR_WIDTH = 24;
const BORDER_WIDTH = 1;
const SIDEBAR_TOTAL = SIDEBAR_WIDTH + BORDER_WIDTH;

// Resolve paths relative to source
const jmuxDir = resolve(dirname(import.meta.dir));
const configFile = resolve(jmuxDir, "config", "tmux.conf");

// Parse args: jmux [session] [--socket name]
let sessionName: string | undefined;
let socketName: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--socket" || process.argv[i] === "-L") {
    socketName = process.argv[++i];
  } else if (!sessionName && !process.argv[i].startsWith("-")) {
    sessionName = process.argv[i];
  }
}
const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;
const sidebarVisible = cols >= 80;
const mainCols = sidebarVisible ? cols - SIDEBAR_TOTAL : cols;

// Enter alternate screen, raw mode, enable mouse tracking
process.stdout.write("\x1b[?1049h");
process.stdout.write("\x1b[?1000h"); // mouse button tracking
process.stdout.write("\x1b[?1006h"); // SGR extended mouse mode
if (process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

// Core components
const pty = new TmuxPty({ sessionName, socketName, configFile, jmuxDir, cols: mainCols, rows });
const bridge = new ScreenBridge(mainCols, rows);
const renderer = new Renderer();
const sidebar = new Sidebar(SIDEBAR_WIDTH, rows);
const control = new TmuxControl();

let currentSessionId: string | null = null;
let ptyClientName: string | null = null;
let sidebarShown = sidebarVisible;
let overlayMode = false;
let currentSessions: SessionInfo[] = [];
const lastViewedTimestamps = new Map<string, number>();

function switchByOffset(offset: number): void {
  if (currentSessions.length === 0) return;
  const currentIdx = currentSessions.findIndex(
    (s) => s.id === currentSessionId,
  );
  const base = currentIdx >= 0 ? currentIdx : 0;
  const newIdx =
    (base + offset + currentSessions.length) % currentSessions.length;
  switchSession(currentSessions[newIdx].id);
}

// --- Session data helpers ---

async function fetchSessions(): Promise<void> {
  try {
    const lines = await control.sendCommand(
      "list-sessions -F '#{session_id}:#{session_name}:#{session_activity}:#{session_attached}:#{session_windows}'",
    );
    const sessions: SessionInfo[] = lines
      .filter((l) => l.length > 0)
      .map((line) => {
        const [id, name, activity, attached, windows] = line.split(":");
        return {
          id,
          name,
          activity: parseInt(activity, 10) || 0,
          attached: attached === "1",
          attention: false,
          windowCount: parseInt(windows, 10) || 1,
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
    lastViewedTimestamps.set(sessionId, Math.floor(Date.now() / 1000));
    sidebar.setActivity(sessionId, false);
    currentSessionId = sessionId;
    sidebar.setActiveSession(sessionId);
    renderFrame();

    // Clear attention flag if set
    try {
      await control.sendCommand(
        `set-option -t '${sessionId}' -u @jmux-attention`,
      );
    } catch {
      // Option may not be set
    }
  } catch {
    // Session may have been killed
  }
}

// --- Overlay helpers ---

function exitOverlay(): void {
  if (overlayMode) {
    overlayMode = false;
    sidebarShown = false;
    renderFrame();
  }
}

// --- Rendering ---

let renderTimer: ReturnType<typeof setTimeout> | null = null;

function renderFrame(): void {
  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  renderer.render(grid, cursor, sidebarShown ? sidebar.getGrid() : null);
}

function scheduleRender(): void {
  if (renderTimer !== null) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderFrame();
  }, 16); // ~60fps cap
}

// --- Input Router ---

const inputRouter = new InputRouter(
  {
    sidebarCols: SIDEBAR_WIDTH,
    tmuxPrefix: "\x01", // default, overridden below
    prefixTimeout: 50,
    onPtyData: (data) => pty.write(data),
    onSidebarEnter: () => {
      if (!sidebarShown) {
        overlayMode = true;
        sidebarShown = true;
      }
      sidebar.setSidebarMode(true);
      renderFrame();
    },
    onSidebarClick: (row) => {
      const session = sidebar.getSessionByRow(row);
      if (session) switchSession(session.id);
    },
    onSidebarExit: () => {
      sidebar.setSidebarMode(false);
      exitOverlay();
      renderFrame();
    },
    onSessionPrev: () => switchByOffset(-1),
    onSessionNext: () => switchByOffset(1),
  },
  sidebarShown,
);

// Sidebar keyboard handler
inputRouter.setSidebarKeyHandler((key) => {
  if (key === "\x1b[A" || key === "k") {
    // Up arrow or k
    sidebar.moveHighlight(-1);
    renderFrame();
  } else if (key === "\x1b[B" || key === "j") {
    // Down arrow or j
    sidebar.moveHighlight(1);
    renderFrame();
  } else if (key === "\r") {
    // Enter — switch to highlighted session
    const targetId = sidebar.getHighlightedSessionId();
    if (targetId) switchSession(targetId);
    sidebar.setSidebarMode(false);
    inputRouter.exitSidebarMode();
    exitOverlay();
  }
});

// --- PTY output pipeline ---

let writesPending = 0;

pty.onData((data: string) => {
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
  const newMainCols = newSidebarVisible ? newCols - SIDEBAR_TOTAL : newCols;

  sidebarShown = newSidebarVisible;
  overlayMode = false;
  inputRouter.setSidebarVisible(newSidebarVisible);
  pty.resize(newMainCols, newRows);
  bridge.resize(newMainCols, newRows);
  sidebar.resize(SIDEBAR_WIDTH, newRows);
});

// --- Control mode events ---

control.onEvent((event: ControlEvent) => {
  switch (event.type) {
    case "sessions-changed":
      fetchSessions();
      break;
    case "session-changed":
      currentSessionId = event.args;
      sidebar.setActiveSession(event.args);
      renderFrame();
      break;
    case "subscription-changed":
      if (event.name === "attention") {
        const pairs = event.value.trim().split(/\s+/);
        for (const pair of pairs) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx === -1) continue;
          const id = pair.slice(0, eqIdx);
          const val = pair.slice(eqIdx + 1);
          if (val === "1") {
            sidebar.setActivity(id, false);
          }
        }
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
      // Use control mode connection — respects -L socket and -f config
      const lines = await control.sendCommand(
        `display-message -t '${session.id}' -p '#{pane_current_path}'`,
      );
      const cwd = (lines[0] || "").trim();
      if (!cwd) continue;
      session.directory = cwd.startsWith(home)
        ? "~" + cwd.slice(home.length)
        : cwd;
      const branch = await $`git -C ${cwd} branch --show-current`
        .text()
        .catch(() => "");
      session.gitBranch = branch.trim() || undefined;
    } catch {
      // Session may not exist or no git repo
    }
  }
  sidebar.updateSessions(sessions);
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

  // Prefix is C-a — hardcoded since we ship our own tmux.conf

  // Fetch initial sessions, then resolve client name (needs sessions list)
  await fetchSessions();
  await resolveClientName();
  renderFrame();

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
  process.stdout.write("\x1b[?1000l"); // disable mouse button tracking
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
