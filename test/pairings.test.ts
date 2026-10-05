import assert from "node:assert/strict";
import { parsePairings } from "../src/pairings.ts";

let r = parsePairings("angel,mortal\n@Alice_Tan, bob_lim\nbob_lim\tcharlie_ng\n\ncharlie_ng;alice_tan\n");
assert.deepEqual(r.pairs, [["alice_tan", "bob_lim"], ["bob_lim", "charlie_ng"], ["charlie_ng", "alice_tan"]]);
assert.deepEqual(r.errors, []);
assert.deepEqual(r.warnings, []);

r = parsePairings("alice_tan,alice_tan");
assert.ok(r.errors.some((e) => e.includes("themselves")));

r = parsePairings("alice_tan,bob_lim\nalice_tan,charlie_ng");
assert.ok(r.errors.some((e) => e.includes("angel more than once")));

r = parsePairings("alice_tan,bob_lim\ncharlie_ng,bob_lim");
assert.ok(r.errors.some((e) => e.includes("mortal more than once")));

r = parsePairings("alice_tan,bob_lim,extra");
assert.ok(r.errors.some((e) => e.includes("expected")));

r = parsePairings("al!ce,bob_lim");
assert.ok(r.errors.some((e) => e.includes("not a valid")));

r = parsePairings("alice_tan,bob_lim\nbob_lim,alice_tan");
assert.deepEqual(r.errors, []);
assert.ok(r.warnings.some((w) => w.includes("each other's")));

r = parsePairings("alice_tan,bob_lim");
assert.equal(r.warnings.length, 2); // open chain: alice has no angel, bob has no mortal

r = parsePairings("\n\n");
assert.ok(r.errors.includes("No pairings found."));

console.log("pairings tests passed");
