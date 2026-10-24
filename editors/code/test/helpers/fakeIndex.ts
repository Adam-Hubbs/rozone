import type { IndexLike, WasmModule } from "../../src/base/indexHost.ts";
import type { CoreHover } from "../../src/base/types.ts";

export interface FakeBehavior {
  /** Throw from updateFile when the text contains this marker, like a parser panic would. */
  poisonMarker?: string;
  /** Throw from hover for this path. */
  hoverPanicsFor?: string;
  /** Number of times a RozoneIndex has been constructed. */
  constructed: number;
  instances: FakeIndex[];
  freed: number;
}

export class FakeIndex implements IndexLike {
  files = new Map<string, string>();
  manifest: string | undefined;
  freed = false;
  behavior: FakeBehavior;

  constructor(behavior: FakeBehavior) {
    this.behavior = behavior;
    behavior.constructed++;
    behavior.instances.push(this);
  }

  updateFile(path: string, text: string) {
    if (this.behavior.poisonMarker && text.includes(this.behavior.poisonMarker)) {
      throw new Error("unreachable");
    }
    this.files.set(path, text);
  }

  removeFile(path: string) {
    this.files.delete(path);
  }

  loadManifest(json: string) {
    JSON.parse(json);
    this.manifest = json;
  }

  clearManifest() {
    this.manifest = undefined;
  }

  hover(path: string, offset: number): CoreHover | undefined {
    if (this.behavior.hoverPanicsFor === path) throw new Error("unreachable");
    const text = this.files.get(path);
    if (text === undefined) return undefined;
    return { name: "f", kind: "call", markdown: `hover@${offset}`, range: { start: offset, end: offset + 1 }, source: "static" };
  }

  signatureHelp() {
    return undefined;
  }

  documentation(name: string) {
    return this.files.size > 0 ? `# ${name}` : undefined;
  }

  documentedFunctions() {
    return [...this.files.keys()].map((path) => ({ name: "f", path, range: { start: 0, end: 1 }, title: null }));
  }

  free() {
    this.freed = true;
    this.behavior.freed++;
  }
}

export function createFakeWasm(): { wasm: WasmModule; behavior: FakeBehavior } {
  const behavior: FakeBehavior = { constructed: 0, instances: [], freed: 0 };
  const wasm: WasmModule = {
    RozoneIndex: class extends FakeIndex {
      constructor() {
        super(behavior);
      }
    },
    contentHash: (text) => `hash:${text.length}`,
    version: () => "fake",
  };
  return { wasm, behavior };
}
