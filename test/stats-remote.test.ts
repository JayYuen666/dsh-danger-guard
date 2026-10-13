// test/stats-remote.test.ts —— 判定统计读面（官方 Typert Remote）的**两侧契约**与注册路径。
//
// 为什么单列一份：这条读面横跨两个产物 —— 宿主侧 `lib/stats-remote.ts` 用**标准装饰器**声明
// 端点，客户端 `src/stats-reader.ts` **手写**同一枚 descriptor（不跑生成器，理由见那枚模块的
// 文件头）。两处一旦分叉，卡片不会报错，只会"读不到"或拿到未知命名空间 —— 所以这里把两侧拉到
// 一起对：用官方 `remoteMethods()` 读宿主真件写下的标记，再逐字段比对手写 descriptor。
//
// 覆盖面：`stats()` 与 `statsSnapshot()`（活表读数）、`installStatsRemote` 的真/假两条路、
// 以及"注册口缺席"那一族的四种形状。
import { describe, it } from "vitest";
import { strict as assert } from "node:assert";

import { Context } from "@deepseek-ai/cordis";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";

import { noteJudgeCost, noteQuotaRelease, noteRuleHit, SLOW_JUDGE_MS } from "../lib/judge-stats.ts";
import type { StatsSnapshot } from "../lib/judge-stats.ts";
import { installStatsRemote, STATS_SERVICE_KEY } from "../lib/stats-remote.ts";
import { STATS_DESCRIPTORS } from "../src/stats-reader.ts";

/** 从真 Context 上取回读面（服务键缺席时 `get` 给 undefined —— 断言里当场点名）。 */
function statsServiceOf(ctx: Context): { stats: () => StatsSnapshot } {
  const raw: unknown = ctx.get(STATS_SERVICE_KEY, false);
  assert.ok(raw !== undefined && raw !== null, "读面没注册到 STATS_SERVICE_KEY 上");
  return raw as { stats: () => StatsSnapshot };
}

/** 次数取值（缺席即 0）：读数表的语义就是"没有那一格 = 0 次"。 */
const countOf = (table: Readonly<Record<string, number>>, key: string): number => table[key] ?? 0;

describe("判定统计读面（官方 Typert Remote）", () => {
  it("真 Context：服务键注册上，且官方标记与**手写** descriptor 逐字段同值", () => {
    const ctx = new Context();
    assert.equal(installStatsRemote(ctx), true, "有注册口的上下文必须装得上");
    const service = statsServiceOf(ctx);
    const markers = remoteMethods(service);
    assert.deepEqual(
      markers.map((marker) => marker.method),
      ["stats"],
      "宿主侧标记的方法名集合（`@Remote` 写在哪个成员上）",
    );
    // 手写 descriptor 的那几个字段必须与宿主侧标记严丝合缝：分叉了卡片只会"读不到"。
    const [descriptor] = STATS_DESCRIPTORS;
    assert.ok(descriptor !== undefined, "客户端必须有一枚 descriptor");
    assert.equal(descriptor.service, STATS_SERVICE_KEY);
    assert.equal(descriptor.namespace, STATS_SERVICE_KEY);
    assert.equal(descriptor.method, markers[0]?.method);
    assert.equal(descriptor.invocation.kind, "direct");
    assert.equal(descriptor.parameters.length, 0, "无参端点：多一枚参数就得过生成器那套 codec");
    assert.equal(descriptor.result.mode, "src-json");
  });

  it("stats() 读的是活表：拒 / 需确认 / 配额放行 / 慢判定各进各的格", () => {
    const ctx = new Context();
    installStatsRemote(ctx);
    const service = statsServiceOf(ctx);
    const before = service.stats();
    noteRuleHit("rmrf", "deny");
    noteRuleHit("gitForcePush", "ask");
    noteQuotaRelease();
    noteJudgeCost({ face: "bash", ms: SLOW_JUDGE_MS + 150, length: 12 });
    const after = service.stats();
    // 全部按**增量**判：这些表是模块级状态，本文件之外也可能有人往里记（跑测顺序不该影响结论）。
    assert.equal(countOf(after.hits, "rmrf"), countOf(before.hits, "rmrf") + 1);
    assert.equal(countOf(after.asks, "gitForcePush"), countOf(before.asks, "gitForcePush") + 1);
    assert.equal(
      countOf(after.hits, "gitForcePush"),
      countOf(before.hits, "gitForcePush"),
      "ask 档不该记进拒那一栏",
    );
    assert.equal(after.quotaReleases, before.quotaReleases + 1);
    assert.equal(countOf(after.calls, "bash"), countOf(before.calls, "bash") + 1);
    assert.equal(countOf(after.slow, "bash"), countOf(before.slow, "bash") + 1);
    // 阈值与窗口随快照出去：卡片要能把"慢"这个字说成具体数字。
    assert.equal(after.slowMs, SLOW_JUDGE_MS);
    assert.ok(after.window > 0);
  });

  it("注册口缺席或畸形：四种形状都返回 false（可选读面只该少一栏展示，绝不让闸门下线）", () => {
    for (const bogus of [undefined, {}, { reflect: {} }, { reflect: { provide: 1 } }]) {
      assert.equal(
        installStatsRemote(bogus as never),
        false,
        `这个形状不该被当成注册口：${JSON.stringify(bogus)}`,
      );
    }
  });
});
