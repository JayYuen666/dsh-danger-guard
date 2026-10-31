// test/target-paths.test.ts —— 目标路径的两种"不是模型字面量"的形：键形与表形。
//
// 这个文件盯的是两张**模型能影响的表**：解析形表的键是模型给的目标字符串，
// 官方路径缓存的键是归一后的目标。两者都曾被当成"反正就是个 Record"：
// 前者在 `__proto__` 上改的是原型而不是加键，后者让同一枚文件的四种写法各占一格。
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import {
  officialPathKeyOf,
  resolveTarget,
  officialPathOf,
  rememberOfficialPath,
  clearOfficialPaths,
  resolvedFormsOf,
} from "../lib/target-paths.ts";

const PROTO_KEY = "__proto__";
const CTOR_KEY = "constructor";
const TO_STRING_KEY = "toString";
const ORDINARY_KEY = "普通路径";
const KEY_PATH = ".ssh/id_rsa";

/** 工作区根：按平台根拼，不写死 POSIX 形（Windows 上 `/w` 是「当前盘相对」，落点会漂）。 */
const W_ROOT = path.resolve(path.parse(process.cwd()).root, "w");
/** 官方缓存里那一形（与 W_ROOT 无关，任何绝对路径都行）。 */
const REAL_PATH = path.resolve(path.parse(process.cwd()).root, "real", "id_rsa");

/** 一台"解析即原样"的本机形解析（这些用例只关心键与表的形状，不关心软链语义）。 */
const identityRealpath = (target: string): string => target;

describe("resolvedFormsOf：键是模型给的目标字符串，不能让原型吃到", () => {
  it("目标写成 __proto__ ⇒ 它是一条**自有**键，不是改这张表的原型", () => {
    const forms = resolvedFormsOf([PROTO_KEY, ORDINARY_KEY], W_ROOT, identityRealpath);
    assert.equal(Object.hasOwn(forms, PROTO_KEY), true, "__proto__ 必须成为自有关键字");
    assert.deepEqual(Object.getOwnPropertyDescriptor(forms, "__proto__")?.value, [PROTO_KEY]);
    assert.equal(Object.getPrototypeOf(forms), Object.prototype, "表的原型不能被换掉");
    assert.deepEqual(Object.keys(forms), [PROTO_KEY, ORDINARY_KEY]);
  });

  it("键是 constructor / toString 时查表拿到的是这一枚目标自己的清单", () => {
    const forms = resolvedFormsOf([CTOR_KEY, TO_STRING_KEY], W_ROOT, identityRealpath);
    assert.deepEqual(Object.getOwnPropertyDescriptor(forms, CTOR_KEY)?.value, [CTOR_KEY]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(forms, TO_STRING_KEY)?.value, [TO_STRING_KEY]);
  });
});

describe("resolveTarget：绝对形也折成规范形（它同时是缓存的键）", () => {
  // 缓存是模块级的：任何一条用例失败也不能带着 REAL_PATH 残留进后续用例。
  afterEach(() => {
    clearOfficialPaths();
  });

  it("绝对形折掉 `.`、`..` 与尾分隔符", () => {
    const expected = path.join(W_ROOT, KEY_PATH);
    assert.equal(resolveTarget(`${W_ROOT}/./${KEY_PATH}`, W_ROOT), expected);
    assert.equal(resolveTarget(`${W_ROOT}/x/../${KEY_PATH}`, W_ROOT), expected);
    assert.equal(resolveTarget(`${W_ROOT}/${KEY_PATH}/`, W_ROOT), expected);
    // 绝对形与 cwd 无关：给不给 cwd 折出来都一样。
    const withDot = `${W_ROOT}/./a`;
    assert.equal(resolveTarget(withDot, undefined), resolveTarget(withDot, "/other"));
  });

  it("解析形表按**声明形**建键（读侧也按声明形查，两侧同源；归一发生在缓存键那一侧）", () => {
    const declared = [`${W_ROOT}/./${KEY_PATH}`, `${W_ROOT}/${KEY_PATH}`];
    const forms = resolvedFormsOf(declared, W_ROOT, identityRealpath);
    assert.deepEqual(Object.keys(forms), declared);
  });

  it("各种写法算出来的键相同 ⇒ 官方那一形对四种写法都读得到", () => {
    const declared = `${W_ROOT}/${KEY_PATH}`;
    rememberOfficialPath(declared, W_ROOT, REAL_PATH);
    for (const written of [
      declared,
      `${W_ROOT}/./${KEY_PATH}`,
      `${W_ROOT}/x/../${KEY_PATH}`,
      `${W_ROOT}/${KEY_PATH}/`,
    ]) {
      assert.equal(officialPathOf(written, W_ROOT), REAL_PATH, `${written} 应当读到同一格`);
    }
  });

  it("空串原样交回：模型没给目标（`edit`/`write` 之外的工具会带空 path）", () => {
    assert.equal(resolveTarget("", W_ROOT), "");
    assert.equal(officialPathKeyOf("", undefined), "");
  });

  it("cwd 缺席时相对路径原样交回（那时 cwd 是插件进程的目录，拿它归一是猜）", () => {
    assert.equal(officialPathKeyOf("a/.env", undefined), "a/.env");
    // 绝对形与 cwd 无关，仍然归一。
    assert.equal(officialPathKeyOf(`${W_ROOT}/./a/.env`, undefined), path.join(W_ROOT, "a/.env"));
  });

  it("cwd 是空串时与缺席同视：不能落到插件进程自己的目录", () => {
    assert.equal(officialPathKeyOf("a/.env", ""), "a/.env");
    assert.equal(resolveTarget("a/.env", ""), "a/.env");
  });
});

describe("rememberOfficialPath：空值不是一形", () => {
  it("后端交回空串时什么都不记，读侧仍判官方那一形缺席", () => {
    clearOfficialPaths();
    rememberOfficialPath(KEY_PATH, W_ROOT, "");
    assert.equal(officialPathOf(KEY_PATH, W_ROOT), undefined);
  });
});
