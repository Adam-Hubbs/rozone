import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export const wasmModulePath = fileURLToPath(new URL("../../wasm/rozone_wasm.js", import.meta.url));

export const loadRozone = () => require(wasmModulePath);

export const examplePath = fileURLToPath(new URL("../../../../spike/example_script.R", import.meta.url));

export const exampleText = readFileSync(examplePath, "utf8");

export function fnv1a64(text) {
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export const wmeanManifest = (path, text, contentHash) => ({
  version: 1,
  files: [
    {
      path,
      content_hash: contentHash(text),
      topics: [
        {
          name: "wmean",
          aliases: ["wmean"],
          title: "Weighted mean of a column",
          description_md: "Computes a weighted mean, dropping `NA` pairs.",
          details_md: null,
          params: [
            { name: "x", md: "A numeric vector." },
            { name: "w", md: "Weights, the same length as `x`." },
          ],
          returns_md: "A length-1 double.",
          sections: [],
          examples: "wmean(1:3, c(1, 1, 2))",
          inherited_from: [],
        },
      ],
    },
  ],
});
