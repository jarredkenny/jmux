import { describe, test, expect } from "bun:test";
import { PinnedPaneTracker } from "../../glass/pinned-pane-tracker";

describe("PinnedPaneTracker", () => {
  test("apply('1') adds the pane and fires onChange", () => {
    const t = new PinnedPaneTracker();
    let fired = 0;
    t.onChange(() => fired++);
    t.apply("%1", "1");
    expect(t.has("%1")).toBe(true);
    expect(fired).toBe(1);
  });

  test("apply with an unset/empty value removes the pane", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    t.apply("%1", "");
    expect(t.has("%1")).toBe(false);
  });

  test("does NOT fire on an idempotent re-apply", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    let fired = 0;
    t.onChange(() => fired++);
    t.apply("%1", "1");
    expect(fired).toBe(0);
  });

  test("all() returns the pinned pane ids; size reflects membership", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    t.apply("%2", "1");
    expect(new Set(t.all())).toEqual(new Set(["%1", "%2"]));
    expect(t.size).toBe(2);
  });

  test("pruneExcept drops panes no longer present, firing once on change", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    t.apply("%2", "1");
    let fired = 0;
    t.onChange(() => fired++);
    t.pruneExcept(["%1"]);
    expect(t.has("%1")).toBe(true);
    expect(t.has("%2")).toBe(false);
    expect(fired).toBe(1);
  });

  test("pruneExcept is silent when nothing changes", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "1");
    let fired = 0;
    t.onChange(() => fired++);
    t.pruneExcept(["%1", "%9"]);
    expect(fired).toBe(0);
  });

  test("stores the raw value and exposes it via getValue", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "backend");
    expect(t.has("%1")).toBe(true);
    expect(t.getValue("%1")).toBe("backend");
  });

  test("a changed value fires onChange (e.g. moved between tabs)", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "backend");
    let fired = 0;
    t.onChange(() => fired++);
    t.apply("%1", "review"); // moved tab
    expect(fired).toBe(1);
    expect(t.getValue("%1")).toBe("review");
  });

  test("unset clears the value and getValue returns undefined", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "backend");
    t.apply("%1", null);
    expect(t.has("%1")).toBe(false);
    expect(t.getValue("%1")).toBeUndefined();
  });

  test("idempotent same-value re-apply does not fire", () => {
    const t = new PinnedPaneTracker();
    t.apply("%1", "backend");
    let fired = 0;
    t.onChange(() => fired++);
    t.apply("%1", "backend");
    expect(fired).toBe(0);
  });
});
