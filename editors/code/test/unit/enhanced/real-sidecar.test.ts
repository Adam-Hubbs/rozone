import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findOnPath } from "../../../src/enhanced/rDiscovery.ts";
import { SidecarClient } from "../../../src/enhanced/sidecarClient.ts";

const sidecarScript = fileURLToPath(new URL("../../../r/sidecar.R", import.meta.url));
const exampleScript = fileURLToPath(new URL("../../../../../spike/example_script.R", import.meta.url));
const rscript = findOnPath(process.env["PATH"], process.platform, existsSync);

const skip = !rscript
  ? "Rscript not found"
  : !existsSync(sidecarScript)
    ? "editors/code/r/sidecar.R does not exist yet"
    : !existsSync(exampleScript)
      ? "spike/example_script.R missing"
      : false;

// FNV-1a 64-bit over UTF-8, per docs/contracts.md section 0.
function contentHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

interface BuildResult {
  manifest: { files: { path: string; content_hash: string; topics: { name: string }[] }[] };
  lib_dir: string | null;
  topics: string[];
  errors: unknown[];
}

describe("real sidecar", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "rozone-real-"));
  const log = { info() {}, warn() {}, error() {} };
  after(() => rmSync(dir, { recursive: true, force: true }));

  const start = async () => {
    const client = new SidecarClient({
      command: rscript ?? "Rscript",
      args: ["--no-init-file", sidecarScript],
      env: { ...process.env },
      log,
      helloTimeoutMs: 60_000,
    });
    const hello = await client.start();
    return { client, hello };
  };

  const fixture = () => {
    const text = readFileSync(exampleScript, "utf8");
    const path = join(dir, "example_script.R");
    writeFileSync(path, text);
    return { path, text, hash: contentHash(text) };
  };

  it("handshakes, builds the example script and shuts down", { timeout: 120_000 }, async () => {
    const { client, hello } = await start();
    try {
      assert.equal(hello.protocol, 1);
      if (!hello.ok) {
        assert.ok(hello.missing.length > 0);
        return;
      }
      const file = fixture();
      const result = await client.request<BuildResult>(
        "build",
        { files: [file], install: false },
        90_000,
      );
      assert.deepEqual(result.errors, []);
      const entry = result.manifest.files.find((f) => f.path === file.path);
      assert.equal(entry?.content_hash, file.hash);
      assert.ok(entry?.topics.some((t) => t.name === "wmean"), "manifest has a wmean topic");
      assert.ok(result.topics.includes("wmean"));
      assert.equal(result.lib_dir, null);
    } finally {
      await client.shutdown();
    }
    assert.equal(client.running, false);
  });

  it("installs a rozone.docs library into a fresh lib_root", { timeout: 180_000 }, async () => {
    const { client, hello } = await start();
    try {
      if (!hello.ok) return;
      const libRoot = join(dir, "lib-root");
      const result = await client.request<BuildResult>(
        "build",
        { files: [fixture()], install: true, lib_root: libRoot },
        150_000,
      );
      assert.ok(result.lib_dir?.startsWith(libRoot), `lib_dir ${String(result.lib_dir)} under lib_root`);
      assert.ok(existsSync(join(result.lib_dir ?? "", "rozone.docs")));
    } finally {
      await client.shutdown();
    }
  });
});
