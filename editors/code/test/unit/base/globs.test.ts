import assert from "node:assert/strict";
import { test } from "node:test";
import { createExcludeMatcher, globToRegExp, toFindFilesExclude } from "../../../src/base/globs.ts";

const defaults = ["**/renv/**", "**/packrat/**", "**/node_modules/**", "**/.git/**"];

test("default excludes match at any depth", () => {
  const excluded = createExcludeMatcher(defaults);
  assert.equal(excluded("renv/library/x.R"), true);
  assert.equal(excluded("analysis/renv/activate.R"), true);
  assert.equal(excluded("a/b/node_modules/pkg/index.R"), true);
  assert.equal(excluded(".git/hooks/x.R"), true);
  assert.equal(excluded("packrat/lib/x.r"), true);
});

test("default excludes leave ordinary files and look-alike names alone", () => {
  const excluded = createExcludeMatcher(defaults);
  assert.equal(excluded("analysis.R"), false);
  assert.equal(excluded("src/utils.R"), false);
  assert.equal(excluded("myrenv/x.R"), false);
  assert.equal(excluded("renv.R"), false);
  assert.equal(excluded("not_node_modules/x.R"), false);
});

test("a trailing /** also matches the directory itself", () => {
  assert.equal(createExcludeMatcher(["build/**"])("build"), true);
  assert.equal(createExcludeMatcher(["build/**"])("build/x.R"), true);
  assert.equal(createExcludeMatcher(["build/**"])("src/build/x.R"), false);
});

test("single star does not cross directories", () => {
  const excluded = createExcludeMatcher(["scratch/*.R"]);
  assert.equal(excluded("scratch/a.R"), true);
  assert.equal(excluded("scratch/deep/a.R"), false);
});

test("question mark, braces and character classes", () => {
  assert.equal(globToRegExp("tmp?.R").test("tmp1.R"), true);
  assert.equal(globToRegExp("tmp?.R").test("tmp12.R"), false);
  assert.equal(globToRegExp("**/*.{R,r}").test("a/b/c.r"), true);
  assert.equal(globToRegExp("**/*.{R,r}").test("a/b/c.py"), false);
  assert.equal(globToRegExp("v[0-9].R").test("v7.R"), true);
  assert.equal(globToRegExp("v[!0-9].R").test("v7.R"), false);
  assert.equal(globToRegExp("a[b").test("a[b"), true);
});

test("regex metacharacters in patterns are literal", () => {
  const excluded = createExcludeMatcher(["data (old)/**", "a+b.R"]);
  assert.equal(excluded("data (old)/x.R"), true);
  assert.equal(excluded("data old/x.R"), false);
  assert.equal(excluded("a+b.R"), true);
  assert.equal(excluded("aab.R"), false);
});

test("accepts Windows separators and leading ./ in patterns and paths", () => {
  const excluded = createExcludeMatcher(["./generated/**"]);
  assert.equal(excluded("generated\\x.R"), true);
  assert.equal(excluded("/generated/x.R"), true);
});

test("empty pattern list excludes nothing", () => {
  assert.equal(createExcludeMatcher([])("anything.R"), false);
});

test("a bare ** matches everything", () => {
  assert.equal(createExcludeMatcher(["**"])("a/b/c.R"), true);
});

test("findFiles exclude: one pattern, a brace group, or nothing", () => {
  assert.equal(toFindFilesExclude([]), undefined);
  assert.equal(toFindFilesExclude(["**/renv/**"]), "**/renv/**");
  assert.equal(toFindFilesExclude(["**/renv/**", "**/.git/**"]), "{**/renv/**,**/.git/**}");
});

test("findFiles exclude leaves out patterns that would break a brace group", () => {
  assert.equal(toFindFilesExclude(["**/*.{a,b}", "x/**", ""]), "x/**");
  assert.equal(toFindFilesExclude(["**/*.{a,b}"]), undefined);
});
