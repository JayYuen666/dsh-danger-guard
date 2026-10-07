// 派生台账的生命周期：会话销毁按会话键回收、插件卸载整表清空（**真实 cordis 运行时**）。
//
// 命题：模块级 Map 里两张是**会话键**（`会话id|目标`），一张是**路径键**
// （`起点目录|追加测试目录`），两张是全局路径键且自带自校。会话键那张不随会话销毁回收时，
// 长跑进程的记账按会话堆积（LEDGER_CAP=200 只是兜底，不是策略）；路径键那张不随卸载
// 清空时，新一代插件会读到上一代的层探查结论——可插件换代时工作树已经变了。
//
// 夹具用真实 Context（不是手写 mock）：卸载兜底挂在 ctx.effect 上，只有真的 dispose
// 一条 fiber 才会跑到 disposer，手写 mock 的 effects 数组验不了这条链。
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import plugin, { BUILTIN_BASE } from "../host.ts";
import type { Config } from "../host.ts";
import { SETTINGS_READER } from "../lib/settings-schema.ts";
import { call, result, unrelated } from "./fixtures/events.ts";
import type { SessionEvent } from "@jayyuen66/dsh-plugin-shared/lib/tool-events";

/** 事实门的拒绝理由统一带此前缀：用例据此判定「闸门确实在判」，而不是静默放行。 */
const FACT_GATE_MARK = /fact-gate/u;
/** 层探查缺口在文案里的措辞：层存在但没被探到时才会出现。 */
const TEST_LAYER_GAP = /test 层触达探查/u;
/** 会话销毁事件名：会话键台账的回收信号。 */
const SESSION_DISPOSED = "session/disposed";

/** 等一轮 fiber 生命周期：cordis 的 `_reload()` 首行就是 `await Promise.resolve()`，
 *  装载是微任务级的，不等一拍就取 guard 谓词只会拿到空壳。 */
const settle = (): Promise<void> => sleep(0);

describe("派生台账的生命周期", () => {
  /** 真实临时项目：projectRootOf 认 package.json，层探查要真的摸 fs——替身路径探不出
   *  「缓存里没有、磁盘上却有」这个正是本文件要钉的差别。 */
  let root: string;
  let target: string;
  /** 本次用例挂载的 guard 谓词：每个用例各自装载，predicate 随之换新。 */
  let predicate: ((exec: Record<string, unknown>) => string | undefined) | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dg-ledger-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), "{}\n");
    target = path.join(root, "src", "policy-mod.ts");
    await writeFile(target, "export const a = 1;\n");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** 组装一个「像 dsh 那样」的 root ctx：tools + settings，设置读数口给 strictMode。
   *  返回前已 settle，装配完成即谓词在册。
   *  strictMode 让 tierOf 升到 high → collectLayerVerdicts 才跑，层缺口才会出现在
   *  文案里——那正是本文件观察层缓存的窗口。 */
  async function mount(): Promise<Context> {
    const ctx = new Context();
    ctx.provide("tools", {
      guard(registered: (exec: Record<string, unknown>) => string | undefined) {
        predicate = registered;
        return (): void => {
          predicate = (): undefined => undefined;
        };
      },
    });
    ctx.provide("settings", {
      describe: () => [],
      configure: (): (() => void) => (): void => {
        void 0;
      },
    });
    const value: Config = { ...BUILTIN_BASE, strictMode: true };
    ctx.provide(SETTINGS_READER, { read: (): Config => value });
    ctx.plugin({ name: "danger-guard-ledger", inject: ["tools", "settings"], apply: plugin.apply });
    await settle();
    return ctx;
  }

  /** 一次 edit 调用：会话带 cwd 与空事件流（层存在性与层探查结论都由此产出）。 */
  function editOn(sessionId: string): string {
    assert.ok(predicate, "guard 谓词已挂载（mount 之后才该调用）");
    return (
      predicate({
        name: "edit",
        arguments: { file_path: target },
        agent: { session: { id: sessionId, header: { cwd: root }, snapshotEvents: () => [] } },
      }) ?? ""
    );
  }

  /** 带自定义事件流的 edit 调用（放行时返回 undefined——与 editOn 的 "" 区分开）。 */
  function editWithLog(sessionId: string, log: readonly SessionEvent[]): string | undefined {
    assert.ok(predicate, "guard 谓词已挂载（mount 之后才该调用）");
    return predicate({
      name: "edit",
      arguments: { file_path: target },
      agent: { session: { id: sessionId, header: { cwd: root }, snapshotEvents: () => log } },
    });
  }

  describe("会话销毁按会话键回收", () => {
    it("只清掉本会话的分片：s1 销毁不连坐 s10 的会话键基线", async () => {
      // 黑盒判别：s10 的 seenLen/mtime 基线是否被 s1 的销毁连坐清掉，唯一可观察面是
      // 「外部改动基准取哪一位」。首评日志 4 位（基线=4）；复评日志 6 位、新 read 的
      // 结果位在 5——基线在位时 5 > 4，read 仍算数 → 放行；基线被清（前缀少 `|` 的
      // 连坐）时基准退到当前日志末尾 6，5 > 6 不成立 → 判"被会话外改过" → 拒绝。
      const ctx = await mount();
      const readArgs = JSON.stringify({ file_path: target });
      const grepArgs = JSON.stringify({ pattern: "policy-mod", path: root });
      await utimes(target, 1_000_000_000, 1_000_000_000);
      const log1: SessionEvent[] = [
        call("r1", "read", readArgs),
        result("r1"),
        call("g1", "grep", grepArgs),
        result("g1"),
      ];
      assert.equal(editWithLog("s10", log1), undefined, "首评取证齐 → 放行（同时写下 s10 基线）");
      assert.match(editOn("s1"), FACT_GATE_MARK, "s1 首次编辑被拦（无取证）");

      await utimes(target, 2_000_000_000, 2_000_000_000);
      ctx.emit(SESSION_DISPOSED, { id: "s1" } as never);

      // s10 复评（必须在 s1 的冒烟之前：s1 的再评估会把全局 mtimes 基线刷到 T2，
      // 全局兜底会把"基线是否还在"的差异整个抹平——那是这个用例的判别窗口）。
      // 基线在位时外部改动基准=4，重读调用位 5 > 4 → 放行；
      // 基线被连坐清掉（前缀少 `|`）时基准退到当前日志末尾 7 → 5 > 7 不成立 → 拒绝。
      const log2: SessionEvent[] = [
        ...log1,
        unrelated(),
        call("r2", "read", readArgs),
        result("r2"),
      ];
      assert.equal(
        editWithLog("s10", log2),
        undefined,
        "s10 的会话键基线没被 s1 的销毁连坐清掉（外部改动基准仍是自己的台账位）",
      );
      // s1 自己的闸门照常。
      assert.match(editOn("s1"), FACT_GATE_MARK, "s1 销毁后闸门照常（分片已清，重新过门）");
      await ctx.fiber.dispose();
    });

    it("重复 dispose 同一会话是空操作", async () => {
      const ctx = await mount();
      assert.match(editOn("s-dup"), FACT_GATE_MARK, "首拒");
      ctx.emit(SESSION_DISPOSED, { id: "s-dup" } as never);
      ctx.emit(SESSION_DISPOSED, { id: "s-dup" } as never);
      // 分片已清：重新从首拒计数——第二次 dispose 既没有二次伤害（闸门照常），
      // 也没有把计数保留下来（那才是"清错了"的信号）。
      assert.doesNotMatch(editOn("s-dup"), /第 2 轮/u, "重复销毁后从首拒重新计数");
      assert.match(editOn("s-dup"), /第 2 轮/u, "计数随后正常连续（幂等的正向对照）");
      await ctx.fiber.dispose();
    });
  });

  describe("插件卸载整表清空", () => {
    it("层缓存不跨代存活：新一代重新探盘，看得到本代新增的层", async () => {
      const testDir = path.join(root, "test");
      // 第一代：磁盘上还没有 test 层 → 层探查结论（空）被缓存。
      const first = await mount();
      assert.doesNotMatch(editOn("s-unload"), TEST_LAYER_GAP, "磁盘上本就没有 test 层");

      await mkdir(testDir, { recursive: true });
      // 同一代内磁盘变了，层缓存仍持上一次探查的结论 → 新层漏掉（这正是缓存本来的取舍）。
      assert.doesNotMatch(editOn("s-unload"), TEST_LAYER_GAP, "同代内层缓存不重探（取舍，非缺陷）");
      await first.fiber.dispose();

      // 第二代：层缓存已随卸载清空，重新探盘 → 看到了第一代之后才建出来的 test 层。
      const second = await mount();
      assert.match(editOn("s-unload"), TEST_LAYER_GAP, "卸载后新一代重新探到了 test 层");
      await second.fiber.dispose();

      await rm(testDir, { recursive: true, force: true });
    });
  });
});
