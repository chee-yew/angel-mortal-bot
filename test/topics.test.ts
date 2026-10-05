import assert from "node:assert/strict";
import { messageLabel, roleForThread, tabName, threadIdFor } from "../src/topics.ts";

assert.equal(messageLabel("mortal", "alice_tan"), "🙂 Mortal (@alice_tan)");
assert.equal(messageLabel("angel", "alice_tan"), "😇 Angel");
assert.ok(!messageLabel("angel", "alice_tan").includes("alice_tan")); // an angel is never named

assert.equal(tabName("mortal", "bob_lim"), "🙂 Mortal: @bob_lim (you care for them)");
assert.equal(tabName("mortal", null), "🙂 Mortal: none assigned");
assert.equal(tabName("angel", "bob_lim"), "😇 Angel: secret (cares for you)"); // never names anyone
for (const name of [tabName("mortal", "a".repeat(32)), tabName("angel", null)]) assert.ok(name.length <= 128); // Telegram's limit

const p = { angel_thread_id: 11, mortal_thread_id: 22 };
assert.equal(threadIdFor(p, "angel"), 11);
assert.equal(threadIdFor(p, "mortal"), 22);
assert.equal(roleForThread(p, 11), "angel");
assert.equal(roleForThread(p, 22), "mortal");
assert.equal(roleForThread(p, 33), null); // some other topic
assert.equal(roleForThread(p, undefined), null); // General area

const noTabs = { angel_thread_id: null, mortal_thread_id: null };
assert.equal(threadIdFor(noTabs, "angel"), null);
assert.equal(roleForThread(noTabs, undefined), null);
assert.equal(roleForThread(noTabs, 11), null);

console.log("topics tests passed");
