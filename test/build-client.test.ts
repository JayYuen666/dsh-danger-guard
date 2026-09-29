// build-client 冒烟：client.js 产出且含设置卡关键文案。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { declareClientFreshness } from "./client-freshness.ts";
import { declareSchemaCoverage } from "./schema-coverage.ts";

/** 构建产物相对本文件的定位符（`npm run build:client` 的唯一出口，三条用例都读它）。 */
const CLIENT_BUNDLE_SPEC = "../client.js";

await declareClientFreshness(import.meta.url);
await declareSchemaCoverage(import.meta.url);

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
    assert.ok(!text.includes("props.hooks.card"), "不得读 props.hooks.card（浏览器崩溃根因）");
  });

  it("产物入口只列 0.1.7 仍在的服务（configForms 取代已移除的 settingsScope）", async () => {
    const clientJsPath = fileURLToPath(new URL(CLIENT_BUNDLE_SPEC, import.meta.url));
    const text = await readFile(clientJsPath, "utf8");
    // inject 清单是装配契约，产物里必须原样可查：`settingsScope` 在 installed 0.1.7 全树
    // 零命中，只要它回到清单里，整条 client 入口就挂不上（症状 = 设置卡静默消失）。
    // 替代面 = configForms（installed dsh-client-ui-settings/lib/types/client/
    // config-form.d.ts:94-98 的 Context 增强 + :142 的 get<T>(entryId): ConfigForm<T>）。
    const raw = /const inject = \[(?<items>[^\]]*)\];/u.exec(text)?.groups?.["items"] ?? "";
    assert.ok(raw.length > 0, "产物里找不到入口 inject 清单");
    const items = raw
      .split(",")
      .map((piece) => piece.trim().replaceAll(/^["']|["']$/gu, ""))
      .filter((piece) => piece.length > 0);
    // 精确全等清单，不放宽为包含判定。
    assert.deepEqual(items, ["slots", "configForms", "locale"]);
    assert.ok(!text.includes("settingsScope"), "不得再向宿主索要已移除的 settingsScope 服务");
    // 取表单走 configForms.get(**设置条目 id**)——本包是 bulkhead，卡片写的命名空间是
    // danger-guard-settings（持有 Config 的那一行），不是拦截条目 danger-guard。
    assert.ok(
      text.includes("ctx.configForms.get(SETTINGS_NS)"),
      "取表单走 configForms.get(条目 id)",
    );
    const nsRaw = /const SETTINGS_NS = "(?<ns>[^"]+)";/u.exec(text)?.groups?.["ns"] ?? "";
    assert.equal(nsRaw, "danger-guard-settings", "产物里的设置条目 id 与 cordis.patch.yml 一致");
    // 表单是 provider 持有的共享对象，消费契约 ConfigForm 里没有 dispose
    //（installed config-form-types.d.ts:36-74）：slot disposer 只注销登记。
    assert.ok(!/form\.dispose\(\)|scope\.dispose\(\)/u.test(text), "产物不得销毁 provider 的表单");
  });
});
