import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { logError } from "./log";

export interface SessionLink {
  type: "issue" | "mr";
  id: string;
}

interface StateData {
  sessionLinks: Record<string, SessionLink[]>;
}

export class SessionState {
  private data: StateData = { sessionLinks: {} };
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  getLinks(sessionName: string): SessionLink[] {
    return [...(this.data.sessionLinks[sessionName] ?? [])];
  }

  getLinkedIssueIds(sessionName: string): string[] {
    return this.getLinks(sessionName)
      .filter((l) => l.type === "issue")
      .map((l) => l.id);
  }

  getLinkedMrIds(sessionName: string): string[] {
    return this.getLinks(sessionName)
      .filter((l) => l.type === "mr")
      .map((l) => l.id);
  }

  addLink(sessionName: string, link: SessionLink): void {
    if (!this.data.sessionLinks[sessionName]) {
      this.data.sessionLinks[sessionName] = [];
    }
    const list = this.data.sessionLinks[sessionName];
    const exists = list.some((l) => l.type === link.type && l.id === link.id);
    if (!exists) {
      list.push({ type: link.type, id: link.id });
      this.save();
    }
  }

  removeLink(sessionName: string, link: SessionLink): void {
    const list = this.data.sessionLinks[sessionName];
    if (!list) return;
    const idx = list.findIndex((l) => l.type === link.type && l.id === link.id);
    if (idx >= 0) {
      list.splice(idx, 1);
      if (list.length === 0) delete this.data.sessionLinks[sessionName];
      this.save();
    }
  }

  renameSession(oldName: string, newName: string): void {
    const links = this.data.sessionLinks[oldName];
    if (links) {
      this.data.sessionLinks[newName] = links;
      delete this.data.sessionLinks[oldName];
      this.save();
    }
  }

  pruneSessions(liveSessions: Set<string>): void {
    let changed = false;
    for (const name of Object.keys(this.data.sessionLinks)) {
      if (!liveSessions.has(name)) {
        delete this.data.sessionLinks[name];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, "utf-8"));
        if (raw?.sessionLinks && typeof raw.sessionLinks === "object") {
          this.data = raw as StateData;
        }
      }
    } catch (e) {
      logError("SessionState", `failed to load: ${(e as Error).message}`);
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n");
    } catch (e) {
      logError("SessionState", `failed to save: ${(e as Error).message}`);
    }
  }
}
