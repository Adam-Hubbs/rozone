import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DAY_MS, LibStore, sanitizeSessionId } from "../../../src/enhanced/libStore.ts";

describe("sanitizeSessionId", () => {
  it("keeps safe characters and replaces the rest", () => {
    assert.equal(sanitizeSessionId("r-1a2b_3.4"), "r-1a2b_3.4");
    assert.equal(sanitizeSessionId("a/b\\c:d"), "a_b_c_d");
  });

  it("rejects empty and dot names", () => {
    for (const bad of ["", ".", ".."]) assert.equal(sanitizeSessionId(bad), "_");
  });
});

describe("LibStore", () => {
  let dir: string;
  let store: LibStore;
  const warnings: string[] = [];
  const make = (...parts: string[]) => {
    const p = join(dir, ...parts);
    mkdirSync(p, { recursive: true });
    return p;
  };
  const age = (p: string, ms: number) => {
    const t = new Date(Date.now() - ms);
    utimesSync(p, t, t);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rozone-libstore-"));
    warnings.length = 0;
    store = new LibStore(join(dir, "root"), { info() {}, warn: (m) => warnings.push(m), error() {} });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("maps sessions to sanitized folders under the root", () => {
    assert.equal(store.sessionRoot("s1"), join(dir, "root", "s1"));
    assert.equal(store.sessionRoot("../x"), join(dir, "root", ".._x"));
    assert.equal(store.sessionRoot(".."), join(dir, "root", "_"));
  });

  it("prune keeps the given lib and other session folders, and ignores non lib-N names", async () => {
    const keep = make("root", "s1", "lib-3");
    make("root", "s1", "lib-1");
    make("root", "s1", "lib-2");
    make("root", "s1", "lib-x");
    make("root", "s1", "other");
    make("root", "s2", "lib-1");
    await store.prune("s1", keep);
    assert.ok(existsSync(keep));
    assert.ok(!existsSync(join(dir, "root", "s1", "lib-1")));
    assert.ok(!existsSync(join(dir, "root", "s1", "lib-2")));
    assert.ok(existsSync(join(dir, "root", "s1", "lib-x")));
    assert.ok(existsSync(join(dir, "root", "s1", "other")));
    assert.ok(existsSync(join(dir, "root", "s2", "lib-1")));
  });

  it("prune and remove tolerate a missing folder", async () => {
    await store.prune("nope", "/x/lib-1");
    await store.remove("nope");
    assert.deepEqual(warnings, []);
  });

  it("remove deletes the whole session folder only", async () => {
    make("root", "s1", "lib-1");
    make("root", "s2", "lib-1");
    await store.remove("s1");
    assert.ok(!existsSync(join(dir, "root", "s1")));
    assert.ok(existsSync(join(dir, "root", "s2")));
  });

  it("sweep deletes old non-live folders only", async () => {
    for (const id of ["live-old", "dead-old", "dead-new"]) make("root", id, "lib-1");
    age(join(dir, "root", "live-old"), 2 * DAY_MS);
    age(join(dir, "root", "dead-old"), 2 * DAY_MS);
    await store.sweep(["live-old"], Date.now(), DAY_MS);
    assert.ok(existsSync(join(dir, "root", "live-old")));
    assert.ok(!existsSync(join(dir, "root", "dead-old")));
    assert.ok(existsSync(join(dir, "root", "dead-new")));
  });

  it("sweep on a missing root is a no-op", async () => {
    await store.sweep([], Date.now());
    assert.deepEqual(warnings, []);
  });

  it("cleanLegacy deletes only old lib-N folders", async () => {
    make("global", "lib-1");
    make("global", "lib-2");
    make("global", "lib-x");
    make("global", "keep");
    age(join(dir, "global", "lib-1"), 2 * DAY_MS);
    age(join(dir, "global", "lib-x"), 2 * DAY_MS);
    age(join(dir, "global", "keep"), 2 * DAY_MS);
    await store.cleanLegacy(join(dir, "global"), Date.now());
    assert.ok(!existsSync(join(dir, "global", "lib-1")));
    assert.ok(existsSync(join(dir, "global", "lib-2")));
    assert.ok(existsSync(join(dir, "global", "lib-x")));
    assert.ok(existsSync(join(dir, "global", "keep")));
  });
});
