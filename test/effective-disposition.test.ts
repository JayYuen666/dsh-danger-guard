// test/effective-disposition.ts 的单元测试：扫描层与收口共用的**实际处置**。
//
// 为什么单列：这一族的主张全是可以在无宿主环境下断言的行为——
//   · 惰性单次读取（非覆盖键不碰宿主服务面；同一实例内只读一次）；
//   · 服务面抛错时的保守兜底（异常不冒出排序阶段，rmrf 保持 deny）；
//   · 沙箱覆盖把 rmrf 从 deny 折成 allow，且排序结论与收口结论同源（verdictOf）；
//   · cwd 的铸造边界校验绝对性（相对 cwd 不得按 process.cwd() 解析出假覆盖）。
// host 侧的接线（工厂每调用建一枚、guard 与审批通道吃同一枚）由 test/host.test.ts 钉。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  effectiveDispositionFactory,
  effectiveDispositionOf,
} from "../lib/effective-disposition.ts";
import type { EffectiveDispositionHost } from "../lib/effective-disposition.ts";
import type { BashVerdict } from "../lib/danger-rules.ts";
import type { PolicyFacts } from "../lib/mode-policy.ts";

/** 「工作区内修改」档、不缺任何配额事实的底座（模式名收常量：本文件出现多次）。 */
const WORKSPACE_MODE = "workspace-write" as const;
const FACTS: PolicyFacts = {
  mode: WORKSPACE_MODE,
  askable: true,
  autoReview: false,
  sandboxCovers: false,
};

/** 执行器自报在拦 + 策略解析出同一 mode、唯一可写根 `/ws` 的宿主服务面。 */
const confiningHost: EffectiveDispositionHost = {
  shellRaw: () => ({ sandboxMode: WORKSPACE_MODE }),
  policyRaw: () => ({ resolve: () => ({ mode: WORKSPACE_MODE, workspaceRoot: "/ws" }) }),
  canonicalize: (absolutePath) => absolutePath,
  tempDir: "/tmp",
};

const rmrfWith = (offending: string[]): BashVerdict => ({
  key: "rmrf",
  fix: { role: "disasterTarget", offending },
});

/** 模拟 darwin 上 `/tmp` → `/private/tmp`。 */
const privatePrefixed = (absolute: string): string =>
  absolute.startsWith("/private") ? absolute : `/private${absolute}`;

describe("effectiveDispositionOf：惰性与覆盖", () => {
  it("非沙箱覆盖键不碰宿主服务面：shellRaw / policyRaw 一次都不调", () => {
    let reads = 0;
    const count = (): undefined => {
      reads += 1;
      return undefined;
    };
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      shellRaw: count,
      policyRaw: count,
      canonicalize: (absolutePath) => absolutePath,
      tempDir: "/tmp",
    });
    assert.equal(effective.dispositionOf({ key: "gitForcePush" }), "ask", "按档位表求值");
    assert.equal(reads, 0, "没算沙箱覆盖就不读宿主面");
    assert.equal(effective.coveredFactsOf("gitForcePush", undefined), FACTS, "无覆盖时原样返回");
    assert.equal(reads, 0);
  });

  it("沙箱覆盖把 rmrf 从 deny 折成 allow；同一实例只读一次宿主面", () => {
    let reads = 0;
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      shellRaw: () => {
        reads += 1;
        return confiningHost.shellRaw();
      },
      policyRaw: confiningHost.policyRaw,
      canonicalize: confiningHost.canonicalize,
      tempDir: confiningHost.tempDir,
    });
    // `/etc/foo` 包不住任何可写根 → 沙箱整体拦下 → 让路。
    assert.equal(effective.dispositionOf(rmrfWith(["/etc/foo"])), "allow");
    assert.equal(reads, 1, "宿主面惰性读一次，排序多次求值不重复读盘");
    // 收口与排序同源：同一 (key, fix) 一次求出结论与覆盖后的事实。
    const outcome = effective.verdictOf("rmrf", {
      role: "disasterTarget",
      offending: ["/etc/foo"],
    });
    assert.equal(outcome.verdict, "allow");
    assert.equal(outcome.facts.sandboxCovers, true);
  });

  it("策略面同样只读一次（排序与收口共用同一份缓存）", () => {
    let reads = 0;
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      shellRaw: confiningHost.shellRaw,
      policyRaw: () => {
        reads += 1;
        return confiningHost.policyRaw();
      },
      canonicalize: confiningHost.canonicalize,
      tempDir: confiningHost.tempDir,
    });
    assert.equal(effective.dispositionOf(rmrfWith(["/etc/foo"])), "allow");
    assert.equal(
      effective.verdictOf("rmrf", { role: "disasterTarget", offending: ["/etc/foo"] }).verdict,
      "allow",
    );
    assert.equal(reads, 1, "策略解析也只读一次");
  });

  it("宿主实现抛错 ⇒ 排序与收口都按不让路兜底（异常不外冒）", () => {
    const throwOnPolicy = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      shellRaw: confiningHost.shellRaw,
      policyRaw: () => {
        throw new Error("policy getter failed");
      },
      canonicalize: confiningHost.canonicalize,
      tempDir: confiningHost.tempDir,
    });
    assert.equal(throwOnPolicy.dispositionOf(rmrfWith(["/etc/foo"])), "deny");
    const throwOnResolve = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      shellRaw: confiningHost.shellRaw,
      policyRaw: () => ({
        resolve: () => {
          throw new Error("resolve failed");
        },
      }),
      canonicalize: confiningHost.canonicalize,
      tempDir: confiningHost.tempDir,
    });
    assert.equal(throwOnResolve.dispositionOf(rmrfWith(["/etc/foo"])), "deny");
    const outcome = throwOnResolve.verdictOf("rmrf", {
      role: "disasterTarget",
      offending: ["/etc/foo"],
    });
    assert.equal(outcome.verdict, "deny");
    assert.equal(outcome.facts.sandboxCovers, false);
  });

  it("多目标的聚合是 every：任一目标包住可写根就整体不让路", () => {
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      ...confiningHost,
    });
    assert.equal(
      effective.dispositionOf(rmrfWith(["/etc/foo", "/var/x"])),
      "allow",
      "全部都不包住可写根 ⇒ 让路",
    );
    assert.equal(
      effective.dispositionOf(rmrfWith(["/ws", "/etc/foo"])),
      "deny",
      "任一目标包住可写根 ⇒ 整条不让路",
    );
    assert.equal(
      effective.dispositionOf(rmrfWith(["/etc/foo", "/ws"])),
      "deny",
      "顺序无关（every 的两个方向）",
    );
    assert.equal(effective.dispositionOf(rmrfWith([])), "deny", "空目标集合不让路");
    assert.equal(effective.coveredFactsOf("rmrf", undefined), FACTS, "没有 fix 时不构造空目标集");
  });

  it("目标包住可写根 ⇒ 不让路：`rm -rf ~` 一类仍然 deny", () => {
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      ...confiningHost,
    });
    assert.equal(effective.dispositionOf(rmrfWith(["/ws"])), "deny");
    assert.equal(effective.dispositionOf(rmrfWith(["/"])), "deny");
  });

  it("额外可写根不能被判成沙箱会完全阻止修改", () => {
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      shellRaw: () => ({ sandboxMode: WORKSPACE_MODE }),
      policyRaw: () => ({
        resolve: () => ({
          mode: WORKSPACE_MODE,
          workspaceRoot: "/ws",
          additionalWritableRoots: ["/extra/granted"],
        }),
      }),
      canonicalize: (absolutePath) => absolutePath,
      tempDir: "/tmp",
    });
    assert.equal(effective.dispositionOf(rmrfWith(["/extra/granted"])), "deny");
    assert.equal(effective.dispositionOf(rmrfWith(["/etc/foo"])), "allow");
  });

  it("非灾难目标的 fix（或没有 fix）不折规范形，原样交给沙箱判据", () => {
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      ...confiningHost,
    });
    // 只有 disasterTarget 的**绝对词面**需要折；别的 role 折它等于凭空造出一份删除目标，
    // 而覆盖判据会照着那份假清单放行。
    assert.equal(
      effective.coveredFactsOf("rmrf", { role: "bypassFlag", offending: ["--force"] }),
      FACTS,
      "bypassFlag 的词面不是删除目标 ⇒ 覆盖判据拿不到目标，保守不放行",
    );
    assert.equal(effective.coveredFactsOf("rmrf", undefined), FACTS, "没有 fix 同判");
  });
});

describe("effectiveDispositionOf：灾难目标先折规范形再比可写根（#394）", () => {
  it("符号链接前缀下 rm -rf /tmp/x 仍判不让路", () => {
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      shellRaw: () => ({ sandboxMode: WORKSPACE_MODE }),
      policyRaw: () => ({ resolve: () => ({ mode: WORKSPACE_MODE, workspaceRoot: "/tmp/x" }) }),
      canonicalize: privatePrefixed,
      tempDir: "/tmp",
    });
    // 词法形 /tmp/x 与规范根 /private/tmp/x 互不包含；目标侧不折规范形时会误判"盖得住"。
    assert.equal(effective.dispositionOf(rmrfWith(["/tmp/x"])), "deny", "目标就是工作区根");
    assert.equal(effective.dispositionOf(rmrfWith(["/tmp/x/src"])), "deny", "目标落在工作区内");
    assert.equal(effective.dispositionOf(rmrfWith(["/etc/foo"])), "allow");
  });
});

describe("effectiveDispositionOf：宿主服务面异常的保守兜底", () => {
  it("shellRaw / resolve 抛错 ⇒ 交回 undefined，rmrf 保持 deny，异常不冒出排序", () => {
    const effective = effectiveDispositionOf({
      facts: FACTS,
      session: undefined,
      cwd: undefined,
      shellRaw: () => {
        throw new Error("宿主服务换代");
      },
      policyRaw: confiningHost.policyRaw,
      canonicalize: confiningHost.canonicalize,
      tempDir: confiningHost.tempDir,
    });
    assert.equal(effective.dispositionOf(rmrfWith(["/etc/foo"])), "deny");
    const outcome = effective.verdictOf("rmrf", {
      role: "disasterTarget",
      offending: ["/etc/foo"],
    });
    assert.equal(outcome.verdict, "deny", "排序与收口都拿不到覆盖 ⇒ 同一个保守结论");
    assert.equal(outcome.facts.sandboxCovers, false);
  });
});

describe("effectiveDispositionFactory：cwd 的铸造边界", () => {
  it("相对 cwd 不打 brand：相对灾难目标不按 process.cwd() 解析，宁可不让路", () => {
    const effective = effectiveDispositionFactory(confiningHost)(undefined, "w/proj", FACTS);
    // cwd 若被原样品牌化，`.` 会按 process.cwd() 解析出一个与 /ws 无关的绝对形，
    // 一次真实的工作区删除会被误判成"沙箱已覆盖"而放行。
    assert.equal(effective.dispositionOf(rmrfWith(["."])), "deny");
  });

  it("绝对 cwd 照常参与归一：相对目标按它解析，不绝对化时才判覆盖", () => {
    const effective = effectiveDispositionFactory(confiningHost)(undefined, "/elsewhere", FACTS);
    // `/elsewhere` 之下没有任何可写根（根只有 /ws 与 /tmp 系）→ 让路。
    assert.equal(effective.dispositionOf(rmrfWith(["."])), "allow");
  });

  it("cwd 先折规范形：符号链接工作区里的 rm -rf . 不会落进另一个路径世界", () => {
    const host: EffectiveDispositionHost = {
      shellRaw: () => ({ sandboxMode: WORKSPACE_MODE }),
      policyRaw: () => ({ resolve: () => ({ mode: WORKSPACE_MODE, workspaceRoot: "/tmp/proj" }) }),
      canonicalize: privatePrefixed,
      tempDir: "/tmp",
    };
    const effective = effectiveDispositionFactory(host)(undefined, "/tmp/proj", FACTS);
    assert.equal(effective.dispositionOf(rmrfWith(["."])), "deny");
  });
});
