import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export interface MrEntry {
  url: string;
  state: string;
}

export type TaskStatus = "pickup" | "in_progress" | "review" | "merged" | "closed";

export interface TaskEntry {
  source: string;
  externalId: string;
  url: string;
  title: string;
  session: string | null;
  worktree: string | null;
  project: string;
  mrs: MrEntry[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRegistry {
  tasks: Record<string, TaskEntry>;
}

export const DEFAULT_REGISTRY_PATH = resolve(homedir(), ".config", "jmux", "tasks.json");

export function loadRegistry(filePath: string): TaskRegistry {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf-8")) as TaskRegistry;
    }
  } catch {}
  return { tasks: {} };
}

export function saveRegistry(filePath: string, registry: TaskRegistry): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + `.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, filePath);
}

export interface CreateTaskOpts {
  ticket: string;
  source: string;
  externalId?: string;
  url?: string;
  title?: string;
  session?: string;
  worktree?: string;
  project?: string;
}

export function createTask(filePath: string, opts: CreateTaskOpts): TaskEntry {
  const reg = loadRegistry(filePath);
  if (reg.tasks[opts.ticket]) {
    throw new Error(`Task "${opts.ticket}" already exists`);
  }
  const now = new Date().toISOString();
  const entry: TaskEntry = {
    source: opts.source,
    externalId: opts.externalId ?? "",
    url: opts.url ?? "",
    title: opts.title ?? "",
    session: opts.session ?? null,
    worktree: opts.worktree ?? null,
    project: opts.project ?? "",
    mrs: [],
    status: "pickup",
    createdAt: now,
    updatedAt: now,
  };
  reg.tasks[opts.ticket] = entry;
  saveRegistry(filePath, reg);
  return entry;
}

export function getTask(filePath: string, ticket: string): TaskEntry | null {
  const reg = loadRegistry(filePath);
  return reg.tasks[ticket] ?? null;
}

export interface UpdateTaskOpts {
  status?: TaskStatus;
  session?: string;
  worktree?: string;
  mr?: string;
  mrState?: string;
  title?: string;
  externalId?: string;
  url?: string;
  project?: string;
}

export function updateTask(filePath: string, ticket: string, opts: UpdateTaskOpts): TaskEntry {
  const reg = loadRegistry(filePath);
  const task = reg.tasks[ticket];
  if (!task) {
    throw new Error(`Task "${ticket}" not found`);
  }
  if (opts.status !== undefined) task.status = opts.status;
  if (opts.session !== undefined) task.session = opts.session;
  if (opts.worktree !== undefined) task.worktree = opts.worktree;
  if (opts.title !== undefined) task.title = opts.title;
  if (opts.externalId !== undefined) task.externalId = opts.externalId;
  if (opts.url !== undefined) task.url = opts.url;
  if (opts.project !== undefined) task.project = opts.project;
  if (opts.mr) {
    task.mrs.push({ url: opts.mr, state: opts.mrState ?? "open" });
  }
  task.updatedAt = new Date().toISOString();
  reg.tasks[ticket] = task;
  saveRegistry(filePath, reg);
  return task;
}

export function removeTask(filePath: string, ticket: string): void {
  const reg = loadRegistry(filePath);
  if (!reg.tasks[ticket]) {
    throw new Error(`Task "${ticket}" not found`);
  }
  delete reg.tasks[ticket];
  saveRegistry(filePath, reg);
}

export function listTasks(filePath: string): Record<string, TaskEntry> {
  const reg = loadRegistry(filePath);
  return reg.tasks;
}
