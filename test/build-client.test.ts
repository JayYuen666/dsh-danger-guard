// build-client 冒烟：client.js 产出且含设置卡关键文案。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isExternalModule, singleEntryChunk } from "../build-client.mjs";
import { declareClientFreshness } from "./client-freshness.ts";
import { declareSchemaCoverage } from "./schema-coverage.ts";

/** 构建产物相对本文件的定位符（`npm run build:client` 的唯一出口，三条用例都读它）。 */
const CLIENT_BUNDLE_SPEC = "../client.js";

// 产物开 `minify: true` 之后，文本判据的**粒度**被两件事限死（都是实测）：
//   ① 标识符（变量/函数/参数名）会被 mangle ⇒ `const inject = [...]`、`ctx.configForms.get(…)`
//      这种**带名字**的判据全部失效（写下去就是恒绿/恒红的假门禁）；
//   ② 引号会被换成最短的那个（实测压成了反引号）⇒ 判据里不能写死 `"`。
// 剩下的可信粒度是**属性名**（不 mangle）与**字面量**（引号类型可容忍）。下面两条助手就是它。

/** 入口 inject 清单：三项、顺序、闭合全钉死，引号容忍三种形态。 */
const INJECT_LIST = /\[\s*[`"']slots[`"']\s*,\s*[`"']configForms[`"']\s*,\s*[`"']locale[`"']\s*\]/u;

/** 产物里 `configForms.get(<设置条目 id>)` 的那个实参（属性链不 mangle，字面量可查）。 */
const CONFIG_FORM_LOOKUP = /\.configForms\.get\(\s*[`"'](?<id>[^`"']+)[`"']\s*\)/u;

/**
 * 从 `cordis.patch.yml` 取**设置条目**的 id（它就是紧挨着 `name: "…/settings"` 的那一行 id）。
 *
 * 为什么从组合清单里取而不是在用例里写死：这条判据要防的正是**两处漂开** —— 卡片按命名空间
 * 取表单，而那个命名空间必须是随包发布的组合清单里真正挂着 schema 的那一行。
 */
function settingsEntryId(): string {
  const patch = readFileSync(path.join(import.meta.dirname, "..", "cordis.patch.yml"), "utf8");
  const id = /-\s*id:\s*(?<id>\S+)\s*\n\s*name:\s*"[^"]*\/settings"/u.exec(patch)?.groups?.["id"];
  assert.ok(
    id !== undefined,
    "cordis.patch.yml 里找不到设置条目（name 以 /settings 结尾的那一行）",
  );
  return id;
}

await declareClientFreshness(import.meta.url);
await declareSchemaCoverage(import.meta.url, {
  // 预检开关（`preflightEnabled`，Phase 2）本轮只落设置面与拦截半：卡片控件要同时改 client
  // 产物、`src/ui-messages.ts` 的两语文案与卡片用例，而规格把卡片入口划在范围外。
  // 它并非"无处可关"——`- id: danger-guard-settings` 那一行的 `config.preflightEnabled`
  // 与设置命名空间都直接生效（它就是 schema 字段，越界校验走同一份）。故这里按
  // "确无 UI 入口" 显式豁免，而不是在 client 源码里挂一个不渲染的假绑定。
  allowUnbound: [
    {
      field: "preflightEnabled",
      reason: "本轮只落设置面与拦截半：卡片控件（含 ui-messages 两语文案）不在本次规格内",
    },
  ],
});

describe("danger-guard client 构建", () => {
  it("client.js 已产出且含设置卡与开关文案", async () => {
    const clientJsPath = fileURLToPath(new URL(CLIENT_BUNDLE_SPEC, import.meta.url));
    const exists = await stat(clientJsPath)
      .then(() => true)
      .catch(() => false);
    assert.ok(exists, "client.js 必须存在（npm run build:client 产物）");
    const text = await readFile(clientJsPath, "utf8");
    assert.ok(text.includes("danger-guard"), "模块名");
    assert.ok(text.includes("危险拦截"), "卡片标题");
    assert.ok(text.includes("factGateEnabled"), "事实门开关字段");
  });

  it("卡片 props 契约正确：读 useCard，不读会崩的 props.hooks（v7 修复）", async () => {
    const clientJsPath = fileURLToPath(new URL(CLIENT_BUNDLE_SPEC, import.meta.url));
    const text = await readFile(clientJsPath, "utf8");
    // 框架 InjectFace/PropsHooks（client-runner）：注入 { hooks: { card } } → prop useCard
    assert.ok(text.includes("useCard"), "必须用 useCard 读快照");
    // ⚠ 判据粒度：原来的 `props.hooks.card` 在压缩产物里**不可能**出现（`props` 会被 mangle）
    // ⇒ 那条恒绿。属性名不 mangle，所以钉**属性链**：真出现回归时产物里就是 `X.hooks.card`。
    assert.ok(!text.includes(".hooks.card"), "不得读会崩的 props.hooks.card 属性链");
  });

  it("产物入口只列 0.1.7 仍在的服务（configForms 取代已移除的 settingsScope）", async () => {
    const clientJsPath = fileURLToPath(new URL(CLIENT_BUNDLE_SPEC, import.meta.url));
    const text = await readFile(clientJsPath, "utf8");
    // inject 清单是装配契约，产物里必须原样可查：`settingsScope` 在 installed 0.1.7 全树
    // 零命中，只要它回到清单里，整条 client 入口就挂不上（症状 = 设置卡静默消失）。
    // 替代面 = configForms（installed dsh-client-ui-settings/lib/types/client/
    // config-form.d.ts:94-98 的 Context 增强 + :142 的 get<T>(entryId): ConfigForm<T>）。
    // 三项、顺序、闭合全钉死（不放宽为包含判定）：变量名会被 mangle，故判据钉数组项本身。
    assert.match(text, INJECT_LIST, "入口 inject 清单必须是 slots / configForms / locale 三项");
    assert.ok(!text.includes("settingsScope"), "不得再向宿主索要已移除的 settingsScope 服务");
    // 取表单走 configForms.get(**设置条目 id**)——本包是 bulkhead，卡片写的命名空间是
    // danger-guard-settings（持有 Config 的那一行），不是拦截条目 danger-guard。
    // 这里把产物里的实参与 cordis.patch.yml 的那一行**对质**：两处漂开就是卡片静默读不到表单。
    const idInBundle = CONFIG_FORM_LOOKUP.exec(text)?.groups?.["id"];
    assert.equal(
      idInBundle,
      settingsEntryId(),
      "product 里 configForms.get 的实参必须是设置条目 id",
    );
    // 表单是 provider 持有的共享对象，消费契约 ConfigForm 里没有 dispose
    //（installed config-form-types.d.ts 的 ConfigForm）：slot disposer 只注销登记。
    // 判据取全链 `.dispose()`：客户端产物里**一处**都不该有（表单归 provider 持有）。
    assert.ok(!/\.dispose\(\)/u.test(text), "产物不得销毁 provider 的表单");
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

  it("拒绝正文为空或纯空白的 entry chunk", () => {
    // 只带 `// GENERATED` 头、正文为空时，产物在装载期才炸，而那时宿主只报一句与根因无关的
    // 解析错误。构建期是唯一能把它与"正常产物"分开的地方。
    for (const blank of ["", "   ", "\n\t "]) {
      const output = [outputItem("chunk", ARTIFACT_FILE, { isEntry: true, code: blank })];
      assert.throws(() => singleEntryChunk(output, "entry.ts"), /entry chunk/u);
    }
  });
});

describe("外部化判据：react 家族只放行宿主 seed 表真有的那四条", () => {
  it("登记过的四条说明符外置", () => {
    for (const id of ["react", "react/jsx-runtime", "react-dom", "react-dom/client"]) {
      assert.equal(isExternalModule(id), true, `${id} 应外置`);
    }
  });

  it("react 家族里未登记的说明符当场失败而不是静默内联", () => {
    // 静默内联 = 产物里打进第二份 React，页面里两个实例，hooks 直接报错；
    // 前缀放行 = 得到一条宿主模块表里没有的 require，整张卡片静默不渲染。
    for (const id of ["react/jsx-dev-runtime", "react-dom/server", "react/experimental"]) {
      assert.throws(() => isExternalModule(id), /不在外置清单/u, `${id} 应构建失败`);
    }
  });

  it("非 react 家族的第三方模块走常规打包（不外置、不报错）", () => {
    for (const id of ["zod", "@jayyuen66/dsh-plugin-shared", "./local.ts"]) {
      assert.equal(isExternalModule(id), false, `${id} 应打包进产物`);
    }
  });
});
