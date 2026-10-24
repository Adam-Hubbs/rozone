import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TierState } from "../../../src/enhanced/api.ts";
import { describeState } from "../../../src/enhanced/statusModel.ts";

describe("describeState", () => {
  it("maps the three tiers to the documented status bar text", () => {
    assert.equal(describeState({ tier: "enhanced" }).text, "rozone: enhanced");
    assert.equal(describeState({ tier: "enhanced+help" }).text, "rozone: enhanced + help");
    assert.equal(describeState({ tier: "base", reason: "untrusted" }).text, "rozone: base");
  });

  it("explains every base reason in the tooltip", () => {
    const expectations: [Extract<TierState, { tier: "base" }>["reason"], RegExp][] = [
      ["untrusted", /not trusted/],
      ["disabled", /rozone\.enhanced\.enabled/],
      ["no-r", /No R/],
      ["no-roxygen2", /roxygen2 package is not installed/],
      ["crashed", /crashed/],
      ["virtual", /Virtual/],
    ];
    for (const [reason, pattern] of expectations) {
      assert.match(describeState({ tier: "base", reason }).tooltip, pattern, reason);
    }
  });

  it("shows base while starting", () => {
    const view = describeState({ tier: "starting" });
    assert.equal(view.text, "rozone: base");
    assert.match(view.tooltip, /Starting/);
  });
});
