// src/snapshot/model.ts
import type {
  SnapshotFile,
  SnapshotSession,
  SnapshotWindow,
  SnapshotPane,
  SnapshotOtel,
  SnapshotAgentState,
  SessionLink,
  SnapshotPermissionMode,
} from "./schema";
import { SNAPSHOT_FORMAT_VERSION } from "./schema";

export class SnapshotModel {
  private sessions = new Map<string, SnapshotSession>();
  private lastFocused: string | null = null;
  private socket = "";
  constructor(private readonly jmuxVersion: string) {}

  setSocket(socket: string): void {
    this.socket = socket;
  }

  setLastFocused(name: string | null): void {
    this.lastFocused = name;
  }

  upsertSession(session: SnapshotSession): void {
    this.sessions.set(session.name, session);
  }

  removeSession(name: string): void {
    this.sessions.delete(name);
    if (this.lastFocused === name) this.lastFocused = null;
  }

  hasSession(name: string): boolean {
    return this.sessions.has(name);
  }

  getSession(name: string): SnapshotSession | undefined {
    return this.sessions.get(name);
  }

  sessionNames(): string[] {
    return Array.from(this.sessions.keys());
  }

  renameSession(oldName: string, newName: string): void {
    const s = this.sessions.get(oldName);
    if (!s) return;
    this.sessions.delete(oldName);
    s.name = newName;
    this.sessions.set(newName, s);
    if (this.lastFocused === oldName) this.lastFocused = newName;
  }

  updateWindows(sessionName: string, windows: SnapshotWindow[]): void {
    const s = this.sessions.get(sessionName);
    if (!s) return;
    s.windows = windows;
  }

  setLayoutForWindow(
    sessionName: string,
    windowIndex: number,
    layout: string,
  ): void {
    const s = this.sessions.get(sessionName);
    if (!s) return;
    const w = s.windows.find((w) => w.index === windowIndex);
    if (w) w.layout = layout;
  }

  setOtel(sessionName: string, otel: SnapshotOtel | null): void {
    const s = this.sessions.get(sessionName);
    if (s) s.otel = otel;
  }

  setAgentState(
    sessionName: string,
    agentState: SnapshotAgentState | null,
  ): void {
    const s = this.sessions.get(sessionName);
    if (s) s.agentState = agentState;
  }

  setPermissionMode(
    sessionName: string,
    mode: SnapshotPermissionMode,
  ): void {
    const s = this.sessions.get(sessionName);
    if (s) s.permissionMode = mode;
  }

  setPinned(sessionName: string, pinned: boolean): void {
    const s = this.sessions.get(sessionName);
    if (s) s.pinned = pinned;
  }

  setAttention(sessionName: string, attention: boolean): void {
    const s = this.sessions.get(sessionName);
    if (s) s.attention = attention;
  }

  setLinks(sessionName: string, links: SessionLink[]): void {
    const s = this.sessions.get(sessionName);
    if (s) s.links = [...links];
  }

  setScrollbackFile(
    sessionName: string,
    windowIndex: number,
    paneIndex: number,
    file: string | null,
  ): void {
    const s = this.sessions.get(sessionName);
    if (!s) return;
    const w = s.windows.find((w) => w.index === windowIndex);
    if (!w) return;
    const p = w.panes.find((p) => p.index === paneIndex);
    if (p) p.scrollbackFile = file;
  }

  toFile(capturedAt: string): SnapshotFile {
    return {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      jmuxVersion: this.jmuxVersion,
      capturedAt,
      tmuxSocket: this.socket,
      lastFocusedSession: this.lastFocused,
      sessions: Array.from(this.sessions.values()).map((s) => ({
        ...s,
        windows: s.windows.map((w) => ({
          ...w,
          panes: w.panes.map((p) => ({ ...p })),
        })),
        links: [...s.links],
      })),
    };
  }

  static makeEmptyPane(index: number, cwd: string, command: string): SnapshotPane {
    return {
      index,
      cwd,
      command,
      kind: "other",
      scrollbackFile: null,
    };
  }

  static makeEmptyWindow(
    index: number,
    name: string,
    layout: string,
    active: boolean,
    panes: SnapshotPane[],
  ): SnapshotWindow {
    return { index, name, layout, active, panes };
  }

  static makeEmptySession(name: string, cwd: string): SnapshotSession {
    return {
      name,
      cwd,
      worktreePath: null,
      projectGroup: null,
      pinned: false,
      attention: false,
      permissionMode: null,
      otel: null,
      links: [],
      windows: [],
      agentState: null,
    };
  }
}
