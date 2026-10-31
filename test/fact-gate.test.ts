// lib/fact-gate 单元测试：首次编辑事实强制门（gateguard 三段状态机 DENY→FORCE→ALLOW）。
// 移植自 ECC skills/gateguard（MIT，A/B 实测 +2.25 分）：LLM 自评无效，
// 但强制调查（列 import 者/受影响公共函数/引用用户指令）本身改变输出。
// 升级为强校验：拒绝持续到"对目标文件做过 read 且 grep 过它"为止。
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { FactGate, NO_DELIVERY, renderDenyMessage, undeterminable } from "../lib/fact-gate.ts";
import type {
  FactDecision,
  FactDenial,
  FactEvidenceInput,
  FactGap,
  FactGapContext,
  FactNeed,
  NeedWhy,
} from "../lib/fact-gate.ts";
// 行动指令与缺项规范顺序单源在 lib/gap-directives.ts（状态机只经它渲染拒绝消息与归一收敛键）。
import { NEED_ORDER, gapLine } from "../lib/gap-directives.ts";
// 检索取证口径单源在 lib/ref-search-policy.ts（host 的记账与指令文案吃同一份）。
import {
  DEFAULT_REF_SEARCH_STRICT_TOOLS,
  DEFAULT_REF_SEARCH_TOOLS,
  refSearchPolicyOf,
} from "../lib/ref-search-policy.ts";
import type { RefSearchPolicy } from "../lib/ref-search-policy.ts";
import { MESSAGES } from "../lib/messages.ts";
import type { DangerGuardMessages } from "../lib/messages.ts";

/** 中文文案表：状态机回传缺项结构，指令文案由这张表渲染（宿主在 guard 调用点做同样的事）。 */
const MESSAGES_ZH = MESSAGES.zh;
/** 英文文案表（双语断言用）。 */
const MESSAGES_EN = MESSAGES.en;

/** `NeedWhy` 的穷尽表：新增字面量而不补这一格时，`Record` 让这里当场编译错误。
 *  中文与英文两组全组合用例都从它派生，不会只剩一侧漏测。 */
const NEED_WHY_SET: Record<NeedWhy, true> = {
  never: true,
  external: true,
  failed: true,
  narrow: true,
};
const ALL_NEED_WHY = Object.keys(NEED_WHY_SET) as NeedWhy[];
/** 每个 need 应当产出的操作词——缺了说明文案退化成空串/纯标签。 */
const OPERABLE: Record<FactNeed, RegExp> = {
  read: /read/iu,
  refs: /grep|glob|zg_search|probe|search|探查|引用/iu,
  test: /probe|search|搜|探查|触达/iu,
  e2e: /probe|search|搜|探查|触达/iu,
  docs: /probe|search|搜|探查|触达/iu,
};

// FactDecision 是判别联合（kind: allow|quota|deny|indeterminate）：放行 = allow/quota 两态。
const pass = (decision: FactDecision | null): boolean =>
  decision !== null && (decision.kind === "allow" || decision.kind === "quota");
/** deny 态按指定文案表渲染（其余态给空串）；assert.equal 不带类型收窄，kind 判定留在这里。 */
const renderWith = (decision: FactDecision, catalog: DangerGuardMessages): string =>
  decision.kind === "deny" ? renderDenyMessage(decision.denial, catalog) : "";

/** deny 态按中文文案表渲染出消息，其余态给空串（断言只看文案内容）。
 *  渲染入口与 host 同一个（renderDenyMessage），所以这里测的就是真文案。 */
const denyMessage = (decision: FactDecision): string => renderWith(decision, MESSAGES_ZH);

/** 取证齐备（gaps 空）的证据输入。 */
const done = (over: Partial<FactEvidenceInput> = {}): FactEvidenceInput => ({
  gaps: [],
  determinate: true,
  logSeq: 1,
  externalChangeSeq: -1,
  ...over,
});
/** 缺指定取证项（默认 read+refs，成因 never）的证据输入。 */
const lack = (
  needs: FactNeed[] = ["read", "refs"],
  over: Partial<FactEvidenceInput> = {},
): FactEvidenceInput => ({
  gaps: needs.map((need) => ({ need, why: "never" as const })),
  determinate: true,
  logSeq: 1,
  externalChangeSeq: -1,
  ...over,
});

/** 一次"仅缺 read"的编辑判定并渲染拒绝文案（判别式用例的统一入口：
 *  轮次文案是这些用例的判别信号，收在这里也让调用链不超 max-nested-calls 闸）。 */
const denyOfLackRead = (gate: FactGate, file: string, sessionId?: unknown): string => {
  const decision = gate.check("edit", file, sessionId, lack(["read"]));
  assert.equal(decision.kind, "deny");
  return denyMessage(decision);
};

/** 只换检索判据的 refs 指令文案（refs 是唯一点名检索工具名的 need）。 */
const refsLine = (policy: RefSearchPolicy | undefined, why: NeedWhy = "never"): string => {
  const gapCtx: FactGapContext = {
    targetName: "policy-mod.ts",
    searchPath: "/w/proj",
    ...(policy === undefined ? {} : { searchPolicy: policy }),
  };
  return gapLine({ need: "refs", why }, gapCtx, MESSAGES_ZH);
};

/** 模板里的 {占位符} 名字清单（不捕获外层变量，故置于模块级）。 */
function placeholders(template: string): Set<string> {
  // 只认 `{name}` 字形：按花括号切分会把「整句恰好是一个单词」的普通文案也当成占位符。
  const found = new Set<string>();
  for (const piece of template.matchAll(/\{[^{}]+\}/gu)) {
    found.add(piece[0].slice(1, -1));
  }
  return found;
}

/** 带 `{占位符}` 的模板键从文案表现量派生：手写清单漏掉新增模板时这条安全网会静默失效。 */
function templateKeysOf(): (keyof DangerGuardMessages)[] {
  return (Object.keys(MESSAGES.zh) as (keyof DangerGuardMessages)[]).filter(
    (key) => placeholders(MESSAGES.zh[key]).size > 0 || placeholders(MESSAGES.en[key]).size > 0,
  );
}

/** 事实门夹具的目标文件（状态机那组用例七次问的都是它）。 */
const PROJECT_TARGET_FILE = "/w/proj/src/a.ts";
/** 「edit/write/str_replace_editor 共享同一文件记忆」那条用例的目标文件：
 *  三种编辑器写法必须逐字同一枚路径，否则"共享"测的就不是共享。 */
const SHARED_TARGET_FILE = "/w/src/a.ts";

describe("factGate：强校验状态机", () => {
  let gate: FactGate;
  beforeEach(() => {
    gate = new FactGate();
  });

  it("首次编辑某文件（未取证）→ DENY 并给出事实清单指令", () => {
    const result = gate.check("edit", PROJECT_TARGET_FILE);
    assert.equal(result.kind, "deny");
    const msg = denyMessage(result);
    assert.match(msg, /事实|fact/iu);
    assert.match(msg, /import|引用/u);
    assert.match(msg, /zg_search/u, "取证清单要求优先 zg_search，无索引退 grep");
  });

  it("先调查再动手（首次调用时证据已具备）→ 直接放行，不惩罚已取证行为", () => {
    // 模型先 read+grep 过该文件才发起编辑：门禁的目的已达到，无需再拦一次。
    const okA = pass(gate.check("edit", PROJECT_TARGET_FILE, undefined, done()));
    const okB = pass(gate.check("edit", "/w/proj/src/b.ts", undefined, done()));
    assert.equal(okA, true);
    assert.equal(okB, true);
  });

  it("重试时已取到证（read+grep 过目标）→ 放行", () => {
    // 首次：DENY + 记 pending
    gate.check("edit", PROJECT_TARGET_FILE);
    const okEdit = pass(gate.check("edit", PROJECT_TARGET_FILE, undefined, done()));
    assert.equal(okEdit, true, "有证据 → 放行");
  });

  it("拒绝计数按文件共享、不按工具名分片：edit 计过的 write 续算到第 2 轮", () => {
    // 黑盒判别：若记忆按工具名分片，write 这次会是"首次拒绝"（headFirst），
    // /第 2 轮/ 断言当场红——这是"共享"真正可观察的行为面。
    const first = gate.check("edit", PROJECT_TARGET_FILE, undefined, lack(["read"]));
    assert.equal(first.kind, "deny");
    const second = gate.check("write", PROJECT_TARGET_FILE, undefined, lack(["read"]));
    assert.equal(second.kind, "deny");
    assert.match(denyMessage(second), /第 2 轮/u, "换写类工具计数续算，不另起分片");
  });

  it("配额放行按文件共享：edit 熬满配额后 write 免证据放行", () => {
    // 默认 maxDenies=2：deny → deny → 第 3 次配额放行；随后换工具名不再重拦。
    // ⚠ 缺项必须**不含 read**：决策 ④ 之后，缺 read 时配额会被扣下（见下一条用例）。
    gate.check("edit", PROJECT_TARGET_FILE, undefined, lack(["refs", "test"]));
    gate.check("edit", PROJECT_TARGET_FILE, undefined, lack(["refs", "test"]));
    assert.equal(
      gate.check("edit", PROJECT_TARGET_FILE, undefined, lack(["refs", "test"])).kind,
      "quota",
    );
    assert.equal(
      gate.check("write", PROJECT_TARGET_FILE).kind,
      "allow",
      "配额按文件共享，不按工具名分片",
    );
  });

  it('重试时仍无证据 → 继续拒绝（不再"拦一次即放行"）', () => {
    // 首次 DENY
    gate.check("edit", PROJECT_TARGET_FILE);
    // 重试，明确可判定、仍无证据 → 继续拒绝
    const r2 = gate.check("edit", PROJECT_TARGET_FILE, undefined, lack(["read", "refs"]));
    assert.equal(r2.kind, "deny", "无证据必须继续拒绝");
    assert.match(denyMessage(r2), /fact-gate/iu);
  });

  it("缺少 input 的第二次调用 → indeterminate（不再把缺省两项当成持续可判定的拒绝）", () => {
    const first = gate.check("edit", "/w/no-input.ts");
    assert.equal(first.kind, "deny", "首拒仍给行动清单");
    const second = gate.check("edit", "/w/no-input.ts");
    assert.equal(second.kind, "indeterminate", "无证据可判定时走交互确认，而不是无限拒绝");
  });

  it("连续无证据拒绝达 maxDenies 次 → 配额放行（防死锁）+ 标记 quota", () => {
    const quotaGate = new FactGate({ maxDenies: 2 });
    // 缺项只落在**上层探查**（read 已确认）：这才是配额要免的那一半。
    const upper = lack(["refs", "test"]);
    // 首次 DENY（记 1 次）
    assert.equal(quotaGate.check("edit", "/w/a.ts", undefined, upper).kind, "deny");
    // 第 1 次重试无证据：DENY（记 2 次）
    assert.equal(quotaGate.check("edit", "/w/a.ts", undefined, upper).kind, "deny");
    // 第 2 次重试无证据：达上限 → 配额放行
    const result = quotaGate.check("edit", "/w/a.ts", undefined, upper);
    assert.equal(result.kind, "quota", "配额放行须标 kind=quota 供 host 警告");
    // 之后永久放行，配额不再拒
    const okLater = pass(quotaGate.check("edit", "/w/a.ts"));
    assert.equal(okLater, true);
  });

  it("决策 ④：配额**只免上层探查**，缺 read 时扣下配额照常拒（文案点明这件事）", () => {
    const quotaGate = new FactGate({ maxDenies: 1 });
    const lower = lack(["read", "test"]);
    assert.equal(quotaGate.check("edit", "/w/b.ts", undefined, lower).kind, "deny", "首次拒");
    // 越过上限了，但缺项里还有 read ⇒ 配额被扣下：仍然拒，且文案多一行说明。
    const withheld = quotaGate.check("edit", "/w/b.ts", undefined, lower);
    assert.equal(withheld.kind, "deny", "read 未补上，配额不得放行");
    const text = denyMessage(withheld);
    assert.match(text, /配额放行只免/u, "文案要说清配额免的是什么");
    assert.match(text, /read/iu, "文案要指向那一步");
    // 再试一次仍是拒（这条不放行的路不会因为重试次数变多而自行打开）
    assert.equal(quotaGate.check("edit", "/w/b.ts", undefined, lower).kind, "deny");
  });

  it("决策 ④：补上 read 之后配额立刻兑现（上层探查仍免）", () => {
    const quotaGate = new FactGate({ maxDenies: 1 });
    const lower = lack(["read", "test"]);
    quotaGate.check("edit", "/w/c.ts", undefined, lower);
    assert.equal(quotaGate.check("edit", "/w/c.ts", undefined, lower).kind, "deny");
    // 读过目标 ⇒ read 不再是缺项；上层那几项照旧没做 ⇒ 走配额（越过上限即兑现）。
    const afterRead = lack(["test"]);
    assert.equal(
      quotaGate.check("edit", "/w/c.ts", undefined, afterRead).kind,
      "deny",
      "缺项变小 → 计数重置，先按正常过门再拒一轮",
    );
    const released = quotaGate.check("edit", "/w/c.ts", undefined, afterRead);
    assert.equal(released.kind, "quota", "越过上限且 read 已确认 ⇒ 配额兑现");
    assert.equal(pass(quotaGate.check("edit", "/w/c.ts")), true, "之后按文件共享放行");
  });

  it("证据判定不可行（determinate=false）→ 返回 indeterminate 走交互式确认", () => {
    // 首次 DENY
    gate.check("edit", "/w/a.ts");
    // 重试，历史不可得
    const result = gate.check(
      "edit",
      "/w/a.ts",
      undefined,
      lack(["read", "refs"], { determinate: false }),
    );
    assert.equal(result.kind, "indeterminate", "indeterminate 路径供 host 交互式确认");
  });

  it("indeterminate 不消耗放行次数（随后补证仍按正常路径）", () => {
    gate.check("edit", "/w/a.ts");
    // indeterminate
    const result = gate.check(
      "edit",
      "/w/a.ts",
      undefined,
      lack(["read", "refs"], { determinate: false }),
    );
    assert.equal(result.kind, "indeterminate");
    // 用户确认后模型补 read/grep → 走正常放行
    const okLater = pass(gate.check("edit", "/w/a.ts", undefined, done()));
    assert.equal(okLater, true);
  });

  it("不同文件各自首次编辑都拦", () => {
    assert.equal(gate.check("edit", "/w/a.ts").kind, "deny");
    assert.equal(gate.check("edit", "/w/b.ts").kind, "deny");
    const okB = pass(gate.check("edit", "/w/b.ts", undefined, done()));
    assert.equal(okB, true);
  });

  it("非编辑类工具直接放行", () => {
    assert.equal(pass(gate.check("bash", undefined)), true);
    assert.equal(pass(gate.check("read", undefined)), true);
    assert.equal(pass(gate.check("grep", undefined)), true);
  });

  it("无 file_path 的编辑调用放行（不猜）", () => {
    assert.equal(pass(gate.check("edit", undefined)), true);
    assert.equal(pass(gate.check("edit", "")), true);
  });
});

describe("factGate：SKIP 面收紧", () => {
  it("test/ 目录内的编辑现在也过门（堵旁路：不再能挂 test/ 下躲取证）", () => {
    const gate = new FactGate();
    assert.equal(gate.check("edit", "/w/proj/test/foo.test.ts").kind, "deny", "test/ 首次编辑应拦");
    assert.equal(gate.check("edit", "/w/proj/tests/foo_test.py").kind, "deny");
    const okGate = pass(gate.check("edit", "/w/proj/test/foo.test.ts", undefined, done()));
    assert.equal(okGate, true, "取证后放行");
  });

  it("markdown/rst/adoc 文档仍放行；.txt 不再按文档豁免", () => {
    const gate = new FactGate();
    assert.equal(pass(gate.check("edit", "/w/proj/README.md")), true);
    assert.equal(pass(gate.check("edit", "/w/proj/docs/guide.rst")), true);
    assert.equal(pass(gate.check("edit", "/w/proj/docs/guide.adoc")), true);
    assert.equal(
      gate.check("edit", "/w/proj/notes.txt").kind,
      "deny",
      ".txt 是通用文本容器，不是无执行影响的文档面",
    );
    assert.equal(gate.check("edit", "/w/proj/CMakeLists.txt").kind, "deny", "构建逻辑必须过门");
    assert.equal(gate.check("edit", "/w/proj/requirements.txt").kind, "deny", "依赖清单必须过门");
  });

  it("配置文件仍拦（改配置影响面大，恰恰最需要事实）", () => {
    const gate = new FactGate();
    assert.equal(gate.check("edit", "/w/proj/package.json").kind, "deny");
    assert.equal(gate.check("edit", "/w/proj/Cargo.toml").kind, "deny");
    assert.equal(gate.check("edit", "/w/proj/cordis.patch.yml").kind, "deny");
  });

  it("test/ 目录下的配置文件现在也拦（B10 收紧）", () => {
    const gate = new FactGate();
    assert.equal(
      gate.check("edit", "/w/proj/test/package.json").kind,
      "deny",
      "test/ 下配置不再因路径跳过",
    );
  });
});

describe("factGate：容量与并发安全", () => {
  it("记忆的文件数有上限（防超长会话内存膨胀），真 LRU：命中即续命，最久未用先淘汰", () => {
    // 黑盒判别（LRU vs FIFO 的分叉点）：f0 命中一次后，新文件挤入淘汰的必须是
    // f1/f2（最久未用）而不是 f0。若实现退回"按插入序淘汰"，f0 的 /第 3 轮/ 断言会红。
    // maxDenies 抬到 5：让 f0 的三次拒绝都落在拒绝路径内，不提前触发配额放行。
    const gate = new FactGate({ maxFiles: 3, maxDenies: 5 });
    for (let i = 0; i < 3; i += 1) {
      gate.check("edit", `/w/f${i}.ts`, undefined, lack(["read"]));
    }
    // 命中 f0 → 续命（位次刷到最新）
    gate.check("edit", "/w/f0.ts", undefined, lack(["read"]));
    // 挤入两个新文件：容量 3，被挤掉的应是 f1、f2
    gate.check("edit", "/w/f3.ts", undefined, lack(["read"]));
    gate.check("edit", "/w/f4.ts", undefined, lack(["read"]));
    // f0 的计数还在（此前 deny 过 2 次）→ 第 3 轮
    assert.match(denyOfLackRead(gate, "/w/f0.ts"), /第 3 轮/u, "命中续命的文件没被挤掉");
    // f1 已被挤掉 → 从首拒重新计数
    assert.doesNotMatch(denyOfLackRead(gate, "/w/f1.ts"), /第 2 轮/u, "最久未用的文件已被淘汰");
    // 淘汰即重新过门：f1 重新计入第 1 轮后，第 2 次无证据就是第 2 轮
    assert.match(denyOfLackRead(gate, "/w/f1.ts"), /第 2 轮/u);
  });

  it("pending 的命中也会续命（indeterminate 路径不是淘汰盲区）", () => {
    const gate = new FactGate({ maxFiles: 2, maxDenies: 5 });
    const needRead = lack(["read"]);
    assert.equal(gate.check("edit", "/w/p0.ts", undefined, needRead).kind, "deny");
    assert.equal(gate.check("edit", "/w/p1.ts", undefined, needRead).kind, "deny");
    // p0 命中 → 续命（不可判定路径）
    assert.equal(
      gate.check("edit", "/w/p0.ts", undefined, lack(["read"], { determinate: false })).kind,
      "indeterminate",
    );
    // 挤入 p2：容量 2，被挤掉的应是 p1
    assert.equal(gate.check("edit", "/w/p2.ts", undefined, needRead).kind, "deny");
    // p0 仍记住（第 2 次不可判定），p1 已被淘汰（首拒）
    assert.equal(
      gate.check("edit", "/w/p0.ts", undefined, lack(["read"], { determinate: false })).kind,
      "indeterminate",
    );
    assert.doesNotMatch(denyOfLackRead(gate, "/w/p1.ts"), /第 2 轮/u, "最久未用的 p1 被淘汰");
  });

  it("released 的命中也会续命（配额复用不是淘汰盲区）", () => {
    const gate = new FactGate({ maxFiles: 2, maxDenies: 1 });
    const upper = lack(["refs"]);
    const release = (file: string, logSeq: number): void => {
      assert.equal(gate.check("edit", file, undefined, upper).kind, "deny");
      assert.equal(gate.check("edit", file, undefined, lack(["refs"], { logSeq })).kind, "quota");
    };
    release("/w/r0.ts", 1);
    release("/w/r1.ts", 2);
    // r0 命中 → 续命
    assert.equal(
      gate.check("edit", "/w/r0.ts", undefined, lack(["refs"], { logSeq: 3 })).kind,
      "allow",
    );
    release("/w/r2.ts", 4);
    // r1 是最久未用 → 被挤掉，重新首拒；r0 仍在
    assert.equal(gate.check("edit", "/w/r1.ts", undefined, upper).kind, "deny");
    assert.equal(
      gate.check("edit", "/w/r0.ts", undefined, lack(["refs"], { logSeq: 5 })).kind,
      "allow",
    );
  });

  it("check 不抛错（防御式）", () => {
    const gate = new FactGate();
    assert.equal(pass(gate.check("", "/ok.ts")), true);
    assert.doesNotThrow(() => {
      gate.check("edit", null);
    });
  });
});

describe("factGate：数值参数契约", () => {
  it("构造参数必须是正安全整数：0/负数/小数/NaN/Infinity 一律拒绝", () => {
    assert.throws(() => new FactGate({ maxSessions: 0 }), RangeError);
    assert.throws(() => new FactGate({ maxSessions: -1 }), RangeError);
    assert.throws(() => new FactGate({ maxSessions: 1.5 }), RangeError);
    assert.throws(() => new FactGate({ maxSessions: Number.NaN }), RangeError);
    assert.throws(() => new FactGate({ maxFiles: 0 }), RangeError);
    assert.throws(() => new FactGate({ maxFiles: Number.POSITIVE_INFINITY }), RangeError);
    assert.throws(() => new FactGate({ maxDenies: 0 }), RangeError);
    assert.throws(() => new FactGate({ maxDenies: -1 }), RangeError);
    assert.throws(() => new FactGate({ maxDenies: 2.5 }), RangeError);
    assert.doesNotThrow(() => new FactGate({ maxSessions: 1, maxFiles: 1, maxDenies: 1 }));
  });

  it("运行时 maxDenies 非法值回落构造值，而不是让配额永不兑现", () => {
    const gate = new FactGate({ maxDenies: 2 });
    const upper = lack(["refs"]);
    const limitFile = "/w/limit.ts";
    assert.equal(gate.check("edit", limitFile, undefined, upper, 0).kind, "deny", "首拒");
    assert.equal(
      gate.check("edit", limitFile, undefined, upper, 0).kind,
      "deny",
      "0 回落为 2：第 2 次仍是拒绝",
    );
    assert.equal(
      gate.check("edit", limitFile, undefined, upper, Number.NaN).kind,
      "quota",
      "第 3 次越过回落后的上限 → 配额",
    );
  });
});

describe("factGate：重置", () => {
  it("reset 后全部文件重新过门（新一轮任务重新取证）", () => {
    const gate = new FactGate();
    gate.check("edit", "/w/a.ts");
    gate.reset();
    assert.equal(gate.check("edit", "/w/a.ts").kind, "deny");
  });
});

describe("b9：会话隔离（状态按 session 分片）", () => {
  it("同一文件两个会话各拦一次", () => {
    const gate = new FactGate();
    assert.equal(gate.check("edit", "/w/a.ts", "sess-1").kind, "deny");
    assert.equal(gate.check("edit", "/w/a.ts", "sess-2").kind, "deny", "sess-2 重新过门");
    const ok1 = pass(gate.check("edit", "/w/a.ts", "sess-1", done()));
    const ok2 = pass(gate.check("edit", "/w/a.ts", "sess-2", done()));
    assert.equal(ok1, true);
    assert.equal(ok2, true);
  });

  it("同一会话：取证后 write/edit/str_replace_editor 共享放行记忆", () => {
    const gate = new FactGate();
    gate.check("edit", "/w/a.ts", "sess-1");
    const okEdit = pass(gate.check("edit", "/w/a.ts", "sess-1", done()));
    const okWrite = pass(gate.check("write", "/w/a.ts", "sess-1", done()));
    assert.equal(okEdit, true);
    assert.equal(okWrite, true);
  });

  it("无 sessionId 的调用共享默认分片（向后兼容）", () => {
    // 黑盒判别：默认分片若不存在（每次调用各记各的），第二次会退回首拒而不是第 2 轮。
    const gate = new FactGate();
    assert.equal(gate.check("edit", "/w/a.ts", undefined, lack(["read"])).kind, "deny");
    assert.match(
      denyOfLackRead(gate, "/w/a.ts"),
      /第 2 轮/u,
      "无 id 的调用落在同一默认分片，计数连续",
    );
  });
});

describe("str_replace_editor 并存编辑器过事实门", () => {
  it("str_replace_editor 首次写某文件被拦，取证后放行，且与 edit/write 共享记忆", () => {
    const gate = new FactGate();
    assert.equal(gate.check("str_replace_editor", SHARED_TARGET_FILE).kind, "deny", "首次写拦");
    const okOnce = pass(gate.check("str_replace_editor", SHARED_TARGET_FILE, undefined, done()));
    assert.equal(okOnce, true, "取证后放行");
    // "共享记忆"的黑盒判别：str_replace_editor 计过的 edit 续算轮次——
    // 若记忆按工具名分片，edit 这次会是首次拒绝，/第 2 轮/ 断言当场红。
    assert.equal(gate.check("edit", SHARED_TARGET_FILE, undefined, lack(["read"])).kind, "deny");
    assert.match(
      denyOfLackRead(gate, SHARED_TARGET_FILE),
      /第 2 轮/u,
      "edit/write/str_replace_editor 共享同一文件记忆",
    );
  });

  it("view（只读）不进事实门：host 侧不传路径", () => {
    const gate = new FactGate();
    assert.equal(pass(gate.check("str_replace_editor", undefined)), true, "view 未传路径 → 放行");
    // 且不消耗记忆：随后真正的写操作仍会被拦
    assert.equal(gate.check("str_replace_editor", "/w/a.ts").kind, "deny");
  });
});

describe("不可判定输入与投递水位", () => {
  it("投递缺省常量在运行时也不可变", () => {
    assert.equal(Object.isFrozen(NO_DELIVERY), true);
    assert.equal(Object.isFrozen(NO_DELIVERY.layerSeqs), true);
  });

  it("历史不可得时只按 read/refs 起步；投递水位翻成 done，layerSeqs 不进入该退化面", () => {
    const missing = undeterminable(NO_DELIVERY);
    assert.deepEqual(
      missing.gaps.map((gap) => gap.need),
      ["read", "refs"],
    );
    assert.equal(missing.determinate, false);

    const delivered = undeterminable({
      readSeq: 1,
      refsSeq: 1,
      layerSeqs: { test: 1 },
    });
    assert.deepEqual(delivered.gaps, []);
    assert.deepEqual(delivered.done, ["read", "refs"], "layerSeqs 不参与该退化面");

    const gate = new FactGate();
    assert.equal(gate.check("edit", "/w/u.ts", "su", missing).kind, "deny");
    assert.equal(gate.check("edit", "/w/u.ts", "su", missing).kind, "indeterminate");
    assert.equal(gate.check("edit", "/w/u2.ts", "su", delivered).kind, "allow");
  });
});

describe("第 4 项自检：FactNeed 全覆盖 + gapLine 分支可产出（防不可达分支）", () => {
  it("nEED_ORDER 覆盖 FactNeed 全部字面量——收敛键不静默丢项", () => {
    // 若有人在 FactNeed 加新 need（如 ci/scan/lint）却忘了加进 NEED_ORDER，
    // needsKey 会把它从收敛比对里漏掉：补上会反复"多一项"，永远不收敛 → 配额放行。
    // 本测试在编译期（satisfies）与运行期（size + 存在性）双保险。
    const literal: readonly string[] = ["read", "refs", "test", "e2e", "docs"];
    assert.equal(
      new Set<string>(NEED_ORDER as readonly string[]).size,
      NEED_ORDER.length,
      "NEED_ORDER 内不重复",
    );
    for (const need of literal) {
      assert.ok(NEED_ORDER.includes(need as FactNeed), `NEED_ORDER 缺 ${need}`);
    }
    for (const need of NEED_ORDER) {
      assert.ok(literal.includes(need), `NEED_ORDER 多出未知 need ${need}`);
    }
  });

  it("每个 need × 每个 why 都有非空、具操作性、提及目标名的文案", () => {
    // oxlint/tsc 抓"未使用声明"，抓不到"分支可达但产出 falsy/garbage"：
    // gapLine 每个 need 都有一个 default 兜底 —— 若某个 why 没被显示处理，
    // 会静默落入 default，测不出来。故枚举全组合逐一断言。
    for (const need of NEED_ORDER) {
      for (const why of ALL_NEED_WHY) {
        const gap: FactGap = { need, why };
        const line = gapLine(gap, { targetName: "a.ts", searchPath: "/w/proj" }, MESSAGES_ZH);
        assert.ok(typeof line === "string" && line.length > 4, `gapLine(${need},${why}) 为空/过短`);
        assert.match(line, OPERABLE[need], `gapLine(${need},${why}) 缺操作词`);
        assert.match(line, /a\.ts/u, `gapLine(${need},${why}) 未落到目标名`);
      }
    }
  });

  it("hint 会被拼进文案（host 注入具体路径/文件名时提示可达）", () => {
    const line = gapLine(
      { need: "refs", why: "narrow", hint: "你上次 grep 的 path 是 lib/" },
      { targetName: "x.ts", searchPath: "/w" },
      MESSAGES_ZH,
    );
    assert.match(line, /lib\//u, "hint 应拼进指令");
    assert.match(line, /grep|glob|zg_search/u, "narrow 的 refs 应指出作用域问题");
  });
});

describe("引用探查指令从生效策略派生（指令与实际认的工具一致）", () => {
  it("未带策略（host 兜底/单测裸调用）→ 回落内置默认名单，两份口径都写进指令", () => {
    const line = refsLine(undefined);
    assert.match(line, /grep/u);
    assert.match(line, /glob/u);
    assert.match(line, /zg_search/u);
    assert.match(line, /path 指向/u, "pattern 口径的起点参数");
    assert.match(line, /root 指向/u, "严格口径的起点参数");
    assert.match(line, /policy-mod\.ts/u, "指令仍落到目标文件名");
  });

  it("第三方工具入列、内置名移除后：指令只点名生效名单", () => {
    const policy = refSearchPolicyOf(["grep", "rg_search"], []);
    const line = refsLine(policy);
    assert.match(line, /rg_search/u);
    assert.doesNotMatch(line, /glob|zg_search/u, "被移除的名字不得再要求模型去做");
    assert.match(line, /pattern/u);
  });

  it("口径随工具名切换：严格名单里的工具按 root/query 指令，不再要它传 pattern", () => {
    const policy = refSearchPolicyOf(["rg_search"], ["rg_search"]);
    const line = refsLine(policy);
    assert.match(line, /rg_search`? 的 root 指向/u, "严格口径 → 起点写 root");
    assert.match(line, /query/u);
    assert.doesNotMatch(line, /pattern|include/u, "严格口径不读 pattern/include");
    assert.match(line, /相对路径/u, "严格口径的相对路径要求必须写给模型");
  });

  it("空名单：指令说明「未配置或配置的工具不可用」两种可能，而不是断言 refSearchTools 为空", () => {
    const line = refsLine(refSearchPolicyOf([], []));
    assert.match(line, /refSearchTools/u);
    assert.match(line, /不可用/u);
    assert.match(line, /policy-mod\.ts/u);
    assert.doesNotMatch(line, /grep|glob|zg_search/u);
  });

  it("narrow 成因同样点名计入的工具名（不再靠 hint 顺带出现）", () => {
    const line = refsLine(refSearchPolicyOf(["rg_search"], []), "narrow");
    assert.match(line, /rg_search/u);
    assert.match(line, /作用域不对/u);
    assert.doesNotMatch(line, /grep|glob|zg_search/u);
  });

  it("narrow + 空名单：指令说明「当前没有可用的检索工具」，而不是渲染成空项或断言配置为空", () => {
    const line = refsLine(refSearchPolicyOf([], []), "narrow");
    assert.match(line, /当前可用的检索工具/u, "空名单不是「没说」，而是点名当前可用集合");
    assert.doesNotMatch(line, /grep|glob|zg_search/u);
  });

  it("默认名单常量本身就是修复前的判定口径（单源，防三处漂移）", () => {
    assert.deepEqual([...DEFAULT_REF_SEARCH_TOOLS], ["grep", "glob", "zg_search"]);
    assert.deepEqual([...DEFAULT_REF_SEARCH_STRICT_TOOLS], ["zg_search"]);
  });
});

describe("factGate：配额放行的失效条件（不变式，见 SessionState.released 注释）", () => {
  it("外部改动水位等于放行水位时同样失效（严格小于才保留配额）", () => {
    const gate = new FactGate({ maxDenies: 1 });
    // 缺项只落在上层探查：决策 ④ 之后缺 read 时配额会被扣下，那条路走不到"放行水位"。
    const upper = lack(["refs"]);
    assert.equal(gate.check("edit", "/w/q.ts", "sq", upper).kind, "deny", "首拒");
    // maxDenies=1：第 2 次无证据拒绝达配额 → 放行
    assert.equal(gate.check("edit", "/w/q.ts", "sq", lack(["refs"], { logSeq: 5 })).kind, "quota");
    // 只读查询与 check 用同一条严格判据：等于放行水位不算"之后"，必须失效。
    assert.equal(
      gate.releasedFor("sq", "/w/q.ts", lack(["refs"], { externalChangeSeq: 4 })),
      true,
      "更早的外部改动不撤销配额",
    );
    assert.equal(
      gate.releasedFor("sq", "/w/q.ts", lack(["read"], { externalChangeSeq: 4 })),
      false,
      "当前仍有 read 缺项时，预检也不得让路",
    );
    assert.equal(
      gate.releasedFor("sq", "/w/q.ts", lack(["refs"], { externalChangeSeq: 5 })),
      false,
      "等于放行水位即失效",
    );
    assert.equal(
      gate.releasedFor("sq", "/w/q.ts", lack(["refs"], { externalChangeSeq: 6 })),
      false,
      "晚于放行水位即失效",
    );
    assert.equal(
      gate.releasedFor("sq", "/w/q.ts", undeterminable(NO_DELIVERY)),
      true,
      "不可判定态沿用旧配额：历史读不到不证明模型没读过这一版",
    );
    // 目标未变（externalChangeSeq 仍早于放行水位）→ 持续放行
    assert.equal(gate.check("edit", "/w/q.ts", "sq", lack(["refs"], { logSeq: 6 })).kind, "allow");
    // 外部改动水位恰好等于放行水位 → 放行作废，回到正常过门（重新计数）
    const equal = gate.check(
      "edit",
      "/w/q.ts",
      "sq",
      lack(["refs"], { logSeq: 7, externalChangeSeq: 5 }),
    );
    assert.equal(equal.kind, "deny", "第一个外部改动不能被相等水位漏掉");
  });

  it("更晚的外部改动水位使配额过期并重新计数", () => {
    const gate = new FactGate({ maxDenies: 1 });
    const upper = lack(["refs"]);
    assert.equal(gate.check("edit", "/w/q2.ts", "sq", upper).kind, "deny");
    assert.equal(gate.check("edit", "/w/q2.ts", "sq", lack(["refs"], { logSeq: 5 })).kind, "quota");
    const after = gate.check(
      "edit",
      "/w/q2.ts",
      "sq",
      lack(["refs"], { logSeq: 6, externalChangeSeq: 99 }),
    );
    assert.equal(after.kind, "deny", "更晚的外部改动使配额过期");
    assert.match(denyMessage(after), /fact-gate/iu);
  });

  it("配额命中也不能豁免当前 read 缺项", () => {
    const gate = new FactGate({ maxDenies: 1 });
    const upper = lack(["refs"]);
    assert.equal(gate.check("edit", "/w/q3.ts", "sq", upper).kind, "deny");
    assert.equal(gate.check("edit", "/w/q3.ts", "sq", lack(["refs"], { logSeq: 5 })).kind, "quota");
    const readGap = gate.check(
      "edit",
      "/w/q3.ts",
      "sq",
      lack(["read"], { logSeq: 6, externalChangeSeq: -1 }),
    );
    assert.equal(readGap.kind, "deny", "配额只免上层探查，当前 read 缺项仍要过门");
  });

  it("新建文件的拒绝走「免 read」头部文案（引用面仍要探）", () => {
    const gate = new FactGate();
    const result = gate.check("write", "/w/n.ts", "sn", lack(["refs"], { newFile: true }));
    assert.equal(result.kind, "deny");
    assert.match(denyMessage(result), /新建文件免 read/u);
  });

  it("第 2 轮拒绝的头部说明还剩几项（收敛进度可见）", () => {
    const gate = new FactGate();
    gate.check("edit", "/w/p.ts", "sp", lack(["read", "refs"]));
    const second = gate.check("edit", "/w/p.ts", "sp", lack(["read", "refs"]));
    assert.equal(second.kind, "deny");
    assert.match(denyMessage(second), /第 2 轮仍未放行/u);
  });
});

describe("factGate：会话键与会话分片容量", () => {
  it("非字符串 session id（number/bigint/boolean）都能成分片键", () => {
    // host 传的是 `exec.agent.session.id`（真实契约是 SessionId 字符串），但 PTC/旧宿主
    // 可能给出数字键——keyOf 必须对任意原始类型稳定，否则不同会话串进同一分片。
    // 黑盒判别：同键两次 → 第 2 轮（记忆连续）；异键 → 首拒（没串片）。
    const gate = new FactGate();
    assert.equal(gate.check("edit", "/w/k.ts", 7, lack(["read"])).kind, "deny");
    assert.match(denyOfLackRead(gate, "/w/k.ts", 7), /第 2 轮/u, "数字键会话记忆连续");
    assert.doesNotMatch(denyOfLackRead(gate, "/w/k.ts", 10n), /第 2 轮/u, "bigint 会话另起分片");
    assert.doesNotMatch(denyOfLackRead(gate, "/w/k.ts", true), /第 2 轮/u, "boolean 会话另起分片");
  });

  it('数字 1、字符串 "1"、1n、true 各自分片（类型前缀阻止 String() 碰撞）', () => {
    const typedFile = "/w/typed.ts";
    const numString = new FactGate();
    assert.equal(numString.check("edit", typedFile, 1, lack(["read"])).kind, "deny");
    assert.doesNotMatch(
      denyOfLackRead(numString, typedFile, "1"),
      /第 2 轮/u,
      '字符串 "1" 不能续上数字 1 的计数',
    );

    const bigintNumber = new FactGate();
    assert.equal(bigintNumber.check("edit", typedFile, 1, lack(["read"])).kind, "deny");
    assert.doesNotMatch(
      denyOfLackRead(bigintNumber, typedFile, 1n),
      /第 2 轮/u,
      "bigint 1n 不能续上数字 1 的计数",
    );

    const boolString = new FactGate();
    assert.equal(boolString.check("edit", typedFile, true, lack(["read"])).kind, "deny");
    assert.doesNotMatch(
      denyOfLackRead(boolString, typedFile, "true"),
      /第 2 轮/u,
      '字符串 "true" 不能续上 boolean true 的计数',
    );
  });

  it("dropSession 对默认分片（无 id）是 no-op——默认分片只能靠 LRU/reset 回收", () => {
    const gate = new FactGate();
    gate.check("edit", "/w/d.ts", undefined, lack(["read"]));
    gate.dropSession(undefined);
    gate.dropSession("");
    // 首拒已记过数 → 第 2 次仍是"第 2 轮"，说明分片没被误清
    const second = gate.check("edit", "/w/d.ts", undefined, lack(["read"]));
    assert.match(denyMessage(second), /第 2 轮/u);
  });

  it("会话分片数有上限，超容量按最久未用淘汰（内存上界）", () => {
    const gate = new FactGate({ maxSessions: 2, maxDenies: 1 });
    for (const id of ["s0", "s1", "s2"]) {
      gate.check("edit", "/w/c.ts", id);
    }
    // s0 被淘汰：再次编辑从首拒重新开始（若是残留分片，maxDenies=1 会直接配额放行）
    assert.equal(gate.check("edit", "/w/c.ts", "s0").kind, "deny", "s0 分片已淘汰 → 重新首拒");
  });
});

// ── i18n：取证指令两语齐全（状态机回结构，文案在 lib/messages.ts）─────────────
describe("取证指令双语（文案表按语言渲染）", () => {
  /** 汉字区段：en 文案里出现即说明有句子没翻。 */
  const HAN = /\p{Script=Han}/u;

  it("两语模板的 {占位符} 集合一致（翻译不会漏掉插值）", () => {
    const keys = templateKeysOf();
    // 派生逻辑失效（例如文案表整体被换形状）时不让这条用例空转通过。
    assert.ok(keys.length >= 10, `只派生到 ${keys.length} 个带占位符的模板键`);
    for (const key of keys) {
      assert.deepEqual(
        placeholders(MESSAGES.en[key]),
        placeholders(MESSAGES.zh[key]),
        `${key} 占位符不一致`,
      );
    }
  });

  it("en：每个 need × 每个 why 都产出具操作性、不含汉字的文案", () => {
    for (const need of NEED_ORDER) {
      for (const why of ALL_NEED_WHY) {
        const line = gapLine(
          { need, why },
          { targetName: "a.ts", searchPath: "/w/proj" },
          MESSAGES_EN,
        );
        assert.ok(line.length > 4, `gapLine(${need},${why}) 为空/过短`);
        assert.match(line, /a\.ts/u, `gapLine(${need},${why}) 未落到目标名`);
        assert.match(line, OPERABLE[need], `gapLine(${need},${why}) 缺操作词`);
        assert.ok(!HAN.test(line), `gapLine(${need},${why}) 的英文文案混进汉字`);
      }
    }
  });

  it("en：上下文缺失时用英文占位（不把中文占位漏给模型）", () => {
    const line = gapLine({ need: "read", why: "never" }, undefined, MESSAGES_EN);
    assert.match(line, /the target file/u, "缺省目标名也随语言走");
    assert.ok(!HAN.test(line), line);
  });

  it("已确认行按当前语言显示 need 标签，不再直接拼内部键名", () => {
    const denial: FactDenial = {
      gaps: [],
      done: ["read", "refs", "test", "e2e", "docs"],
      attempt: 1,
      newFile: false,
    };
    assert.match(
      renderDenyMessage(denial, MESSAGES_ZH),
      /已确认：read、引用探查、test 层、e2e 层、文档层/u,
    );
    assert.match(
      renderDenyMessage(denial, MESSAGES_EN),
      /confirmed: read, references, test layer, e2e layer, docs layer/u,
    );
  });

  it("en：整条拒绝消息（头部 + 缺项 + 尾巴）全是英文，zh 渲染路径同一条代码", () => {
    const gate = new FactGate();
    const first = gate.check("edit", "/w/proj/src/en.ts", "s-en");
    assert.equal(first.kind, "deny");
    const zh = renderWith(first, MESSAGES_ZH);
    const en = renderWith(first, MESSAGES_EN);
    assert.match(zh, /编辑前先取证/u);
    assert.match(en, /Gather the facts before editing/u);
    assert.ok(!HAN.test(en), "整条英文拒绝消息不该混进汉字");
    assert.notEqual(en, zh, "两语渲染必须不同");
  });
});
