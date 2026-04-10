import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { handleTask } from "../../cli/task";
import { loadRegistry } from "../../task-registry";
import type { CliContext } from "../../cli/context";
import type { ParsedCtlArgs } from "../../cli";

function makeCtx(): CliContext {
  return { socket: null, paneId: null, sessionOverride: null, insideTmux: false, insideJmux: false };
}

function makeParsed(action: string, flags: Record<string, string | boolean> = {}): ParsedCtlArgs {
  return { group: "task", action, flags, positional: [] };
}

describe("handleTask", () => {
  let dir: string;
  let registryPath: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "jmux-task-cli-"));
    registryPath = resolve(dir, "tasks.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("create registers a new task", () => {
    const result = handleTask(makeCtx(), makeParsed("create", {
      ticket: "MYAPP-1", source: "linear", title: "Fix bug", project: "myapp",
    }), registryPath) as any;
    expect(result.ticket).toBe("MYAPP-1");
    expect(result.status).toBe("pickup");
    const reg = loadRegistry(registryPath);
    expect(reg.tasks["MYAPP-1"]).toBeDefined();
  });

  test("create requires --ticket", () => {
    expect(() => handleTask(makeCtx(), makeParsed("create", { source: "linear" }), registryPath)).toThrow("--ticket");
  });

  test("create requires --source", () => {
    expect(() => handleTask(makeCtx(), makeParsed("create", { ticket: "X-1" }), registryPath)).toThrow("--source");
  });

  test("list returns all tasks", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear" }), registryPath);
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-2", source: "linear" }), registryPath);
    const result = handleTask(makeCtx(), makeParsed("list"), registryPath) as any;
    expect(Object.keys(result.tasks)).toEqual(["X-1", "X-2"]);
  });

  test("get returns a single task", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear", title: "Hello" }), registryPath);
    const result = handleTask(makeCtx(), makeParsed("get", { ticket: "X-1" }), registryPath) as any;
    expect(result.title).toBe("Hello");
  });

  test("get throws on missing task", () => {
    expect(() => handleTask(makeCtx(), makeParsed("get", { ticket: "NOPE" }), registryPath)).toThrow("not found");
  });

  test("update modifies task fields", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear" }), registryPath);
    const result = handleTask(makeCtx(), makeParsed("update", { ticket: "X-1", status: "in_progress", session: "x-1" }), registryPath) as any;
    expect(result.status).toBe("in_progress");
    expect(result.session).toBe("x-1");
  });

  test("update adds MR", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear" }), registryPath);
    handleTask(makeCtx(), makeParsed("update", { ticket: "X-1", mr: "https://example.com/mr/1" }), registryPath);
    const task = loadRegistry(registryPath).tasks["X-1"];
    expect(task.mrs).toHaveLength(1);
    expect(task.mrs[0].url).toBe("https://example.com/mr/1");
  });

  test("remove deletes a task", () => {
    handleTask(makeCtx(), makeParsed("create", { ticket: "X-1", source: "linear" }), registryPath);
    handleTask(makeCtx(), makeParsed("remove", { ticket: "X-1" }), registryPath);
    const reg = loadRegistry(registryPath);
    expect(reg.tasks["X-1"]).toBeUndefined();
  });
});
