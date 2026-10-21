// lib/lesson-report.ts —— lesson-loop 总线的**上报面**：deny / pass 两条信号与代价采样。
//
// 为什么单列：这一族（类型守卫、两条 fire-and-forget 上报、采样出口）自成一个面——它只读
// 一个可选服务（`lessonLoop`）与三枚上下文值（会话、cwd、代价样本），判定链一个字都不依赖
// 它的返回值。抽出来之后，判定链的模块不必为"怎么上报"让出篇幅。
//
// 三条不变式（每一条都曾是实际故障）：
//  1. **可选读**：总线未装 / 未就绪 / 形状不符 ⇒ 静默跳过；拦截照常生效，
//     绝不能因为度量面缺席而让闸门下线。
//  2. **返回域按 `unknown` 收**：`(input) => void` 的函数类型恰好允许调用方丢弃返回的
//     Promise，TS 与 `no-floating-promises` 都看不见 —— 那正是"失败被静默吞掉并留下
//     一枚未处理拒绝"的根因。`unknown` 保留真实形状，逼调用点经 `settleLessonCall` 收口。
//  3. **`pass` 的方法接收方**：`?.` 不是第二道守卫（上面已判过），写成方法调用才保住
//     接收方（不借 `.call` / `.bind` 改 `this`）。

import { settleLessonCall } from "@jayyuen66/dsh-plugin-shared/lib/lesson-bus";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { isJudged, noteJudgeCost } from "./judge-stats.ts";
import type { JudgeCost } from "./judge-stats.ts";

export interface LessonLoopReporter {
  report: (input: {
    source: "danger-guard";
    category: string;
    cwd?: unknown;
    sessionId?: unknown;
    signature: string;
    detail: string;
    evidence?: Record<string, unknown>;
  }) => unknown;
  /** pass 信号：规则场景被触发且被遵守（fact-gate 通过）。
   *  成本三枚是可选载荷：`reportPass` 经条件展开带上它们，而展开**绕过多余属性检查**——
   *  不在这里声明，这条跨边界契约就失去编译期保护（总线侧按声明形状校验时会静默拒收）。 */
  pass?: (input: {
    category: string;
    cwd?: unknown;
    sessionId?: unknown;
    signature: string;
    face?: string;
    judgeMs?: number;
    judgeLength?: number;
  }) => unknown;
}

/** 总线最小面类型守卫：report/pass 都按函数判（象限守卫）。 */
export function isLessonLoopReporter(value: unknown): value is LessonLoopReporter {
  if (!isRecord(value)) {
    return false;
  }
  const { report, pass } = value;
  return typeof report === "function" && (pass === undefined || typeof pass === "function");
}

/** 一条上报要的三枚上下文字段（与判定链同源：可选读数口、会话 cwd、会话 id）。 */
export interface ReportContext {
  /** 可选服务读数口（`ctx.get` 的投影）。 */
  readonly get: ((name: string) => unknown) | undefined;
  /** 会话**当前**工作目录（与取证同一个基准）。 */
  readonly cwd: string | undefined;
  readonly sessionId: string | undefined;
}

/** 一次 deny 上报的内容：类别 + 签名 + 文案 + 取证。 */
export interface DenyReportInput {
  category: string;
  signature: string;
  detail: string;
  evidence: Record<string, unknown>;
}

/** 总线上报（fire-and-forget）：拦截是可学习信号——全量 detail，不截断。
 *  总线缺失直接跳过（见文件头第 1 条纪律）。 */
export function reportDeny(context: ReportContext, input: DenyReportInput): void {
  const busRaw: unknown = context.get?.("lessonLoop");
  const bus = isLessonLoopReporter(busRaw) ? busRaw : undefined;
  if (bus === undefined) {
    return;
  }
  settleLessonCall(
    () =>
      bus.report({
        source: "danger-guard",
        category: input.category,
        cwd: context.cwd,
        sessionId: context.sessionId,
        signature: input.signature,
        detail: input.detail,
        evidence: input.evidence,
      }),
    (reason) => {
      console.warn("[danger-guard] lessonLoop report failed:", reason);
    },
  );
}

/** pass 信号上报：fact-gate 取证通过（场景触发且被遵守）。
 *  总线缺失或未实现 pass 时静默跳过——这是度量增强，不是守卫热路径的硬依赖。 */
export function reportPass(
  context: ReportContext,
  category: string,
  signature: string,
  cost?: JudgeCost,
): void {
  const busRaw: unknown = context.get?.("lessonLoop");
  const bus = isLessonLoopReporter(busRaw) ? busRaw : undefined;
  if (bus?.pass === undefined) {
    return;
  }
  settleLessonCall(
    () =>
      // 写成方法调用而不是取值后调用：见文件头第 3 条纪律。
      bus.pass?.({
        category,
        cwd: context.cwd,
        sessionId: context.sessionId,
        signature,
        // 成本样本只带三枚数值（哪个面、多久、多长输入）——不带命令原文、不带路径。
        ...(cost === undefined
          ? {}
          : { face: cost.face, judgeMs: Math.round(cost.ms), judgeLength: cost.length }),
      }),
    (reason) => {
      console.warn("[danger-guard] lessonLoop pass failed:", reason);
    },
  );
}

/**
 * 一次判定的采样出口：本地滚动统计始终记，出域那一格（pass 载荷）由 `judgeStats` 决定。
 *
 * @param contextOf **惰性**取上下文：绝大多数工具调用根本没跑判定（`isJudged` 为假），
 *   而构造上下文要读两个宿主服务加会话 header —— 那是守卫热路径上白付的开销。
 *   只有真要出域时（`collect` 且确实判过）才求值。
 */
export function sampleJudge(
  contextOf: () => ReportContext,
  cost: JudgeCost,
  collect: boolean,
  category: string,
): void {
  if (isJudged(cost)) {
    noteJudgeCost(cost);
    if (collect) {
      reportPass(contextOf(), category, cost.face, cost);
    }
  }
}
