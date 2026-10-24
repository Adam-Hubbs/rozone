import assert from "node:assert/strict";
import * as vscode from "vscode";
import { activateRozone, hoversAt, hoverText, openFixture, positionOf, waitForInitialIndex } from "../support.ts";

suite("trusted workspace", () => {
  test("the workspace is trusted and the base tier works alongside the enhanced tier", async () => {
    assert.equal(vscode.workspace.isTrusted, true);
    const rozone = await activateRozone();
    await waitForInitialIndex(rozone);
    const doc = await openFixture("example_script.R");
    assert.match(hoverText(await hoversAt(doc, positionOf(doc, "wmean({{", 2))), /weighted mean/i);
  });
});
