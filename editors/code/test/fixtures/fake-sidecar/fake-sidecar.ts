// Fake implementation of the docs/contracts.md section 4 protocol for tests.
// Behaviour is selected with FAKE_MODE (comma separated):
//   normal            default
//   missing-roxygen2  hello with ok:false, then exit 3
//   hang-hello        never says hello
//   hang              says hello, never answers requests
//   slow              delays each response by FAKE_DELAY_MS (default 200)
//   garbage           prints junk lines around the real output
//   split             writes every message in small pieces
//   crlf              terminates lines with \r\n
//   stderr            logs to stderr for every request
//   crash-after       exits(1) after answering FAKE_CRASH_AFTER requests (default 1)
//   crash-on-start    exits(1) before hello
// FAKE_RECORD: file that receives one JSON line per received request (plus a start line with argv/env).
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

const modes = new Set((process.env.FAKE_MODE ?? "normal").split(",").map((m) => m.trim()));
const recordFile = process.env.FAKE_RECORD;
const delayMs = Number(process.env.FAKE_DELAY_MS ?? 200);
const crashAfter = Number(process.env.FAKE_CRASH_AFTER ?? 1);
const eol = modes.has("crlf") ? "\r\n" : "\n";

const record = (entry: unknown) => {
  if (recordFile) appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
};

const exitAfterFlush = (code: number) => process.stdout.write("", () => process.exit(code));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(message: unknown) {
  const text = `${JSON.stringify(message)}${eol}`;
  if (!modes.has("split")) {
    process.stdout.write(text);
    return;
  }
  for (let i = 0; i < text.length; i += 7) {
    process.stdout.write(text.slice(i, i + 7));
    await sleep(2);
  }
}

record({
  start: true,
  argv: process.argv.slice(2),
  R_LIBS: process.env.R_LIBS ?? null,
  cwd: process.cwd(),
});

if (modes.has("crash-on-start")) process.exit(1);

if (modes.has("garbage")) {
  process.stdout.write(`this is not json${eol}`);
  process.stdout.write(`{"half":${eol}`);
}

if (modes.has("missing-roxygen2")) {
  await send({ event: "hello", protocol: 1, r_version: "4.6.1", packages: { jsonlite: "2.0.0" }, missing: ["roxygen2"], ok: false });
  exitAfterFlush(3);
}

if (!modes.has("hang-hello")) {
  await send({
    event: "hello",
    protocol: 1,
    r_version: "4.6.1",
    packages: { roxygen2: "8.1.0", jsonlite: "2.0.0" },
    missing: [],
    ok: true,
  });
}

let answered = 0;
let queue = Promise.resolve();

type Reply = { result?: unknown; error?: { message: string }; exit?: number };
type FileArg = { path: string; hash: string };
function handle(request: { id: number; method: string; params?: any }): Reply {
  switch (request.method) {
    case "ping":
      return { result: { pong: true } };
    case "shutdown":
      return { result: { ok: true }, exit: 0 };
    case "build": {
      const { files = [], install = false, lib_root: libRoot = null } = request.params ?? {};
      const topics = files.map((f: FileArg) => `fn_${basename(f.path).replace(/\.[Rr]$/, "")}`);
      return {
        result: {
          manifest: {
            version: 1,
            files: files.map((f: FileArg, i: number) => ({ path: f.path, content_hash: f.hash, topics: [{ name: topics[i], aliases: [topics[i]], title: "Fake" }] })),
          },
          lib_dir: install && libRoot ? `${libRoot}/lib-1` : null,
          topics,
          cache_hits: 0,
          errors: files.filter((f: FileArg) => /broken/.test(f.path)).map((f: FileArg) => ({ path: f.path, message: "parse error" })),
        },
      };
    }
    case "fail":
      return { error: { message: "requested failure" } };
    default:
      return { error: { message: `unknown method ${request.method}` } };
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let request: { id: number; method: string; params?: unknown };
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  record({ request });
  queue = queue.then(async () => {
    if (modes.has("hang")) return;
    if (modes.has("stderr")) process.stderr.write(`handling ${request.method}\n`);
    if (modes.has("slow")) await sleep(delayMs);
    if (modes.has("garbage")) process.stdout.write(`noise before ${request.id}${eol}`);
    const { exit, ...body } = handle(request);
    await send({ id: request.id, ...body });
    answered += 1;
    if (exit !== undefined) exitAfterFlush(exit);
    if (modes.has("crash-after") && answered >= crashAfter) exitAfterFlush(1);
  });
});
rl.on("close", () => process.exit(0));
