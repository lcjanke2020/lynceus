// L3 Node conditional breakpoint: set_breakpoint with `condition: "i === 3"`
// against a 5-iteration loop must pause only on the matching iteration.
// Validates the condition primitive end-to-end on Node; the L4 scenario
// reuses the same fixture but tests whether the agent CHOOSES
// the condition rather than 5×resume.
//
// set_breakpoint's response envelope does NOT echo the `condition` field
// (per src/tools/breakpoints.ts:26-34 — only id/resolved_locations/
// binding_count/sessions_bound/status). list_breakpoints does include it
// (line 147), so that's where we round-trip the condition for the
// "did this actually wire up" assertion.

import { describe, it, expect } from "vitest";
import { buildToolMap, call } from "./helpers/build-tools.js";
import { fixtureScript } from "./helpers/node-target.js";
import { waitFor } from "./helpers/wait-for.js";

const tools = buildToolMap();

describe("node conditional breakpoint (e2e)", () => {
  it("set_breakpoint with condition fires only on the matching iteration", async () => {
    await call(tools, "launch_node", { script: fixtureScript("conditional-bp") });

    await call(tools, "wait_for_pause", { timeout_ms: 10_000 });

    // Conditional bp on a line that runs EVERY loop iteration — the
    // processIteration() call site at conditional-bp.ts:16. WITHOUT the
    // condition this bp would fire 5 times (once per i in 0..4); the
    // condition is the only thing narrowing firings to i===3. Setting
    // the bp inside the i===3 branch (e.g. line 9) would only execute
    // when i===3 by control flow alone, so the test could not
    // distinguish a wired condition from an ignored one.
    const bp = await call<{
      id: string;
      status: string;
      binding_count: number;
    }>(tools, "set_breakpoint", {
      file: "conditional-bp.ts",
      line: 16,
      condition: "i === 3",
    });
    expect(bp.status).toBe("set");
    expect(bp.binding_count).toBeGreaterThanOrEqual(1);

    // Confirm condition round-tripped (set_breakpoint response doesn't echo it).
    const list = await call<Array<{ id: string; condition?: string }>>(tools, "list_breakpoints");
    const ours = list.find((b) => b.id === bp.id);
    expect(
      ours,
      `expected bp ${bp.id} in list_breakpoints; got [${list.map((b) => b.id).join(", ")}]`,
    ).toBeTruthy();
    expect(ours!.condition).toBe("i === 3");

    await call(tools, "resume");

    // The bp must fire on the matching iteration. If V8 ignored the
    // condition, the first wait_for_pause after resume would fire at
    // i=0 instead.
    const hit = await call<{
      hit_breakpoint_ids: string[];
      call_stack: Array<{ file: string; line: number }>;
    }>(tools, "wait_for_pause", { timeout_ms: 10_000 });
    expect(hit.hit_breakpoint_ids).toContain(bp.id);
    expect(hit.call_stack[0]!.file).toMatch(/conditional-bp\.ts$/);

    // Verify `i === 3` at the pause. evaluate with return_by_value pulls
    // the primitive across the boundary.
    const eval_i = await call<{
      type: string;
      value: unknown;
      preview?: string;
    }>(tools, "evaluate", { expression: "i", return_by_value: true });
    expect(eval_i.value).toBe(3);

    // Honest default: get_scope() with NO scope_type must surface the
    // block-scoped loop variable `i` via the merged lexical view. Before this
    // fix the default read only the `local` scope, which omits `i` — the exact
    // gate the failing node-conditional-bp eval trials could not clear
    // (LEO-399 / GH #42). The evaluate("i") assertion above independently
    // covers the full-chain path.
    const scopeDefault = await call<{
      scope_type: string;
      merged_scope_types: string[];
      items: Array<{ name: string; preview?: string; value?: unknown }>;
    }>(tools, "get_scope", {});
    const iEntry = scopeDefault.items.find((it) => it.name === "i");
    expect(
      iEntry,
      `default get_scope must surface block-scoped 'i'; got [${scopeDefault.items
        .map((it) => it.name)
        .join(", ")}]`,
    ).toBeTruthy();
    expect(iEntry!.preview === "3" || iEntry!.value === 3).toBe(true);
    expect(scopeDefault.merged_scope_types).toContain("block");

    await call(tools, "resume");

    // Prove the bp fired ONLY ONCE: after the final resume the loop must
    // run i=4 to completion without a second pause. Poll get_node_output
    // for the `i=4 v=4` line (process.stdout.write from the fixture). A
    // regression like `condition: "i >= 3"` would pause again on i=4 and
    // this waitFor would time out — the single-hit assertion above would
    // NOT have caught that. The shared close_session afterEach handles
    // any tail state.
    await waitFor(
      async () => {
        const r = await call<{
          items: Array<{ text: string }>;
        }>(tools, "get_node_output", { search: "i=4 v=4" });
        return r.items.length > 0 ? r : null;
      },
      { describe: "get_node_output 'i=4 v=4' appears (no second pause)", timeoutMs: 5_000 },
    );
  });
});
