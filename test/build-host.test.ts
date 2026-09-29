// build-host 防回归：danger-guard 的两份产物（host.js 与 settings.js，均由 build-host.mjs
// 的 buildEntry 出，见 :96/:106）里跨包依赖必须保持 external 裸说明符。
//
// 为什么本包单独建一份：此前登记的已知缺口——danger-guard 是 9 个发布包里唯一没有
// build-host 钉测的，它的 brandNumber 被内联进 host.js 时没人能发现。dsh-brand 移进
// dependencies 的裁定落地之后，"说明符在、函数体不在"两件事必须一起钉：只钉前者会
// 在有人把依赖挪回 dev 时静默放行内联产物。
//
// settings.js 那条反向断言（**不**含 dsh-brand）同样是钉死的：实测设置半不导入 brand，
// 若将来把 brand 用法挪进 settings-host.ts 而不补声明，这条会红而不是静默内联。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";

import { buildHost, buildSettings } from "../build-host.mjs";
import { hostFreshnessEvidence } from "./host-freshness.ts";

/** 残留的本地 .ts 说明符（`from "./x.ts"`）：Node 在 node_modules 内对 .ts 直接抛 ERR_UNSUPPORTED…。 */
const LOCAL_TS_IMPORT = /from\s*["']\.{1,2}\/[^"']*\.ts["']/u;

describe("danger-guard 两份 host 产物的外部化", () => {
  it("host.js：dsh-brand 与 shared 子路径都是裸说明符，且不内联 brandNumber", async () => {
    const host = await buildHost();
    assert.ok(
      host.includes('from "@deepseek-ai/dsh-brand"'),
      "dsh-brand 必须外部化（口径 A：值导入落 dependencies）",
    );
    assert.ok(!/^function brandNumber\(/mu.test(host), "host.js 不得内联 brandNumber 的函数体");
    assert.ok(
      host.includes('from "@jayyuen666/dsh-plugin-shared/lib/record"'),
      "shared/record 必须外部化（isRecord 是跨包单点）",
    );
    assert.equal(LOCAL_TS_IMPORT.test(host), false, "不得残留 ./x.ts 说明符");
  });

  it("settings.js：shared 与 schemastery 外部化，且不含 dsh-brand（设置半不导入它）", async () => {
    const settings = await buildSettings();
    assert.ok(
      settings.includes('from "@jayyuen666/dsh-plugin-shared/lib/record"'),
      "settings.js 的 shared/record 必须外部化",
    );
    assert.ok(
      settings.includes('from "@deepseek-ai/schemastery"'),
      "settings.js 的 schema 引擎必须仍是宿主 fork 的 schemastery",
    );
    assert.equal(
      settings.includes('from "@deepseek-ai/dsh-brand"'),
      false,
      "设置半不导入 dsh-brand；出现说明符说明有人挪了 brand 用法却没补声明",
    );
    assert.equal(
      /^function brand(?:Number|String)\(/mu.test(settings),
      false,
      "settings.js 不得内联官方品牌构造器",
    );
    assert.equal(LOCAL_TS_IMPORT.test(settings), false, "不得残留 ./x.ts 说明符");
  });
});

// 新鲜度指纹门禁（test/host-freshness.ts，与 client 侧 client-freshness.ts 对侧镜像）：
// 本包一条 builder 出两份产物，各钉一条逐字节比较——mtime 在 git clone / touch 下不可信，
// 而「host.ts 改过、host.js 没重跑」这种过期态只比字节才看得见（settings.js 同理由
// buildSettings() 单独产，历史上没有任何门看管过它）。
describe("danger-guard 两份 host 产物的新鲜度", () => {
  it("host.js 与最新构建逐字节一致（改 host.ts / lib/*.ts 后必须 node build-host.mjs）", async () => {
    const { pkgName, pkgDir, onDisk, built } = await hostFreshnessEvidence(import.meta.url);
    assert.equal(
      onDisk,
      built,
      onDisk === built
        ? "fresh"
        : `[${pkgName}] host.js 已过期：host.ts（或其依赖）变更后未重建。请运行：cd ${pkgDir} && node build-host.mjs`,
    );
  });

  it("settings.js 与最新构建逐字节一致（改 settings-host.ts 后必须 node build-host.mjs）", async () => {
    const { pkgName, pkgDir, onDisk, built } = await hostFreshnessEvidence(import.meta.url, {
      builder: "buildSettings",
      artifact: "settings.js",
    });
    assert.equal(
      onDisk,
      built,
      onDisk === built
        ? "fresh"
        : `[${pkgName}] settings.js 已过期：settings-host.ts 变更后未重建。请运行：cd ${pkgDir} && node build-host.mjs`,
    );
  });
});
