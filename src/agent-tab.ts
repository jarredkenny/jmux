// src/agent-tab.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

// --- Input Line Editor ---

export class InputLine {
  private _text = "";
  private _cursor = 0;

  get text(): string { return this._text; }
  get cursor(): number { return this._cursor; }

  insert(chars: string): void {
    this._text = this._text.slice(0, this._cursor) + chars + this._text.slice(this._cursor);
    this._cursor += chars.length;
  }

  backspace(): void {
    if (this._cursor > 0) {
      this._text = this._text.slice(0, this._cursor - 1) + this._text.slice(this._cursor);
      this._cursor--;
    }
  }

  del(): void {
    if (this._cursor < this._text.length) {
      this._text = this._text.slice(0, this._cursor) + this._text.slice(this._cursor + 1);
    }
  }

  left(): void {
    if (this._cursor > 0) this._cursor--;
  }

  right(): void {
    if (this._cursor < this._text.length) this._cursor++;
  }

  home(): void { this._cursor = 0; }
  end(): void { this._cursor = this._text.length; }

  submit(): string {
    const text = this._text;
    this._text = "";
    this._cursor = 0;
    return text;
  }

  clear(): void {
    this._text = "";
    this._cursor = 0;
  }
}

// --- Scrollback Buffer ---

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
}

export class ScrollbackBuffer {
  private _messages: ChatMessage[] = [];

  get messages(): readonly ChatMessage[] {
    return this._messages;
  }

  addUserMessage(content: string): void {
    this._messages.push({ role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this._messages.push({ role: "assistant", content });
  }

  addToolUse(content: string): void {
    this._messages.push({ role: "tool", content });
  }

  appendToLast(text: string): void {
    if (this._messages.length > 0) {
      this._messages[this._messages.length - 1].content += text;
    }
  }

  getContextSummary(maxExchanges: number): ChatMessage[] {
    // Collect the last N user/assistant pairs (skip tool messages for context)
    const exchanges: ChatMessage[] = [];
    let count = 0;
    for (let i = this._messages.length - 1; i >= 0 && count < maxExchanges * 2; i--) {
      const msg = this._messages[i];
      if (msg.role === "user" || msg.role === "assistant") {
        exchanges.unshift(msg);
        count++;
      }
    }
    return exchanges;
  }

  renderToLines(width: number): { text: string; attrs: CellAttrs }[] {
    const lines: { text: string; attrs: CellAttrs }[] = [];
    const userAttrs: CellAttrs = { bold: true, fg: 4, fgMode: ColorMode.Palette };
    const assistantAttrs: CellAttrs = { fg: 15, fgMode: ColorMode.Palette };
    const toolAttrs: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };

    for (const msg of this._messages) {
      let prefix: string;
      let attrs: CellAttrs;
      if (msg.role === "user") {
        prefix = "you: ";
        attrs = userAttrs;
      } else if (msg.role === "assistant") {
        prefix = "";
        attrs = assistantAttrs;
      } else {
        prefix = "[tool: ";
        attrs = toolAttrs;
      }
      const suffix = msg.role === "tool" ? "]" : "";
      const fullText = prefix + msg.content + suffix;

      // Word-wrap at width
      if (fullText.length > 0) {
        let remaining = fullText;
        while (remaining.length > 0) {
          if (remaining.length <= width) {
            lines.push({ text: remaining, attrs });
            remaining = "";
          } else {
            // Find last space within width, or force-break
            let breakAt = remaining.lastIndexOf(" ", width);
            if (breakAt < 0) breakAt = width;
            lines.push({ text: remaining.slice(0, breakAt), attrs });
            remaining = remaining.slice(breakAt).trimStart();
          }
        }
        // Empty line between messages
        lines.push({ text: "", attrs: assistantAttrs });
      }
    }
    return lines;
  }
}

// --- Agent Tab State ---

export type AgentState = "idle" | "streaming" | "error";

const INPUT_PROMPT_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const INPUT_TEXT_ATTRS: CellAttrs = { fg: 15, fgMode: ColorMode.Palette };
const PLACEHOLDER_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const SPINNER_ATTRS: CellAttrs = { fg: 3, fgMode: ColorMode.Palette };

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class AgentTab {
  readonly input = new InputLine();
  readonly scrollback = new ScrollbackBuffer();
  private _state: AgentState = "idle";
  private _scrollOffset = 0; // lines scrolled up from bottom
  private _spinnerFrame = 0;

  get state(): AgentState { return this._state; }
  set state(s: AgentState) { this._state = s; }

  get scrollOffset(): number { return this._scrollOffset; }

  scrollUp(lines = 1): void {
    this._scrollOffset += lines;
  }

  scrollDown(lines = 1): void {
    this._scrollOffset = Math.max(0, this._scrollOffset - lines);
  }

  scrollToBottom(): void {
    this._scrollOffset = 0;
  }

  advanceSpinner(): void {
    this._spinnerFrame = (this._spinnerFrame + 1) % SPINNER_FRAMES.length;
  }

  render(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);

    // Reserve bottom row for input
    const scrollbackRows = rows - 1;
    const inputRow = rows - 1;

    // Render scrollback
    const allLines = this.scrollback.renderToLines(cols - 1); // 1 col left margin
    const maxOffset = Math.max(0, allLines.length - scrollbackRows);
    const clampedOffset = Math.min(this._scrollOffset, maxOffset);
    const visibleStart = Math.max(0, allLines.length - scrollbackRows - clampedOffset);
    const visibleEnd = Math.min(allLines.length, visibleStart + scrollbackRows);

    for (let i = visibleStart; i < visibleEnd; i++) {
      const row = i - visibleStart;
      const line = allLines[i];
      writeString(grid, row, 1, line.text, line.attrs);
    }

    // Render input line
    if (this._state === "streaming") {
      const spinner = SPINNER_FRAMES[this._spinnerFrame];
      writeString(grid, inputRow, 1, spinner + " thinking...", SPINNER_ATTRS);
    } else {
      writeString(grid, inputRow, 1, "▸ ", INPUT_PROMPT_ATTRS);
      if (this.input.text.length === 0) {
        writeString(grid, inputRow, 3, "type a message...", PLACEHOLDER_ATTRS);
      } else {
        writeString(grid, inputRow, 3, this.input.text, INPUT_TEXT_ATTRS);
      }
    }

    return grid;
  }
}

// --- Context and Prompt Assembly ---

export interface AgentContext {
  metaAgentSkill: string;
  workflowConfigs: { project: string; path: string; content: string }[];
  tasksSnapshot: string; // JSON string of active tasks
  sessionState: string;  // JSON string of jmux ctl session list output
}

export function assemblePrompt(
  ctx: AgentContext,
  scrollback: ScrollbackBuffer,
  userMessage: string,
  maxContextTokensEstimate = 8000,
): string {
  const parts: string[] = [];

  // 1. Meta agent skill (always included)
  if (ctx.metaAgentSkill) {
    parts.push(ctx.metaAgentSkill);
  }

  // 2. Workflow configs (only for active projects)
  if (ctx.workflowConfigs.length > 0) {
    parts.push("\n## Workflow Configs\n");
    for (const wf of ctx.workflowConfigs) {
      parts.push(`### ${wf.project} (${wf.path})\n\`\`\`yaml\n${wf.content}\n\`\`\`\n`);
    }
  }

  // 3. Task snapshot
  if (ctx.tasksSnapshot !== "{}") {
    parts.push(`\n## Active Tasks\n\`\`\`json\n${ctx.tasksSnapshot}\n\`\`\`\n`);
  }

  // 4. Session state
  parts.push(`\n## Current Sessions\n\`\`\`json\n${ctx.sessionState}\n\`\`\`\n`);

  // 5. Scrollback — truncate from oldest if over budget
  // Rough estimate: 4 chars per token
  const baseSize = parts.join("").length;
  const budgetChars = maxContextTokensEstimate * 4;
  const remainingChars = Math.max(0, budgetChars - baseSize - userMessage.length);

  const exchanges = scrollback.getContextSummary(10); // up to 10 exchanges
  if (exchanges.length > 0) {
    const msgs = [...exchanges];
    let scrollbackText = "";
    // Try to fit as many exchanges as possible, dropping oldest first
    while (msgs.length > 0) {
      const candidate = msgs.map(m =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
      ).join("\n\n");
      if (candidate.length <= remainingChars) {
        scrollbackText = candidate;
        break;
      }
      msgs.shift(); // drop oldest
    }
    if (scrollbackText) {
      parts.push(`\n## Conversation History\n${scrollbackText}\n`);
    }
  }

  // 6. User message
  parts.push(`\n## Current Request\n${userMessage}`);

  return parts.join("\n");
}
