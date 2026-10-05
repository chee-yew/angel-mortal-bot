import assert from "node:assert/strict";
import { roleForThread, threadIdFor } from "../src/topics.ts";

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
