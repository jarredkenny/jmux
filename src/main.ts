import { TmuxPty } from "./tmux-pty";
import { ScreenBridge } from "./screen-bridge";
import { Renderer } from "./renderer";
import { InputRouter } from "./input-router";

const sessionName = process.argv[2] || undefined;

const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;

// Enter alternate screen, enable raw mode
process.stdout.write("\x1b[?1049h"); // alternate screen
process.stdout.write("\x1b[?25l"); // hide cursor initially

if (process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

const pty = new TmuxPty({ sessionName, cols, rows });
const bridge = new ScreenBridge(cols, rows);
const renderer = new Renderer();

const inputRouter = new InputRouter(
  {
    sidebarCols: 0,
    tmuxPrefix: "\x01",
    prefixTimeout: 50,
    onPtyData: (data) => pty.write(data),
    onSidebarEnter: () => {},
    onSidebarClick: () => {},
  },
  false,
);

// PTY output → ScreenBridge → Renderer
pty.onData((data: string) => {
  bridge.write(data).then(() => {
    const grid = bridge.getGrid();
    const cursor = bridge.getCursor();
    renderer.render(grid, cursor, null);
  });
});

// Stdin → InputRouter → PTY
process.stdin.on("data", (data: Buffer) => {
  inputRouter.handleInput(data.toString());
});

// Handle resize
process.on("SIGWINCH", () => {
  const newCols = process.stdout.columns || 80;
  const newRows = process.stdout.rows || 24;
  pty.resize(newCols, newRows);
  bridge.resize(newCols, newRows);
});

// Clean exit
function cleanup() {
  process.stdout.write("\x1b[?25h"); // show cursor
  process.stdout.write("\x1b[?1049l"); // exit alternate screen
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.exit(0);
}

pty.onExit(() => cleanup());
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
