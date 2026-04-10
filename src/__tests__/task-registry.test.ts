import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  type TaskEntry,
  type TaskRegistry,
  loadRegistry,
  saveRegistry,
  createTask,
  getTask,
  updateTask,
  removeTask,
  listTasks,
} from "../task-registry";

describe("TaskRegistry storage", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "jmux-test-"));
    filePath = resolve(dir, "tasks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadRegistry returns empty tasks when file missing", () => {
    const reg = loadRegistry(filePath);
    expect(reg).toEqual({ tasks: {} });
  });

  test("saveRegistry writes and loadRegistry reads back", () => {
    const reg: TaskRegistry = {
      tasks: {
        "MYAPP-1": {
          source: "linear",
          externalId: "uuid-1",
          url: "https://linear.app/team/MYAPP-1",
          title: "Fix bug",
          session: null,
          worktree: null,
          project: "myapp",
          mrs: [],
          status: "pickup",
          createdAt: "2026-04-10T00:00:00Z",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
    };
    saveRegistry(filePath, reg);
    const loaded = loadRegistry(filePath);
    expect(loaded).toEqual(reg);
  });

  test("saveRegistry uses atomic write (temp + rename)", () => {
    const reg: TaskRegistry = { tasks: { "X-1": { source: "linear", externalId: "a", url: "", title: "t", session: null, worktree: null, project: "p", mrs: [], status: "pickup", createdAt: "", updatedAt: "" } } };
    saveRegistry(filePath, reg);
    // File should exist and be valid JSON
    const raw = readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual(reg);
    // No leftover temp files
    const files = readdirSync(dir);
    const tmpFiles = files.filter(f => f.includes(".tmp."));
    expect(tmpFiles).toEqual([]);
  });

  test("loadRegistry returns empty tasks when file is corrupt", () => {
    writeFileSync(filePath, "{{not valid json!!", "utf-8");
    const reg = loadRegistry(filePath);
    expect(reg).toEqual({ tasks: {} });
  });
});

describe("TaskRegistry CRUD", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "jmux-test-"));
    filePath = resolve(dir, "tasks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("createTask adds a new task", () => {
    createTask(filePath, {
      ticket: "MYAPP-1",
      source: "linear",
      title: "Fix auth",
      project: "myapp",
    });
    const task = getTask(filePath, "MYAPP-1");
    expect(task).not.toBeNull();
    expect(task!.title).toBe("Fix auth");
    expect(task!.status).toBe("pickup");
    expect(task!.session).toBeNull();
  });

  test("createTask throws on duplicate", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    expect(() => createTask(filePath, { ticket: "MYAPP-1", source: "linear" })).toThrow("already exists");
  });

  test("updateTask modifies fields", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    updateTask(filePath, "MYAPP-1", { status: "in_progress", session: "myapp-1" });
    const task = getTask(filePath, "MYAPP-1");
    expect(task!.status).toBe("in_progress");
    expect(task!.session).toBe("myapp-1");
  });

  test("updateTask appends MR", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    updateTask(filePath, "MYAPP-1", { mr: "https://gitlab.com/mr/1", mrState: "open" });
    const task = getTask(filePath, "MYAPP-1");
    expect(task!.mrs).toEqual([{ url: "https://gitlab.com/mr/1", state: "open" }]);
  });

  test("updateTask throws on missing task", () => {
    expect(() => updateTask(filePath, "NOPE", { status: "in_progress" })).toThrow("not found");
  });

  test("removeTask deletes a task", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    removeTask(filePath, "MYAPP-1");
    expect(getTask(filePath, "MYAPP-1")).toBeNull();
  });

  test("listTasks returns all tasks", () => {
    createTask(filePath, { ticket: "MYAPP-1", source: "linear" });
    createTask(filePath, { ticket: "MYAPP-2", source: "linear", title: "Other" });
    const tasks = listTasks(filePath);
    expect(Object.keys(tasks)).toEqual(["MYAPP-1", "MYAPP-2"]);
  });
});
