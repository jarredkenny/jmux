import { $ } from "bun";
import { TmuxPty } from "./tmux-pty";
import { ScreenBridge } from "./screen-bridge";
import { Renderer } from "./renderer";
import { InputRouter } from "./input-router";
import { Sidebar } from "./sidebar";
import { TmuxControl, type ControlEvent } from "./tmux-control";
import type { SessionInfo } from "./types";

const SIDEBAR_WIDTH = 24;
const BORDER_WIDTH = 1;
const SIDEBAR_TOTAL = SIDEBAR_WIDTH + BORDER_WIDTH;

const sessionName = process.argv[2] || undefined;
const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;
const sidebarVisible = cols >= 80;
const mainCols = sidebarVisible ? cols - SIDEBAR_TOTAL : cols;

// Enter alternate screen, raw mode
process.stdout.write("\x1b[?1049h");
process.stdout.write("\x1b[?25l");
if (process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

// Core components
const pty = new TmuxPty({ sessionName, cols: mainCols, rows });
const bridge = new ScreenBridge(mainCols, rows);
const renderer = new Renderer();
const sidebar = new Sidebar(SIDEBAR_WIDTH, rows);
const control = new TmuxControl();

let currentSessionId: string | null = null;
let ptyClientName: string | null = null;
let sidebarShown = sidebarVisible;
const lastViewedTimestamps = new Map<string, number>();

// --- Session data helpers ---

async function fetchSessions(): Promise<void> {
  try {
    const lines = await control.sendCommand(
      "list-sessions -F '#{session_id}:#{session_name}:#{session_activity}:#{session_attached}'",
    );
    const sessions: SessionInfo[] = lines
      .filter((l) => l.length > 0)
      .map((line) => {
        const [id, name, activity, attached] = line.split(":");
        return {
          id,
          name,
          activity: parseInt(activity, 10) || 0,
          attached: attached === "1",
          attention: false,
        };
      });

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
    lookupGitBranches(sessions);
  } catch {
    // tmux server may be shutting down
  }
}

async function resolveClientName(): Promise<void> {
  try {
    const lines = await control.sendCommand(
      "list-clients -F '#{client_name}:#{client_pid}'",
    );
    const pid = pty.pid.toString();
    for (const line of lines) {
      const [name, clientPid] = line.split(":");
      if (clientPid === pid) {
        ptyClientName = name;
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

// --- Rendering ---

function renderFrame(): void {
  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  renderer.render(grid, cursor, sidebarShown ? sidebar.getGrid() : null);
}

// --- Input Router ---

const inputRouter = new InputRouter(
  {
    sidebarCols: SIDEBAR_WIDTH,
    tmuxPrefix: "\x01", // default, overridden below
    prefixTimeout: 50,
    onPtyData: (data) => pty.write(data),
    onSidebarEnter: () => {
      renderFrame(); // re-render with highlight visible
    },
    onSidebarClick: (row) => {
      const session = sidebar.getSessionByRow(row);
      if (session) switchSession(session.id);
    },
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
    inputRouter.exitSidebarMode();
  }
});

// --- PTY output pipeline ---

pty.onData((data: string) => {
  bridge.write(data).then(() => {
    renderFrame();
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

async function lookupGitBranches(sessions: SessionInfo[]): Promise<void> {
  for (const session of sessions) {
    try {
      const result =
        await $`tmux display-message -t ${session.id} -p '#{pane_current_path}'`
          .text();
      const cwd = result.trim();
      if (!cwd) continue;
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
  await control.start();

  // Resolve PTY client name
  await resolveClientName();

  // Query tmux prefix key
  try {
    const lines = await control.sendCommand("show-options -g prefix");
    if (lines.length > 0) {
      const match = lines[0].match(/prefix\s+(.*)/);
      if (match) {
        const prefixName = match[1].trim();
        // Convert tmux key name to byte (common cases)
        if (prefixName === "C-a") {
          (inputRouter as any).opts.tmuxPrefix = "\x01";
        } else if (prefixName === "C-b") {
          (inputRouter as any).opts.tmuxPrefix = "\x02";
        }
      }
    }
  } catch {
    // Default prefix stays
  }

  // Fetch initial sessions
  await fetchSessions();

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
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.exit(0);
}

pty.onExit(() => cleanup());
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

// --- Go ---

start().catch((err) => {
  process.stderr.write(`jmux startup error: ${err}\n`);
  cleanup();
});
