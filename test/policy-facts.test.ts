// test/policy-facts.test.ts —— 档位事实的折法：三个宿主事实各自的来源与**缺席口径**。
//
// 这一份单独钉 `lib/policy-facts.ts`：它把宿主的只读服务面折成 `PolicyFacts`。
// 判定表（`lib/mode-policy.ts`）由另一份逐格钉住，这里钉的是"喂进去的四位事实对不对"——
// 尤其是三处缺席口径，它们决定了某一档会被按哪一列处置：
//   · 读不到沙箱模式 ⇒ `unknown`（保守列）；
//   · 审批服务缺席 ⇒ **仍然能问**（宿主那条降级路径会保留我们的 reason）；
//   · 预设服务缺席 ⇒ 不是自动审查（也就不可能有 auto 这一档）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { policyFactsOf } from "../lib/policy-facts.ts";

const SESSION = { id: "s-1" };
/** 明说的「读不到模式」（VS `undefined` 字面量：那是 no-useless-undefined 盯的形状）。 */
const NO_MODE = undefined as string | undefined;
/** 本文件反复用到的档位名（`no-duplicate-string` 盯字面量重复）。 */
const WORKSPACE_MODE = "workspace-write";

/** `sandboxMode` 读法收到的三个入参（来源断言用；测试里不该猜生产传了什么）。 */
type ModeArgs = [shell: unknown, policy: unknown, session: unknown];

/** 一份把给定服务表塞进 `get()` 的入参（其余三位用固定值）。
 *  `onMode` 让用例看到沙箱模式读法实际收到的 shell / sandboxPolicy / session。 */
const factsFrom = (
  services: Record<string, unknown>,
  options: {
    session?: unknown;
    sandboxCovers?: boolean;
    mode?: string | undefined;
    onMode?: (...args: ModeArgs) => void;
  } = {},
): ReturnType<typeof policyFactsOf> =>
  policyFactsOf({
    get: (name) => services[name],
    session: "session" in options ? options.session : SESSION,
    sandboxCovers: options.sandboxCovers ?? false,
    sandboxMode: (shell, policy, session) => {
      options.onMode?.(shell, policy, session);
      return "mode" in options ? options.mode : WORKSPACE_MODE;
    },
  });

/** 一套"执行器报在拦 + 策略服务在位"的最小服务面。 */
const SANDBOX = { shell: { sandboxMode: WORKSPACE_MODE }, sandboxPolicy: {} };

describe("policyFactsOf：模式的三种取值与缺席口径", () => {
  it("三种模式各自原样折进来", () => {
    for (const mode of ["read-only", WORKSPACE_MODE, "danger-full-access"]) {
      assert.equal(factsFrom(SANDBOX, { mode }).mode, mode);
    }
  });

  it("读不到模式 / 未知名字 ⇒ unknown", () => {
    assert.equal(factsFrom(SANDBOX, { mode: NO_MODE }).mode, "unknown", "读不到模式");
    assert.equal(factsFrom(SANDBOX, { mode: "some-future-mode" }).mode, "unknown", "未知名字");
  });

  it("沙箱模式读法收到 shell / sandboxPolicy / session（服务名与 session 透传都有断言）", () => {
    const seen: ModeArgs[] = [];
    factsFrom(SANDBOX, {
      onMode: (...args) => {
        seen.push(args);
      },
    });
    assert.deepEqual(seen, [[SANDBOX.shell, SANDBOX.sandboxPolicy, SESSION]]);
  });

  it("`get` 整个缺席（宿主没提供可选读数口）⇒ 四位事实都走缺席口径，不抛错", () => {
    const facts = policyFactsOf({
      get: undefined,
      session: undefined,
      sandboxCovers: false,
      sandboxMode: () => NO_MODE,
    });
    assert.equal(facts.mode, "unknown");
    assert.equal(facts.askable, true, "服务缺席按宿主默认 ask 处理");
    assert.equal(facts.autoReview, false);
    assert.equal(facts.sandboxCovers, false);
  });
});

describe("policyFactsOf：能否询问的三条来源", () => {
  it("服务配置写 ask ⇒ 能问", () => {
    assert.equal(factsFrom({ ...SANDBOX, approval: { config: { policy: "ask" } } }).askable, true);
  });

  it("服务配置写 never ⇒ 问不了", () => {
    assert.equal(
      factsFrom({ ...SANDBOX, approval: { config: { policy: "never" } } }).askable,
      false,
    );
  });

  it("会话日志里最后一条 approval/policy 覆盖服务配置（用户中途换档也跟得上）", () => {
    const services = {
      ...SANDBOX,
      approval: { config: { policy: "ask" }, overrideOf: () => "never" },
    };
    assert.equal(factsFrom(services).askable, false, "覆盖为 never");
    const flipped = {
      ...SANDBOX,
      approval: { config: { policy: "never" }, overrideOf: () => "ask" },
    };
    assert.equal(factsFrom(flipped).askable, true, "覆盖为 ask");
  });

  it("overrideOf 必须成方法调用：真实 ApprovalService 的它就是读 this.approvalStateOf", () => {
    // 假件故意写成依赖 this 的方法：拆下来当裸函数调，this 就是 undefined，
    // 真实服务里那一句 `this.approvalStateOf(session)` 当场抛 —— 宿主上表现为
    // 每一次工具调用都死在 "Cannot read properties of undefined (reading 'approvalStateOf')"。
    const approval = {
      config: { policy: "ask" },
      lastOverride: "never",
      overrideOf(_session: unknown): unknown {
        return this.lastOverride;
      },
    };
    assert.equal(factsFrom({ ...SANDBOX, approval }).askable, false);
  });

  it("覆盖与配置都读不到 ⇒ 按能问处理（默认策略就是 ask）", () => {
    assert.equal(factsFrom({ ...SANDBOX, approval: {} }).askable, true);
    // config 在但 policy 缺席、以及 approval 形状不是对象：都按「配置缺席」处理。
    assert.equal(factsFrom({ ...SANDBOX, approval: { config: {} } }).askable, true);
    assert.equal(factsFrom({ ...SANDBOX, approval: null }).askable, true);
    assert.equal(factsFrom({ ...SANDBOX, approval: 7 }).askable, true);
    // 白名单之外的策略名按「问不了」处理（fail-closed，不是 `!== "never"` 的宽松判据）。
    assert.equal(
      factsFrom({ ...SANDBOX, approval: { config: { policy: "future-policy" } } }).askable,
      false,
    );
  });

  it("审批服务整个缺席 ⇒ **仍然能问**（降级路径会保留我们的 reason）", () => {
    assert.equal(factsFrom(SANDBOX).askable, true);
  });

  it("会话缺席时不读覆盖（没有会话就没有覆盖），按配置判", () => {
    const services = {
      ...SANDBOX,
      approval: { config: { policy: "never" }, overrideOf: () => "ask" },
    };
    assert.equal(factsFrom(services, { session: undefined }).askable, false);
  });

  it("策略值只认白名单：形状漂移一律按问不了处理", () => {
    for (const [label, override] of [
      ["object", { policy: "never" }],
      ["trailing space", "never "],
      ["number", 1],
      ["boolean", true],
    ] as const) {
      assert.equal(
        factsFrom({
          ...SANDBOX,
          approval: { config: { policy: "ask" }, overrideOf: () => override },
        }).askable,
        false,
        label,
      );
    }
    // 配置本身形状不符时也不能落到 fail-open。
    assert.equal(factsFrom({ ...SANDBOX, approval: { config: { policy: 1 } } }).askable, false);
  });

  it("session 为 null 时两处覆盖读法都不调用（不把 null 交给宿主方法）", () => {
    let called = 0;
    const services = {
      ...SANDBOX,
      approval: {
        config: { policy: "ask" },
        overrideOf: () => {
          called += 1;
          return "never";
        },
      },
      permissionPresets: {
        current: () => {
          called += 1;
          return "auto";
        },
      },
    };
    const facts = factsFrom(services, { session: null });
    assert.equal(called, 0);
    assert.equal(facts.askable, true);
    assert.equal(facts.autoReview, false);
  });
});

describe("policyFactsOf：是不是自动审查", () => {
  it("预设名是 auto ⇒ 是", () => {
    assert.equal(
      factsFrom({ ...SANDBOX, permissionPresets: { current: () => "auto" } }).autoReview,
      true,
    );
  });

  it("预设名是别的（如 danger-full-access）⇒ 不是", () => {
    assert.equal(
      factsFrom({ ...SANDBOX, permissionPresets: { current: () => "danger-full-access" } })
        .autoReview,
      false,
    );
  });

  it("预设服务缺席 / 形状不符 ⇒ 不是（读不到就没有 auto 这一档）", () => {
    assert.equal(factsFrom(SANDBOX).autoReview, false, "缺席");
    assert.equal(
      factsFrom({ ...SANDBOX, permissionPresets: {} }).autoReview,
      false,
      "没有 current",
    );
    assert.equal(factsFrom({ ...SANDBOX, permissionPresets: 1 }).autoReview, false, "不是对象");
  });

  it("会话缺席时不问预设（没有会话就没有逐会话预设）", () => {
    const services = { ...SANDBOX, permissionPresets: { current: () => "auto" } };
    assert.equal(factsFrom(services, { session: undefined }).autoReview, false);
  });
});

describe("policyFactsOf：沙箱覆盖事实原样透传", () => {
  it("传 true 就是 true、传 false 就是 false（本模块不解释它）", () => {
    assert.equal(factsFrom(SANDBOX, { sandboxCovers: true }).sandboxCovers, true);
    assert.equal(factsFrom(SANDBOX, { sandboxCovers: false }).sandboxCovers, false);
  });
});

describe("policyFactsOf：会话形状与覆盖读法的边界", () => {
  it("覆盖函数抛错时判定抛出（宿主服务的失败不吞：吞掉就等于换了一档）", () => {
    const services = {
      shell: { sandboxMode: WORKSPACE_MODE },
      sandboxPolicy: {},
      approval: {
        config: { policy: "never" },
        overrideOf: () => {
          throw new Error("session unreadable");
        },
      },
    };
    assert.throws(() => factsFrom(services));
  });

  it("覆盖返回 undefined ⇒ 回落服务配置（不是「读不到就算能问」）", () => {
    const services = {
      shell: { sandboxMode: WORKSPACE_MODE },
      sandboxPolicy: {},
      approval: {
        config: { policy: "never" },
        // 覆盖读不到（会话还没有 approval/policy 事件）⇒ 回落配置。
        overrideOf: (): unknown => NO_MODE,
      },
    };
    assert.equal(factsFrom(services).askable, false);
  });
});
