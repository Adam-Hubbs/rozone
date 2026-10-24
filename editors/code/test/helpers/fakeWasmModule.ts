import { FakeIndex } from "./fakeIndex.ts";
import { createFakeWasm } from "./fakeIndex.ts";

const { wasm, behavior } = createFakeWasm();
behavior.poisonMarker = "PANIC";

export class RozoneIndex extends FakeIndex {
  constructor() {
    super(behavior);
  }

  override updateFile(path: string, text: string) {
    if (text.includes("EXIT")) process.exit(3);
    super.updateFile(path, text);
  }
}

export const contentHash = wasm.contentHash;
export const version = wasm.version;
