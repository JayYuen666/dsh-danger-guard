// lib/secret-glob 的 dotfile-only 判据：只由点与 glob 元字符组成才算，普通 dotfile 通配不放宽。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { isDotfileOnlyGlob } from "../lib/secret-glob.ts";

describe("isDotfileOnlyGlob", () => {
  it("只接受点后全为 glob 元字符的形态", () => {
    for (const form of [".*", ".??*", ".[]", ".**"]) {
      assert.equal(isDotfileOnlyGlob(form), true, form);
    }
    for (const form of [".", ".gitignore*", "*", "x*", ".env"]) {
      assert.equal(isDotfileOnlyGlob(form), false, form);
    }
  });
});
