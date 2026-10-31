// build-host 防回归：danger-guard 的两份产物（host.js 与 settings.js，均由 build-host.mjs
// 的 buildEntry 出）里跨包依赖必须保持 external 裸说明符，**且一个都不许被内联**。
//
// 为什么本包单独建一份：此前登记的已知缺口——danger-guard 是 9 个发布包里唯一没有
// build-host 钉测的，它的 brandNumber 被内联进 host.js 时没人能发现。dsh-brand 这类值导入
// 必须外部化（落 peer，不进 dependencies，见 publish-manifest 的门禁）的裁定落地之后，
// "说明符在、函数体不在"两件事必须一起钉：只钉前者会在有人把它挪出外部化名单（只留 dev）时
// 静默放行内联产物。
//
// ⚠ 产物开 `minify: true` 之后，这两条判据的写法都变过（各有实测依据）：
//   ① 说明符判据必须**容忍空白**：minify 后是 `from"x"` 而不是 `from "x"`（早先一句
//      "压缩后说明符双双消失"的结论就是被这个空格差异骗出来的 —— 说明符一直在）。
//   ② 内联判据必须是**结构性**的：minify 会 mangle 内联体的函数名（实测：故意不外部化
//      dsh-brand 时，产物里 `brandNumber` 一次都查不到）⇒ 任何 `/function brandNumber\(/`
//      式的文本判据都变成**恒绿**，而恒绿的闸门比没有闸门更坏。所以改成看 chunk 的
//      `moduleIds`：本包源码全是绝对路径，依赖表里的包名一旦出现在那张清单里就是内联。
//
// settings.js 那条反向断言（**不**含 dsh-brand）同样是钉死的：实测设置半不导入 brand，
// 若将来把 brand 用法挪进 settings-host.ts 而不补声明，这条会红而不是静默内联。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildHostReport, buildSettingsReport, singleEntryChunk } from "../build-host.mjs";
import { hostFreshnessEvidence } from "./host-freshness.ts";

/** 残留的本地 .ts 说明符（`from "./x.ts"`）：Node 在 node_modules 内对 .ts 直接抛 ERR_UNSUPPORTED…。 */
const LOCAL_TS_IMPORT = /from\s*["']\.{1,2}\/[^"']*\.ts["']/u;

/** 该说明符是不是以**裸说明符**出现。`\s*` 是必须的：minify 去掉 `from "x"` 里的空格。 */
const hasSpecifier = (code: string, specifier: string): boolean =>
  new RegExp(
    `from\\s*["']${specifier.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)}["']`,
    "u",
  ).test(code);

/** 本包四个依赖段的包名——**独立**取，不借构建脚本的口径。
 *  构建器只外部化 dependencies / peerDependencies / optionalDependencies；devDependencies
 *  一并收进来是为了让「运行期代码误引构建期依赖」以"被内联"的形状变红，而不是因为它属于
 *  外部化集合。 */
function declaredPackages(): string[] {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
  );
  const pkg = raw as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return [
    ...new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]),
  ];
}

/** 说明符或模块 id 的包名段：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。 */
function packageNameOf(id: string): string {
  const segments = id.split("/");
  return id.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? id);
}

/** 包名的目录段：`@scope/pkg` → `pkg`（工作区真实路径里没有 scope 段）。 */
const bareNameOf = (name: string): string => name.slice(name.lastIndexOf("/") + 1);

/** 内联清单里来自**依赖表**的模块。两条路径形状都要认：
 *  - 正常依赖以 `node_modules/…` 出现；
 *  - 工作区软链会被 rolldown 折成**真实路径**（不含 `node_modules/`，如
 *    `/repo/dsh-plugin-shared/lib/record.ts`），只能按目录段比对包名。 */
function inlinedDependencies(inlinedModules: readonly string[]): string[] {
  const declared = declaredPackages();
  return inlinedModules
    .map((id) => {
      const at = id.lastIndexOf("node_modules/");
      if (at !== -1) {
        const name = packageNameOf(id.slice(at + "node_modules/".length));
        return declared.includes(name) ? name : undefined;
      }
      const segments = id.split(/[\\/]/u);
      return declared.find((name) => segments.includes(bareNameOf(name)));
    })
    .filter((name): name is string => name !== undefined);
}

describe("danger-guard 两份 host 产物的外部化", () => {
  it("host.js：跨包依赖都是裸说明符，且一个都没被内联（结构性判据）", async () => {
    const { code: host, inlinedModules } = await buildHostReport();
    assert.ok(
      hasSpecifier(host, "@deepseek-ai/dsh-brand"),
      "dsh-brand 必须外部化（口径 A：值导入落 peerDependencies，不进 dependencies）",
    );
    assert.ok(
      hasSpecifier(host, "@jayyuen66/dsh-plugin-shared/lib/record"),
      "shared/record 必须外部化（isRecord 是跨包单点）",
    );
    // 预检（Phase 2）新增的第二枚值导入：注入消息用官方 createUserMessage。它落在
    // peerDependencies（与 dsh-brand 同一口径）——内联的代价和 brandNumber 一样：每包各持
    // 一份官方实现（这里是消息 id 铸造与深冻结）。
    assert.ok(
      hasSpecifier(host, "@deepseek-ai/dsh-llm"),
      "dsh-llm 必须外部化（预检注入用它的 createUserMessage）",
    );
    // 名字判据在 minify 下会瞎（见文件头），所以这一半改成看**打进了哪些模块**：
    // 依赖表里的包名出现在 chunk 里 = 它被内联了。
    assert.deepEqual(
      inlinedDependencies(inlinedModules),
      [],
      "host.js 内联了依赖表里的包（external 名单被挪动了？）",
    );
    // 正向锚：清单非空且含本包入口，否则上面的空集断言会在构建器交回空清单时空转。
    assert.ok(
      inlinedModules.some((id) => /[\\/]host\.ts$/u.test(id)),
      "内联清单必须含本包入口源码",
    );
    assert.equal(LOCAL_TS_IMPORT.test(host), false, "不得残留 ./x.ts 说明符");
  });

  it("settings.js：shared 与 schemastery 外部化、不含 dsh-brand、也不内联依赖", async () => {
    const { code: settings, inlinedModules } = await buildSettingsReport();
    assert.ok(
      hasSpecifier(settings, "@jayyuen66/dsh-plugin-shared/lib/record"),
      "settings.js 的 shared/record 必须外部化",
    );
    assert.ok(
      hasSpecifier(settings, "@deepseek-ai/schemastery"),
      "settings.js 的 schema 引擎必须仍是宿主 fork 的 schemastery",
    );
    assert.equal(
      hasSpecifier(settings, "@deepseek-ai/dsh-brand"),
      false,
      "设置半不导入 dsh-brand；出现说明符说明有人挪了 brand 用法却没补声明",
    );
    assert.deepEqual(inlinedDependencies(inlinedModules), [], "settings.js 内联了依赖表里的包");
    assert.ok(
      inlinedModules.some((id) => /[\\/]settings-host\.ts$/u.test(id)),
      "内联清单必须含设置入口源码",
    );
    assert.equal(LOCAL_TS_IMPORT.test(settings), false, "不得残留 ./x.ts 说明符");
  });
});

describe("inlinedDependencies 的路径判定", () => {
  it("工作区软链折出的真实路径按目录段认出（不依赖 node_modules/ 字样）", () => {
    assert.deepEqual(inlinedDependencies(["/repo/packages/dsh-plugin-shared/lib/record.ts"]), [
      "@jayyuen66/dsh-plugin-shared",
    ]);
  });

  it("devDependencies 被值引入同样算内联（它不在构建器的外部化集合里）", () => {
    assert.deepEqual(inlinedDependencies(["/repo/node_modules/rolldown/dist/index.mjs"]), [
      "rolldown",
    ]);
  });

  it("本包源码不算依赖内联", () => {
    assert.deepEqual(inlinedDependencies([path.join(import.meta.dirname, "..", "host.ts")]), []);
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

/** 输出守卫测试用的最小 chunk 正文。 */
const CHUNK_CODE = "export {};";
/** 输出守卫测试用的产物文件名。 */
const ARTIFACT_FILE = "artifact.js";

/**
 * 造一个最小输出项；判据只看 type/fileName/isEntry/code。
 * @param type - rolldown 输出项类型
 * @param fileName - 产物文件名
 * @param extra - 该类型需要的其余字段
 * @returns 可交给 singleEntryChunk 的输出项
 */
function outputItem(
  type: string,
  fileName: string,
  extra: Partial<{ isEntry: boolean; code: string }> = {},
): { type: string; fileName: string } & Partial<{ isEntry: boolean; code: string }> {
  return { type, fileName, ...extra };
}

describe("单文件产物的输出守卫", () => {
  it("拒绝多个 chunk：单文件产物不能静默丢掉第二个", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE }),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("拒绝 asset：单文件产物没有落盘 asset 的位置", () => {
    const output = [
      outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE }),
      outputItem("asset", "x.css"),
    ];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /2 项输出/u);
  });

  it("拒绝非 entry 的单个 chunk", () => {
    const output = [outputItem("chunk", "chunk-abc.js", { isEntry: false, code: CHUNK_CODE })];
    assert.throws(() => singleEntryChunk(output, "entry.ts"), /entry chunk/u);
  });

  it("接受唯一的 entry chunk", () => {
    const output = [outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: CHUNK_CODE })];
    const chunk = singleEntryChunk(output, "entry.ts");
    assert.equal(chunk.code, CHUNK_CODE);
  });
});
