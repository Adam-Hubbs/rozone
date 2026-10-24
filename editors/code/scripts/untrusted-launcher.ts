#!/usr/bin/env node
// @vscode/test-electron always passes --disable-workspace-trust, which would make every workspace trusted.
// This wrapper launches the real VS Code/Positron executable without that flag.
import { spawn } from "node:child_process";

const real = process.env.ROZONE_REAL_EXECUTABLE;
if (!real) {
  console.error("ROZONE_REAL_EXECUTABLE is not set");
  process.exit(2);
}

const args = process.argv.slice(2).filter((arg) => arg !== "--disable-workspace-trust");
const child = spawn(real, args, { stdio: "inherit", env: process.env });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
