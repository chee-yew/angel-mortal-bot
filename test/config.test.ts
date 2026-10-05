import assert from "node:assert/strict";
import { parseAdminIds } from "../src/config.ts";

assert.deepEqual(parseAdminIds(undefined), { ids: [], invalid: [] });
assert.deepEqual(parseAdminIds(""), { ids: [], invalid: [] });
assert.deepEqual(parseAdminIds(" 123 , 456,"), { ids: [123, 456], invalid: [] });
assert.deepEqual(parseAdminIds("123,@alice,12a"), { ids: [123], invalid: ["@alice", "12a"] });

console.log("config tests passed");
