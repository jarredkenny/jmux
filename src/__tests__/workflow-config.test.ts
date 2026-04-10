import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { loadWorkflowConfig, discoverWorkflowConfigs, matchTicketToProject, type WorkflowConfig } from "../workflow-config";

describe("loadWorkflowConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "jmux-wf-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loads a valid workflow config", () => {
    const jmuxDir = resolve(dir, ".jmux");
    mkdirSync(jmuxDir, { recursive: true });
    writeFileSync(resolve(jmuxDir, "workflow.yml"), `
project: myapp
tickets:
  linear:
    projects: ["MYAPP"]
setup:
  worktree: true
  base_branch: origin/main
  naming: lowercase-ticket-id
`);
    const config = loadWorkflowConfig(dir);
    expect(config).not.toBeNull();
    expect(config!.project).toBe("myapp");
    expect(config!.tickets?.linear?.projects).toEqual(["MYAPP"]);
    expect(config!.setup?.worktree).toBe(true);
  });

  test("returns null when no .jmux/workflow.yml exists", () => {
    const config = loadWorkflowConfig(dir);
    expect(config).toBeNull();
  });

  test("returns null for invalid YAML", () => {
    const jmuxDir = resolve(dir, ".jmux");
    mkdirSync(jmuxDir, { recursive: true });
    writeFileSync(resolve(jmuxDir, "workflow.yml"), "{{{{invalid");
    const config = loadWorkflowConfig(dir);
    expect(config).toBeNull();
  });
});

describe("discoverWorkflowConfigs", () => {
  let dir1: string;
  let dir2: string;
  let dir3: string;

  beforeEach(() => {
    dir1 = mkdtempSync(resolve(tmpdir(), "jmux-wf1-"));
    dir2 = mkdtempSync(resolve(tmpdir(), "jmux-wf2-"));
    dir3 = mkdtempSync(resolve(tmpdir(), "jmux-wf3-"));

    // dir1 has a workflow
    mkdirSync(resolve(dir1, ".jmux"), { recursive: true });
    writeFileSync(resolve(dir1, ".jmux", "workflow.yml"), "project: app1\ntickets:\n  linear:\n    projects: [APP1]\n");

    // dir2 has a workflow
    mkdirSync(resolve(dir2, ".jmux"), { recursive: true });
    writeFileSync(resolve(dir2, ".jmux", "workflow.yml"), "project: app2\ntickets:\n  linear:\n    projects: [APP2]\n");

    // dir3 has no workflow
  });

  afterEach(() => {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
    rmSync(dir3, { recursive: true, force: true });
  });

  test("discovers configs from multiple directories", () => {
    const configs = discoverWorkflowConfigs([dir1, dir2, dir3]);
    expect(configs).toHaveLength(2);
    expect(configs.map(c => c.config.project).sort()).toEqual(["app1", "app2"]);
  });
});

describe("matchTicketToProject", () => {
  test("matches by project prefix", () => {
    const configs = [
      { dir: "/repo/app1", config: { project: "app1", tickets: { linear: { projects: ["APP1"] } } } as WorkflowConfig },
      { dir: "/repo/app2", config: { project: "app2", tickets: { linear: { projects: ["APP2"] } } } as WorkflowConfig },
    ];
    const match = matchTicketToProject("APP1-123", configs);
    expect(match).not.toBeNull();
    expect(match!.dir).toBe("/repo/app1");
  });

  test("matches by team", () => {
    const configs = [
      { dir: "/repo/app", config: { project: "app", tickets: { linear: { team: "Engineering" } } } as WorkflowConfig },
    ];
    const match = matchTicketToProject("PROJ-1", configs, "Engineering");
    expect(match).not.toBeNull();
  });

  test("returns null when no match", () => {
    const configs = [
      { dir: "/repo/app", config: { project: "app", tickets: { linear: { projects: ["OTHER"] } } } as WorkflowConfig },
    ];
    const match = matchTicketToProject("MYAPP-1", configs);
    expect(match).toBeNull();
  });
});
