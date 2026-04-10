import { CliError, type CliContext } from "./context";
import type { ParsedCtlArgs } from "../cli";
import {
  createTask,
  getTask,
  updateTask,
  removeTask,
  listTasks,
  DEFAULT_REGISTRY_PATH,
  type TaskStatus,
} from "../task-registry";

const VALID_STATUSES = new Set(["pickup", "in_progress", "review", "merged", "closed"]);

export function handleTask(ctx: CliContext, parsed: ParsedCtlArgs, registryPath?: string): unknown {
  const { action, flags } = parsed;
  const path = registryPath ?? DEFAULT_REGISTRY_PATH;

  switch (action) {
    case "create": {
      if (!flags.ticket || typeof flags.ticket !== "string") throw new CliError("--ticket is required");
      if (!flags.source || typeof flags.source !== "string") throw new CliError("--source is required");
      const entry = createTask(path, {
        ticket: flags.ticket,
        source: flags.source,
        title: typeof flags.title === "string" ? flags.title : undefined,
        session: typeof flags.session === "string" ? flags.session : undefined,
        project: typeof flags.project === "string" ? flags.project : undefined,
        externalId: typeof flags["external-id"] === "string" ? flags["external-id"] : undefined,
        url: typeof flags.url === "string" ? flags.url : undefined,
      });
      return { ticket: flags.ticket, ...entry };
    }
    case "list": return { tasks: listTasks(path) };
    case "get": {
      if (!flags.ticket || typeof flags.ticket !== "string") throw new CliError("--ticket is required");
      const task = getTask(path, flags.ticket);
      if (!task) throw new CliError(`Task "${flags.ticket}" not found`);
      return { ticket: flags.ticket, ...task };
    }
    case "update": {
      if (!flags.ticket || typeof flags.ticket !== "string") throw new CliError("--ticket is required");
      const status = typeof flags.status === "string" ? flags.status : undefined;
      if (status && !VALID_STATUSES.has(status)) throw new CliError(`Invalid status "${status}". Valid: ${[...VALID_STATUSES].join(", ")}`);
      const entry = updateTask(path, flags.ticket, {
        status: status as TaskStatus | undefined,
        session: typeof flags.session === "string" ? flags.session : undefined,
        mr: typeof flags.mr === "string" ? flags.mr : undefined,
        mrState: typeof flags["mr-state"] === "string" ? flags["mr-state"] : undefined,
        title: typeof flags.title === "string" ? flags.title : undefined,
        worktree: typeof flags.worktree === "string" ? flags.worktree : undefined,
        project: typeof flags.project === "string" ? flags.project : undefined,
      });
      return { ticket: flags.ticket, ...entry };
    }
    case "remove": {
      if (!flags.ticket || typeof flags.ticket !== "string") throw new CliError("--ticket is required");
      removeTask(path, flags.ticket);
      return { removed: flags.ticket };
    }
    default:
      throw new CliError(`Unknown task action "${action}". Known actions: create, list, get, update, remove`);
  }
}
