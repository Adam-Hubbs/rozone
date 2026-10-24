import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineFramer } from "../../../src/enhanced/jsonLines.ts";

describe("LineFramer", () => {
  it("returns one line per terminated line", () => {
    assert.deepEqual(new LineFramer().push('{"a":1}\n'), ['{"a":1}']);
  });

  it("buffers partial chunks until the newline arrives", () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push('{"a"'), []);
    assert.deepEqual(framer.push(":1"), []);
    assert.equal(framer.remainder, '{"a":1');
    assert.deepEqual(framer.push("}\n"), ['{"a":1}']);
    assert.equal(framer.remainder, "");
  });

  it("splits several lines in one chunk and keeps the trailing partial", () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push("one\ntwo\nthr"), ["one", "two"]);
    assert.deepEqual(framer.push("ee\n"), ["three"]);
  });

  it("handles CRLF, including a CR/LF split across chunks", () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push("one\r\ntwo\r"), ["one"]);
    assert.deepEqual(framer.push("\nthree\r\n"), ["two", "three"]);
  });

  it("skips blank lines", () => {
    assert.deepEqual(new LineFramer().push("\n\none\n  \n"), ["one"]);
  });

  it("decodes multi-byte characters split across buffers", () => {
    const framer = new LineFramer();
    const bytes = Buffer.from("café \u{1f600}\n", "utf8");
    const out = [...bytes].flatMap((b) => framer.push(Buffer.from([b])));
    assert.deepEqual(out, ["café \u{1f600}"]);
  });

  it("accepts Buffers and strings interchangeably", () => {
    const framer = new LineFramer();
    assert.deepEqual(framer.push(Buffer.from("a\nb")), ["a"]);
    assert.deepEqual(framer.push("\n"), ["b"]);
  });
});
