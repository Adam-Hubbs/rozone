import assert from "node:assert/strict";
import { test } from "node:test";
import { createIndexedSet } from "../../../src/base/indexedSet.ts";
import { exceedsSizeLimit, isRFile, MAX_FILE_BYTES, pathKey, relativeTo } from "../../../src/base/paths.ts";

const uri = (scheme: string, fsPath: string, text = `${scheme}:${fsPath}`) => ({ scheme, fsPath, toString: () => text });

test("pathKey uses fsPath for files and the URI string for everything else", () => {
  assert.equal(pathKey(uri("file", "/w/a.R")), "/w/a.R");
  assert.equal(pathKey(uri("untitled", "Untitled-1", "untitled:Untitled-1")), "untitled:Untitled-1");
  assert.equal(pathKey(uri("vscode-vfs", "/a.R", "vscode-vfs://github/o/r/a.R")), "vscode-vfs://github/o/r/a.R");
});

test("relativeTo returns paths below the folder only", () => {
  assert.equal(relativeTo("/w", "/w/a/b.R"), "a/b.R");
  assert.equal(relativeTo("/w/", "/w/a.R"), "a.R");
  assert.equal(relativeTo("/w", "/w2/a.R"), undefined);
  assert.equal(relativeTo("/w", "/other/a.R"), undefined);
  assert.equal(relativeTo("/w", "/w"), undefined);
});

test("size limit is measured in UTF-8 bytes", () => {
  assert.equal(exceedsSizeLimit("small"), false);
  assert.equal(exceedsSizeLimit("a".repeat(100), 100), false);
  assert.equal(exceedsSizeLimit("a".repeat(101), 100), true);
  assert.equal(exceedsSizeLimit("é".repeat(60), 100), true, "60 code units but 120 bytes");
  assert.equal(exceedsSizeLimit("é".repeat(50), 100), false);
  assert.equal(exceedsSizeLimit("a".repeat(MAX_FILE_BYTES)), false);
  assert.equal(exceedsSizeLimit("a".repeat(MAX_FILE_BYTES + 1)), true);
});

test("isRFile accepts .R and .r only", () => {
  assert.equal(isRFile("/a/b.R"), true);
  assert.equal(isRFile("/a/b.r"), true);
  assert.equal(isRFile("/a/b.Rmd"), false);
  assert.equal(isRFile("/a/R"), false);
});

test("indexed set separates workspace files from untitled documents", () => {
  const set = createIndexedSet();
  set.add("/w/a.R", "workspace");
  set.add("/elsewhere/b.R", "external");
  set.add("untitled:Untitled-1", "untitled");
  assert.deepEqual(set.files().sort(), ["/elsewhere/b.R", "/w/a.R"]);
  assert.deepEqual(set.paths().sort(), ["/elsewhere/b.R", "/w/a.R", "untitled:Untitled-1"]);
  assert.equal(set.originOf("untitled:Untitled-1"), "untitled");
});

test("indexed set remove reports whether anything was removed", () => {
  const set = createIndexedSet();
  set.add("/w/a.R", "workspace");
  assert.equal(set.remove("/w/a.R"), true);
  assert.equal(set.remove("/w/a.R"), false);
  assert.equal(set.has("/w/a.R"), false);
});

test("adding an existing path updates its origin without duplicating it", () => {
  const set = createIndexedSet();
  set.add("/w/a.R", "external");
  set.add("/w/a.R", "workspace");
  assert.deepEqual(set.files(), ["/w/a.R"]);
  assert.equal(set.originOf("/w/a.R"), "workspace");
});
