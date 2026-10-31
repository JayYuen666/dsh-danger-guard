// test/lesson-report.test.ts —— 上报表面的异常隔离：总线或上下文抛错只跳过上报，不中断判定。
//
// 这三条路径跑在 tools.guard 的热路径上（deny 上报与成本采样），任何一条把异常带出去，
// 都会把一次拦截变成一次调用错误。假件按真实服务的形状写：方法依赖接收者、可选读面是数据属性。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { reportDeny, reportPass, sampleJudge } from "../lib/lesson-report.ts";
import type { ReportContext } from "../lib/lesson-report.ts";
import { statsSnapshot } from "../lib/judge-stats.ts";

const DENY = { category: "dangerous-bash", signature: "rm -rf /", detail: "denied", evidence: {} };

/** 一枚可选读面；`get` 抛错时模拟抛错 getter。 */
const contextWith = (get: (name: string) => unknown): ReportContext => ({
  get,
  cwd: process.cwd(),
  sessionId: "session-1",
});

describe("lesson-loop 上报面的异常隔离", () => {
  it("取总线时抛错 ⇒ 静默跳过，不把异常带进判定链", () => {
    const context = contextWith(() => {
      throw new Error("service getter failed");
    });
    assert.doesNotThrow(() => {
      reportDeny(context, DENY);
    });
    assert.doesNotThrow(() => {
      reportPass(context, "fact-gate", "sig");
    });
  });

  it("pass 读取抛错 ⇒ 跳过 pass 上报（deny 通道不受影响）", () => {
    const bus = Object.defineProperty({ report: () => 0 }, "pass", {
      get() {
        throw new Error("pass getter failed");
      },
    });
    assert.doesNotThrow(() => {
      reportPass(
        contextWith(() => bus),
        "fact-gate",
        "sig",
      );
    });
  });

  it("上下文求值抛错 ⇒ 只跳过出域上报，本地统计照记", () => {
    const face = "lesson-report-test-face";
    const before = statsSnapshot().calls[face] ?? 0;
    assert.doesNotThrow(() => {
      sampleJudge(
        () => {
          throw new Error("context evaluation failed");
        },
        { face, ms: 5, length: 10 },
        true,
        "judge-cost",
      );
    });
    assert.equal(statsSnapshot().calls[face] ?? 0, before + 1);
  });
});
