import { describe, test, expect } from "bun:test";
import { SnapshotModel } from "../../snapshot/model";

function makeModel() {
  return new SnapshotModel("test-ver");
}

describe("SnapshotModel.removeSession", () => {
  test("removes the session from the map", () => {
    const m = makeModel();
    m.upsertSession(SnapshotModel.makeEmptySession("alpha", "/x"));
    expect(m.hasSession("alpha")).toBe(true);
    m.removeSession("alpha");
    expect(m.hasSession("alpha")).toBe(false);
  });

  test("clears lastFocused when the focused session is removed", () => {
    const m = makeModel();
    m.upsertSession(SnapshotModel.makeEmptySession("alpha", "/x"));
    m.setLastFocused("alpha");
    m.removeSession("alpha");
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file.lastFocusedSession).toBeNull();
  });

  test("does not clear lastFocused when a different session is removed", () => {
    const m = makeModel();
    m.upsertSession(SnapshotModel.makeEmptySession("alpha", "/x"));
    m.upsertSession(SnapshotModel.makeEmptySession("beta", "/y"));
    m.setLastFocused("alpha");
    m.removeSession("beta");
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file.lastFocusedSession).toBe("alpha");
  });

  test("no-ops silently when the session does not exist", () => {
    const m = makeModel();
    m.removeSession("ghost"); // should not throw
    expect(m.sessionNames()).toEqual([]);
  });
});

describe("SnapshotModel.setLayoutForWindow", () => {
  test("updates layout when the session and window both exist", () => {
    const m = makeModel();
    const session = {
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [SnapshotModel.makeEmptyWindow(0, "main", "old-layout", true, [])],
    };
    m.upsertSession(session);
    m.setLayoutForWindow("alpha", 0, "new-layout");
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows[0].layout).toBe("new-layout");
  });

  test("no-ops when the session does not exist", () => {
    const m = makeModel();
    m.setLayoutForWindow("ghost", 0, "layout"); // should not throw
  });

  test("no-ops when the window index does not exist in session", () => {
    const m = makeModel();
    const session = {
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [SnapshotModel.makeEmptyWindow(0, "main", "original", true, [])],
    };
    m.upsertSession(session);
    // Window index 99 does not exist — should not throw, layout 0 stays unchanged
    m.setLayoutForWindow("alpha", 99, "changed");
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows[0].layout).toBe("original");
  });
});

describe("SnapshotModel.setScrollbackFile", () => {
  test("updates scrollbackFile when session/window/pane all exist", () => {
    const m = makeModel();
    const session = {
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [
        SnapshotModel.makeEmptyWindow(0, "main", "L", true, [
          SnapshotModel.makeEmptyPane(0, "/x", "zsh"),
        ]),
      ],
    };
    m.upsertSession(session);
    m.setScrollbackFile("alpha", 0, 0, "scrollback/alpha/0-0.ansi");
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows[0].panes[0].scrollbackFile).toBe(
      "scrollback/alpha/0-0.ansi",
    );
  });

  test("no-ops when the session does not exist", () => {
    const m = makeModel();
    m.setScrollbackFile("ghost", 0, 0, "x.ansi"); // should not throw
  });

  test("no-ops when the window does not exist", () => {
    const m = makeModel();
    m.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      windows: [],
    });
    m.setScrollbackFile("alpha", 99, 0, "x.ansi"); // should not throw
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file.sessions[0].windows).toEqual([]);
  });
});

describe("SnapshotModel.renameSession", () => {
  test("updates lastFocused when the focused session is renamed", () => {
    const m = makeModel();
    m.upsertSession(SnapshotModel.makeEmptySession("old", "/x"));
    m.setLastFocused("old");
    m.renameSession("old", "new");
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file.lastFocusedSession).toBe("new");
  });

  test("no-ops when the old name does not exist", () => {
    const m = makeModel();
    m.renameSession("ghost", "new"); // should not throw
    expect(m.sessionNames()).toEqual([]);
  });
});

describe("SnapshotModel.toFile", () => {
  test("serialises socket set via setSocket", () => {
    const m = makeModel();
    m.setSocket("/tmp/tmux-test");
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file.tmuxSocket).toBe("/tmp/tmux-test");
  });

  test("produces a deep copy so mutations do not affect the model", () => {
    const m = makeModel();
    m.upsertSession({
      ...SnapshotModel.makeEmptySession("alpha", "/x"),
      links: [{ type: "issue", id: "ENG-1" }],
    });
    const file = m.toFile("2026-05-12T00:00:00.000Z");
    // Mutate the output
    file.sessions[0].links.push({ type: "mr", id: "99" });
    // Model's next serialisation should not include the injected link
    const file2 = m.toFile("2026-05-12T00:00:00.000Z");
    expect(file2.sessions[0].links).toHaveLength(1);
  });
});
