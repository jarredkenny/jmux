export {
  Snapshotter,
  type SnapshotterOptions,
} from "./capture";
export { Restorer, type RestorerOptions, type EligibilityResult } from "./restore";
export { SnapshotModel } from "./model";
export {
  validateSnapshot,
  SNAPSHOT_FORMAT_VERSION,
  type SnapshotFile,
  type SnapshotSession,
  type SnapshotWindow,
  type SnapshotPane,
  type SnapshotOtel,
  type SessionLink,
  type SnapshotPermissionMode,
  type PaneKind,
} from "./schema";
export { buildPainterArgv, detectPaneKind } from "./painter";
export { ProductionFileSystem, isSnapshotTempName } from "./fs";
export type {
  SnapshotHealth,
  HealthSnapshot,
  SubsystemHealth,
} from "./health";
export { ProductionTmuxRunner } from "./runner";
export { ProductionClock } from "./clock";
export { MigrationRegistry, type MigrationResult } from "./migrations";
export { RestoreLog, type RestoreOutcome, type RestoreLogEntry } from "./log";
export type {
  FileSystem,
  TmuxRunner,
  Clock,
  Lock,
  FileStat,
  TmuxRunResult,
} from "./deps";

export function resolveSnapshotDir(opts: {
  override: string | null;
  socketName: string | null;
  xdgDataHome: string | null;
  home: string;
}): string {
  if (opts.override) return opts.override;
  const root =
    opts.xdgDataHome ?? `${opts.home}/.local/share`;
  const socket = opts.socketName && opts.socketName.length > 0 ? opts.socketName : "default";
  return `${root}/jmux/snapshot/${socket}`;
}
