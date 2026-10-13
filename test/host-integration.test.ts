// test/host-integration.test.ts —— **集成层**：把本包接进真实宿主 spine，走真实工具瀑布。
//
// 这一层存在的理由是单元桩够不到的一段事实：单元用例把 `ctx.tools` 做成一个只会收谓词的桩
// （test/bulkhead-isolation.test.ts 里那句 `ctx.provide("tools", { guard })`），于是
// 「官方到底怎么把调用交给我们、我们的决定又被官方怎么处理」从来没被跑过：
//  - 瀑布顺序：`tools/pre-execute` 整趟跑完才轮到单调的 guard（官方只在 `kind==='allow'` 时核 guard）；
//  - deny 的物化：理由被写成 `Error: <理由>` 的 `isError` 结果，模型收到的不是静默失败；
//  - `additionalContexts` 在真 dispatch 的结果面上到底存不存在、能不能与别的插件的上下文并存；
//  - guard 拿到的是**模型字面量**（深冻结，宿主不注入 realpath 形——全仓 grep `resolvedPaths`
//    零命中，路径解析在工具体内，见 packages/fs/tool-fs/src/read-target.ts:25），
//    所以软链/相对路径那两面能拦住靠的是本包自己的 realpathOf，这条依赖此前只写在注释里；
//  - **直接 `ctx.tools.execute` 不写会话日志**（只有 agent loop 会 appendToolCall）：
//    于是"模型自己检索过"这类凭证在这一层必然读不到，只有预检的投递水位能顶。
//    这条边界是本轮测出来的事实，所以下面把它写成显式断言，正向用例在
//    test/agent-loop-e2e.test.ts。
// 装配与工具见 test/host-spine.ts：真注册、真校验、真执行，read/edit/write 真的读盘写盘，
// 于是 mtime、外部改动、正文截断这些判据拿到的是真文件系统事实。
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import { rm, symlink } from "node:fs/promises";
import path from "node:path";

import type { Agent } from "@deepseek-ai/dsh-agent";
// 审批面的两个类型从声明它那一侧取（wire-safe 入口）：本包不依赖它的运行期实现，
// 这一层要钉的是"我们的 ask 决定被官方怎么读"。
import type { ApprovalOutcome, ApprovalRequestEvent } from "@deepseek-ai/dsh-user-approval/types";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContextFormed } from "@deepseek-ai/dsh-llm";

import { MESSAGES } from "../lib/messages.ts";
import { PREFLIGHT_MAX_BYTES, scanReferences } from "../lib/preflight-scan.ts";
import {
  ALPHA_BODY,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_READ,
  addSource,
  bootSpine,
  capTree,
  createAgent,
  dispatch,
  disposeSpine,
  gateMarkOf,
  highBlind,
  markOf,
  midBlind,
  readDisk,
  registerModel,
  runTurn,
  sessionEventCount,
  textReply,
  toolCallReply,
  writeDisk,
} from "./host-spine.ts";
import type { Spine } from "./host-spine.ts";
import { loggedText } from "./setup-logs.ts";

// 外来插件那一条上下文按官方口径自己声明一个 source.kind（官方插件测试同一手法）：
// MessageSourceMap 是合并式扩展，不声明就造不出「别的插件的消息」。
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    otherPlugin: { kind: "otherPlugin" } & ContextFormed;
  }
}

const { zh } = MESSAGES;
// 判别段的取法见 host-spine.ts：`[fact-gate]` 是三种口径共用的前缀，拿它当标记等于没断言。
const HANDOFF_MARK = gateMarkOf(zh.preflightHandoff);
const ATTACH_MARK = gateMarkOf(zh.preflightAttach);
const LIST_MARK = gateMarkOf(zh.headFirst);
const READ_HEAD_MARK = markOf(zh.preflightReadHead);
const REFS_HEAD_MARK = markOf(zh.preflightRefsHead);

/** 别的插件留下的痕迹：多条用例都按这一枚标记认「那句话不是我写的」，所以只写一遍。 */
const OTHER_PLUGIN_MARK = "[other-plugin]";

/** 本轮开出去的测试台，随 describe 收（每台一份独立临时工程，互不踩 mtime）。 */
const stages: Spine[] = [];

/** 装配一台，会话 cwd 指向那台自己的临时工程。 */
async function stage(row: Record<string, unknown> = {}): Promise<{ spine: Spine; agent: Agent }> {
  const spine = await bootSpine(row);
  stages.push(spine);
  const agent = await createAgent(spine, spine.project.root);
  return { spine, agent };
}

/** 真 dispatch 的返回值里模型实际读到的那一行（官方物化：`Error: <拒绝理由>`）。 */
function modelText(result: Awaited<ReturnType<typeof dispatch>>): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `<${block.type}>`))
    .join(" ");
}

/** 一条必定走**清单**的盲改：先把扫描预算吃光（capTree），B 面才答不出 refs / 层证据而让路，
 *  于是拒绝理由里逐条点名检索口径——想读"指令点了哪些工具"必须走这一档，
 *  mid 档与没截断的 high 档都会被 B 面当场递证据，压根不给清单。 */
async function refsLine(spine: Spine, agent: Agent, callId: string): Promise<string> {
  await capTree(spine);
  const file = await addSource(spine, `${callId}-probe.ts`);
  const result = await dispatch(spine, agent, callId, TOOL_EDIT, highBlind(file, callId));
  const text = modelText(result);
  assert.ok(text.includes(LIST_MARK), `应走行动清单，实际：${text.slice(0, 200)}`);
  return text;
}

/** 一条上下文消息的正文。 */
function contextText(message: { content: readonly { type: string; text?: string }[] }): string {
  return message.content.map((block) => block.text ?? "").join(" ");
}

describe("真实 spine 下的接线与物化", () => {
  afterAll(async () => {
    await Promise.all(stages.map(async (spine) => disposeSpine(spine)));
    stages.length = 0;
  });

  it("两条条目都装配成功，且 guard 真的进了官方链（rm -rf / 被物化成 isError 结果）", async () => {
    const { spine, agent } = await stage();
    // cordis 的 FiberState 是 const enum（运行时擦除），按发布 d.ts 的数值比：2 === ACTIVE
    assert.equal(spine.guardFiber.state, 2, "拦截条目必须 ACTIVE");
    assert.equal(spine.settingsFiber.state, 2, "设置条目必须 ACTIVE");
    const result = await dispatch(spine, agent, "b1", TOOL_BASH, {
      description: "清理",
      command: "rm -rf /",
    });
    assert.equal(result.isError, true);
    assert.match(modelText(result), /^Error: \[danger-guard\]/u, "官方给的理由带 Error: 前缀");
    assert.ok(modelText(result).includes(zh.rmrf), "理由正文就是本包那条 rmrf 文案");
  });

  it("guard 拿到的是模型字面量：相对路径按会话 cwd 归一到真实目标并交出真正文", async () => {
    const { spine, agent } = await stage();
    const absolute = await dispatch(
      spine,
      agent,
      "a1",
      "edit",
      midBlind(await addSource(spine, "abs.ts")),
    );
    assert.ok(modelText(absolute).includes(HANDOFF_MARK), "绝对形：B 面带证据拦");

    await addSource(spine, "rel.ts");
    const relative = await dispatch(spine, agent, "a2", TOOL_EDIT, midBlind("src/rel.ts"));
    assert.ok(modelText(relative).includes(HANDOFF_MARK), "相对形同样认得出来");
    assert.ok(
      modelText(relative).includes(ALPHA_BODY),
      "相对路径按会话 cwd 解析到了真实内容，而不是拿一条不存在的路径去读",
    );
  });

  it("软链指到密钥文件仍按密钥面拦，且正文一个字都不出现在理由里", async () => {
    const { spine, agent } = await stage();
    const link = path.join(spine.project.root, "looks-harmless.link");
    await symlink(spine.project.envFile, link);
    const result = await dispatch(spine, agent, "s1", TOOL_EDIT, {
      file_path: link,
      old_string: "OPENAI",
      new_string: "XXXXXX",
    });
    assert.equal(result.isError, true);
    assert.ok(modelText(result).includes(zh.secretPath), "真实路径是密钥文件 ⇒ 密钥闸拦");
    assert.doesNotMatch(modelText(result), /sk-test-sentinel/u, "正文一旦进理由就是凭据外泄");
  });

  it("密钥目标整趟不进 B 面：既不给插件取到的证据，也不给事实门清单", async () => {
    const { spine, agent } = await stage();
    const result = await dispatch(spine, agent, "s2", TOOL_EDIT, {
      file_path: spine.project.envFile,
      old_string: "OPENAI_API_KEY",
      new_string: "OPENAI_API_KEY2",
    });
    assert.ok(modelText(result).includes(zh.secretPath));
    assert.doesNotMatch(modelText(result), /fact-gate/u, "密钥闸不给事实门让路");
  });

  it("别的插件先 deny ⇒ 本包原样交回，不写水位、不抢决定", async () => {
    const { spine, agent } = await stage();
    spine.ctx.on("tools/pre-execute", async (_exec, next) => {
      // next() 是瀑布的下游执行口，不是错误优先回调：它的结果就是本层判断
      // "别人已经拦过"的依据，所以必须接住变量而不是直接 `return next()`。
      // oxlint-disable-next-line node/callback-return -- 理由见上一行
      const downstream = await next();
      return downstream.kind === "allow"
        ? { kind: "deny", reason: `${OTHER_PLUGIN_MARK} 我先拦了` }
        : downstream;
    });
    const file = await addSource(spine, "queue.ts");
    const first = await dispatch(spine, agent, "p1", TOOL_EDIT, midBlind(file));
    assert.ok(modelText(first).includes(OTHER_PLUGIN_MARK), "别人的理由不被替换");
    assert.doesNotMatch(modelText(first), /fact-gate/u, "本包不在这趟上写下任何证据");
    const second = await dispatch(spine, agent, "p2", TOOL_EDIT, midBlind(file));
    assert.equal(modelText(second), modelText(first), "没有水位被记上 ⇒ 第二次仍是同一决定");
  });

  it("pre-execute 里被拦下的调用不进 guard ⇒ 事实门的轮次不推进", async () => {
    const { spine, agent } = await stage();
    // 轮次是 guard 的记账，只有走**行动清单**那条路才推进；先把扫描预算吃光，B 面才让路
    // （否则它当场递证据并写下水位，q3 就直接放行了，这条用例什么也测不到）。
    await capTree(spine);
    const stopper = spine.ctx.on("tools/pre-execute", async (_exec, next) => {
      // oxlint-disable-next-line node/callback-return -- 同上：next() 的结果就是本层的决定依据
      const downstream = await next();
      return downstream.kind === "allow" ? { kind: "deny", reason: "[stopper] 停" } : downstream;
    });
    const file = await addSource(spine, "rounds.ts");
    const stopped = await Promise.all([
      dispatch(spine, agent, "q1", TOOL_EDIT, highBlind(file, "a")),
      dispatch(spine, agent, "q2", TOOL_EDIT, highBlind(file, "b")),
    ]);
    assert.ok(stopped.every((result) => result.isError));
    stopper();
    const after = await dispatch(spine, agent, "q3", TOOL_EDIT, highBlind(file, "c"));
    assert.ok(modelText(after).includes(LIST_MARK), "现在才第一次走到 guard");
    assert.doesNotMatch(modelText(after), /第 [2-9] 轮/u, "被截住的那两趟不该推进轮次");
  });

  it("预检 B 面：证据取自真实磁盘（目标正文 + 真引用面），原样重试即放行", async () => {
    const { spine, agent } = await stage();
    const file = await addSource(spine, "handed.ts");
    // 造一个真实引用者，让"引用面"不是空话
    await writeDisk(
      path.join(spine.project.root, "test", "handed.test.ts"),
      "import 'src/handed';\n",
    );
    const args = midBlind(file);
    const first = await dispatch(spine, agent, "h1", TOOL_EDIT, args);
    const text = modelText(first);
    assert.equal(first.isError, true);
    assert.ok(text.includes(HANDOFF_MARK), "B 面拦一次并把证据写进理由");
    assert.ok(text.includes(READ_HEAD_MARK), "带目标内容一块");
    assert.ok(text.includes(REFS_HEAD_MARK), "带引用探查一块");
    assert.ok(text.includes("test/handed.test.ts"), "引用面是真扫出来的：点名那个真实引用者");
    assert.ok(text.includes(ALPHA_BODY), "正文是真读回来的");
    const second = await dispatch(spine, agent, "h2", TOOL_EDIT, args);
    assert.equal(second.isError, false, "原样重试凭投递水位放行");
    assert.ok(modelText(second).includes("edited"), "工具体真的跑了");
    assert.match(await readDisk(file), /const padded = "x{230}"/u, "放行即落盘（不靠插件自报）");
  });

  it("预检 A 面：引用面随读取结果出去并换到凭证；同一趟里 read 仍缺（直接 dispatch 不落会话日志）", async () => {
    const { spine, agent } = await stage();
    const file = await addSource(spine, "attached.ts");
    const read = await dispatch(spine, agent, "r1", TOOL_READ, { file_path: file });
    assert.equal(read.isError, false);
    assert.ok(modelText(read).includes(ALPHA_BODY), "读取正文没被动过");
    const contexts = read.additionalContexts ?? [];
    assert.equal(contexts.length, 1, "官方结果面上带着那一块上下文");
    assert.equal(contexts[0]?.source.kind, "dangerguard-preflight");
    const notice = contexts.map((message) => contextText(message)).join(" ");
    assert.ok(notice.includes(ATTACH_MARK));

    const edit = await dispatch(spine, agent, "r2", TOOL_EDIT, midBlind(file));
    const text = modelText(edit);
    assert.equal(edit.isError, true);
    assert.ok(text.includes(HANDOFF_MARK), "仍拦一次：read 这项还没补上");
    assert.ok(text.includes(READ_HEAD_MARK), "B 面把正文补上");
    assert.doesNotMatch(
      text,
      /满足任一即计入/u,
      "⚠ A 面投的 refs 已计入凭证 ⇒ 这一项不再出现（没计入的话这里会再要一遍）",
    );
    const retried = await dispatch(spine, agent, "r3", TOOL_EDIT, midBlind(file));
    assert.equal(retried.isError, false, "read 由 B 面补上之后放行");
  });

  it("预检 A 面不吞下游的 additionalContexts，也不改写结果正文", async () => {
    const { spine, agent } = await stage();
    const file = await addSource(spine, "merge.ts");
    const foreign = createUserMessage({
      content: [{ type: "text", text: `${OTHER_PLUGIN_MARK} 也要给模型一句话` }],
      source: { kind: "otherPlugin", form: "notice", summary: "外来上下文" },
    });
    spine.ctx.on("tools/post-execute", async (_exec, _result, next) => {
      // oxlint-disable-next-line node/callback-return -- 同上：要把下游的上下文并到本层结果上
      const downstream = await next();
      return downstream.kind === "accept"
        ? { kind: "accept", additionalContexts: [foreign] }
        : downstream;
    });
    const read = await dispatch(spine, agent, "m1", TOOL_READ, { file_path: file });
    const texts = (read.additionalContexts ?? []).map((message) => contextText(message));
    assert.equal(texts.length, 2, "两边的上下文都在");
    assert.ok(
      texts.some((text) => text.includes(OTHER_PLUGIN_MARK)),
      "下游那一条没被替换掉",
    );
    assert.ok(modelText(read).includes(ALPHA_BODY), "正文照旧");
  });

  it("下游 post-execute 已经 block ⇒ A 面不把它翻成 accept", async () => {
    const { spine, agent } = await stage();
    const file = await addSource(spine, "blocked.ts");
    spine.ctx.on("tools/post-execute", async (_exec, _result, next) => {
      // oxlint-disable-next-line node/callback-return -- 这里要看一眼下游再决定交回什么
      await next();
      return {
        kind: "block",
        feedback: [{ type: "text", text: `${OTHER_PLUGIN_MARK} 结果不合格` }],
      };
    });
    const read = await dispatch(spine, agent, "k1", TOOL_READ, { file_path: file });
    assert.equal(read.isError, true, "block 的物化是失败结果");
    assert.ok(modelText(read).includes(OTHER_PLUGIN_MARK));
  });

  it("目标超过定长上界：正文截断并在理由里点明", async () => {
    const { spine, agent } = await stage();
    const big = await writeDisk(
      path.join(spine.project.root, "src", "big.ts"),
      `// ${"b".repeat(PREFLIGHT_MAX_BYTES + 500)}`,
    );
    // ⚠ old_string 取短：写面一大就判"大段重写"升 high，走的是清单而不是递证据——
    // 这条要钉的是"目标很大"，不是"这次改动很大"。
    const result = await dispatch(spine, agent, "g1", TOOL_EDIT, {
      file_path: big,
      old_string: "// b",
      new_string: `const padded = "${"x".repeat(230)}";`,
    });
    const text = modelText(result);
    assert.ok(text.includes(HANDOFF_MARK), `应为带证据的拦法，实际：${text.slice(0, 200)}`);
    assert.ok(
      text.includes(markOf(zh.preflightReadTruncated)),
      `半份正文必须自带截断说明，实际尾部：…${text.slice(-160)}`,
    );
    assert.ok(
      text.includes(String(PREFLIGHT_MAX_BYTES)),
      "点明上界是多少字节，模型才知道自己拿到的是多少",
    );
  });

  it("二进制目标拿不到正文 ⇒ B 面整趟让路，交回 guard 的行动清单", async () => {
    const { spine, agent } = await stage();
    const bin = await writeDisk(
      path.join(spine.project.root, "src", "blob.bin"),
      Buffer.concat([Buffer.from("ahead\n"), Buffer.alloc(64, 0)]),
    );
    const result = await dispatch(spine, agent, "n1", TOOL_EDIT, {
      file_path: bin,
      old_string: "ahead",
      new_string: `const padded = "${"x".repeat(230)}";`,
    });
    assert.equal(result.isError, true);
    assert.ok(modelText(result).includes(LIST_MARK), "拿不到证据就不该拦——那是纯拒绝");
    assert.doesNotMatch(modelText(result), /这次编辑先停下/u);
  });

  it("新建文件（write）免 read，但引用面仍要探 ⇒ 走新建头部而不是 B 面", async () => {
    const { spine, agent } = await stage();
    const fresh = path.join(spine.project.root, "src", "brand-new.ts");
    const result = await dispatch(spine, agent, "w1", "write", {
      file_path: fresh,
      content: "export const created = 1;\n",
    });
    // 新建目标没有正文可给，但引用面与层结论同一次扫描就给得出 ⇒ 现在由 B 面带证据拦
    const text = modelText(result);
    assert.equal(result.isError, true);
    assert.ok(text.includes(HANDOFF_MARK), `新建文件也由预检递证据，实际：${text.slice(0, 240)}`);
    assert.ok(
      text.includes(markOf(zh.preflightLayerLine)),
      "test 层的结论随行（同一趟扫描，不多花 I/O）",
    );
    const retry = await dispatch(spine, agent, "w2", "write", {
      file_path: fresh,
      content: "export const created = 1;\n",
    });
    assert.equal(retry.isError, false, "read 免、refs 与层凭投递水位 ⇒ 原样重试放行");
    assert.match(await readDisk(fresh), /export const created/u, "放行即落盘");
  });

  it("直接 dispatch 的调用不落会话日志 ⇒ 这一层的放行只可能来自预检自己的投递水位", async () => {
    const { spine, agent } = await stage();
    const file = await addSource(spine, "nolog.ts");
    const blind = highBlind(file, "x");
    const first = await dispatch(spine, agent, "l1", TOOL_EDIT, blind);
    assert.equal(first.isError, true);
    const settled = await Promise.all([
      dispatch(spine, agent, "l2", TOOL_READ, { file_path: file }),
      dispatch(spine, agent, "l3", "grep", { pattern: "nolog.ts", path: spine.project.root }),
    ]);
    assert.ok(settled.every((result) => !result.isError));
    assert.equal(
      sessionEventCount(agent),
      0,
      "这就是根因：不经 agent loop 的调用在会话日志里根本没有条目",
    );
    const afterSearch = await dispatch(spine, agent, "l4", TOOL_EDIT, blind);
    assert.equal(
      afterSearch.isError,
      false,
      "放行的是 l1 那趟投递写下的水位（下一枚用例把「模型自己搜过」这条单独钉死）",
    );
  });

  it("模型自己 dispatch 的检索换不到凭证 ⇒ 引用面仍由本包当场扫一遍", async () => {
    // 与上一枚用例的对照：这一台从头到尾只让模型自己 grep 过（没有任何预检投递），
    // 若那次 grep 被记账，本包就不必再扫，拒绝理由里也不会有引用面这一块。
    const { spine, agent } = await stage();
    const file = await addSource(spine, "solo.ts");
    const searched = await dispatch(spine, agent, "s1", "grep", {
      pattern: "solo.ts",
      path: spine.project.root,
    });
    assert.equal(searched.isError, false);
    assert.equal(sessionEventCount(agent), 0, "模型这次搜索没进会话日志");
    const afterSearch = await dispatch(spine, agent, "s2", TOOL_EDIT, highBlind(file, "s"));
    assert.equal(afterSearch.isError, true, "搜过也照样拦：这一层不认模型自己的检索");
    const text = modelText(afterSearch);
    assert.ok(text.includes(HANDOFF_MARK), `应为带证据的拦法，实际：${text.slice(0, 200)}`);
    assert.ok(
      text.includes(REFS_HEAD_MARK),
      "引用面这块只能由本包自己扫出来——那次 grep 一分凭证都没换到",
    );
  });

  it("preflightEnabled=false ⇒ 退回先拒绝、模型自己补证，判据一条不减", async () => {
    const { spine, agent } = await stage({ preflightEnabled: false });
    const file = await addSource(spine, "off.ts");
    const result = await dispatch(spine, agent, "o1", TOOL_EDIT, midBlind(file));
    assert.ok(modelText(result).includes(LIST_MARK), "走的是行动清单");
    assert.doesNotMatch(modelText(result), /这次编辑先停下/u, "没有当场递证据");
    assert.doesNotMatch(modelText(result), /const alpha = 1;/u, "连正文都不给");
  });

  it("enabled=false ⇒ 连危险命令也放行（真工具体照跑）", async () => {
    const { spine, agent } = await stage({ enabled: false });
    const result = await dispatch(spine, agent, "f1", TOOL_BASH, {
      description: "清理",
      command: "rm -rf /",
    });
    assert.equal(result.isError, false);
    assert.ok(modelText(result).includes("ran rm -rf /"), "工具体真的执行到了");
  });

  it("maxDenies 用尽 ⇒ 配额放行并留下一条警告（真实轮次，不是桩里的计数）", async () => {
    const { spine, agent } = await stage({ maxDenies: 1 });
    // 配额是 guard 的记账：只有走清单的那条路才推进轮次，所以先把扫描预算吃光（B 面答不出）
    await capTree(spine);
    const file = await addSource(spine, "quota.ts");
    const first = await dispatch(spine, agent, "d1", TOOL_EDIT, highBlind(file, "a"));
    assert.equal(first.isError, true);
    // 决策 ④：缺项里还有 read ⇒ 达上限也**扣下配额**（真实轮次里也一样）。
    const withheld = await dispatch(spine, agent, "d2", TOOL_EDIT, highBlind(file, "b"));
    assert.equal(withheld.isError, true, "缺 read 时配额不得放行");
    assert.match(modelText(withheld), /配额放行只免/u, "理由要说清配额免的是上层探查");
    // 读过目标 ⇒ read 不再是缺项，剩下的只落在上层探查 ⇒ 配额这条路才打开。
    // ⚠ 这一次读取必须走**真回合**（脚本模型 + runTurn），不能 `dispatch`：直接 dispatch
    // 不落会话日志（本文件另有用例钉着这条边界），而事实门的 read 证据正是从会话日志里读的
    // —— 用 dispatch 的话这次读取对门禁等于没发生，配额会被一直扣着（本轮实测踩过）。
    registerModel(spine, [toolCallReply("r1", TOOL_READ, { file_path: file }), textReply("read")]);
    await runTurn(spine, agent, "先读一眼目标");
    const again = await dispatch(spine, agent, "d3", TOOL_EDIT, highBlind(file, "c"));
    assert.equal(again.isError, true, "缺项变小 ⇒ 计数重置，先按正常过门再拒一轮");
    const second = await dispatch(spine, agent, "d4", TOOL_EDIT, highBlind(file, "d"));
    assert.equal(second.isError, false, "熬满 maxDenies 换一次放行");
    assert.match(loggedText(), /maxDenies/u, "放行必须出声");
  });

  it("session/disposed ⇒ 该会话的水位真的回收：A 面对同一枚目标重新投一次", async () => {
    const { spine, agent } = await stage();
    const file = await addSource(spine, "disposed.ts");
    const first = await dispatch(spine, agent, "v1", TOOL_READ, { file_path: file });
    assert.equal((first.additionalContexts ?? []).length, 1, "首次读取附上引用面");
    const again = await dispatch(spine, agent, "v2", TOOL_READ, { file_path: file });
    assert.equal(
      (again.additionalContexts ?? []).length,
      0,
      "同一枚目标不重复投（否则就是上下文 flooding）",
    );
    spine.ctx.emit("session/disposed", agent.session);
    const after = await dispatch(spine, agent, "v3", TOOL_READ, { file_path: file });
    assert.equal(
      (after.additionalContexts ?? []).length,
      1,
      "会话销毁后水位清零 ⇒ 重新投一次；仍为 0 说明这张表跨会话漏着",
    );
    const blind = await dispatch(spine, agent, "v4", TOOL_EDIT, midBlind(file));
    assert.equal(blind.isError, true, "回收台账不等于放行");
  });

  it("这台宿主没装 zg_search 那枚插件：拒绝理由不许点名它没注册的工具", async () => {
    const { spine, agent } = await stage();
    // 先把事实钉住：stock 目录里只有 grep/glob（docs/tool-catalog.md）；zg_search 属另一枚插件
    assert.notEqual(spine.ctx.tools.get("grep"), undefined);
    assert.notEqual(spine.ctx.tools.get("glob"), undefined);
    assert.equal(spine.ctx.tools.get("zg_search"), undefined, "这台 spine 上没注册它");
    const text = await refsLine(spine, agent, "t1");
    assert.doesNotMatch(text, /zg_search/u, "点了没注册的名字 ⇒ 模型白烧一次调用");
    assert.doesNotMatch(
      text,
      /root 指向/u,
      "严格口径的 root/query/fts/vector 属于那枚插件，没装就不该给这条路由",
    );
    assert.ok(text.includes("grep"), "注册在位的两条照点");
    assert.ok(text.includes("glob"));
  });

  it("配置里添了未注册的工具名 ⇒ 同样不进指令；注册在位的才点", async () => {
    const { spine, agent } = await stage({ refSearchTools: ["grep", "rg_search"] });
    const text = await refsLine(spine, agent, "t2");
    assert.doesNotMatch(text, /rg_search/u, "没注册的工具点了就是撒谎");
    assert.ok(text.includes("grep"), "注册在位的那条照点");
  });

  it("名单整条都不在这台宿主上 ⇒ 明说「无法记账」，而不是给一条走不通的路", async () => {
    const { spine, agent } = await stage({ refSearchTools: ["nope_a", "nope_b"] });
    const text = await refsLine(spine, agent, "t3");
    assert.doesNotMatch(text, /nope_a|nope_b/u, "两条都不存在，一条都不该点");
    assert.ok(
      text.includes("没有任何计入取证的检索工具"),
      `应给出「无法记账」那句指令，实际：${text.slice(0, 320)}`,
    );
  });

  it("真后端下软链一律不跟：断链与指向树外的链都不进结果，树外正文一个字都不被抄出", async () => {
    // 迁移到 ctx.fs 之后，"这一项是什么"不再由 readdir 的 Dirnt 形状顺手决定：
    // listDir 给的 type 是**跟过链**的（断链报 other），所以本包必须自己用 lstat 再拒一次。
    // 这里就是钉这件事：不拒的话一枚指向 / 的链就能让"项目级引用探查"读完整台机器。
    const { spine, agent } = await stage();
    const file = await addSource(spine, "linked.ts");
    const outside = path.join(spine.project.root, "..", `dg-outside-${String(process.pid)}.ts`);
    // 内容里带上目标的词干：不跟链就不会命中，跟了链就会把这一行抄出来——
    // 否则这个断言只是"文件名对不上"的空证明。
    await writeDisk(outside, 'import "./linked"; // sk-outside-leak\n');
    await addSource(spine, "inside.ts", 'import "./linked"; // sk-inside-control\n');
    const broken = path.join(spine.project.root, "broken.link");
    const escape = path.join(spine.project.root, "escape.link");
    await symlink(path.join(spine.project.root, "no-such.ts"), broken);
    await symlink(outside, escape);
    const text = modelText(await dispatch(spine, agent, "y1", TOOL_EDIT, midBlind(file)));
    assert.ok(text.includes(HANDOFF_MARK), "证据照递（这一支不因软链而整趟作废）");
    assert.doesNotMatch(text, /sk-outside-leak/u, "树外文件被跟读并抄进命中 ⇒ 扫描面弹出了目录树");
    assert.doesNotMatch(text, /broken\.link|escape\.link/u, "两枚链都不该作为命中出现");
    assert.ok(
      text.includes("sk-inside-control"),
      "对照组：同一层里的普通文件确实被扫到了 —— 上面两条「不含」才有意义",
    );
    await Promise.all([rm(broken), rm(escape), rm(outside)]);
  });

  it("引用命中不许把凭据文件的正文抄进证据（扫描面也算外泄）", async () => {
    const { spine, agent } = await stage();
    const file = await addSource(spine, "token.ts");
    // 让 `.env` 的某一行撞上目标的词干：这正是"引用命中"会被抄出去的那种行
    await writeDisk(spine.project.envFile, 'token = "sk-scan-leak-sentinel"\n');
    const result = await dispatch(spine, agent, "e2e1", TOOL_EDIT, midBlind(file));
    const text = modelText(result);
    assert.ok(text.includes(HANDOFF_MARK), "B 面照给证据（这条不改判据强度）");
    assert.doesNotMatch(
      text,
      /sk-scan-leak-sentinel/u,
      "凭据文件的正文一旦进引用命中，就是本包自己开了个外泄口",
    );
    assert.match(
      text,
      /未读 1 个凭据面文件|1 个凭据面文件按本包规则未读/u,
      `被隔离的份数要说出来（否则"零命中"会被读成全称结论），实际：${text.slice(0, 320)}`,
    );

    // 对照：同一枚扫描**摘掉隔离判据**就会把那行抄出来。留着这条断言是为了让这个修复
    // 不会被"判据其实没生效"冒充成"文件本来就没命中"。
    const bare = await scanReferences({
      targetN: file,
      root: spine.project.root,
      needles: ["token"],
      signal: new AbortController().signal,
      fs: spine.ctx.fs,
    });
    assert.ok(
      (bare?.findings ?? []).some((finding) => finding.text.includes("sk-scan-leak-sentinel")),
      "对照组失效说明磁盘形状变了，上面的绿也就不能算证住了什么",
    );
    assert.equal(bare?.quarantined, 0, "不给判据时不该有隔离计数");
  });

  it("隔离判据吃用户追加的词表：extraSecretPatterns 点名的路径同样不抄正文", async () => {
    // 这条同时钉两件事：① 扫描侧与密钥闸吃**同一把**词表（用户追加的模式在扫描面也生效）；
    // ② 内置分支之外的"有 extraSecretPatterns"那一支真被执行过（覆盖率只说走到没走到，
    //    这里说的是它确实改变了结论）。
    const { spine, agent } = await stage({ extraSecretPatterns: [String.raw`deploy\.sh`] });
    const file = await addSource(spine, "rollout.ts");
    await writeDisk(
      path.join(spine.project.root, "deploy.sh"),
      'rollout = "sk-user-pattern-leak"\n',
    );
    const text = modelText(await dispatch(spine, agent, "u1", TOOL_EDIT, midBlind(file)));
    assert.doesNotMatch(
      text,
      /sk-user-pattern-leak/u,
      "用户点名的凭据形态没进扫描隔离，就等于给用户开了一个绕过密钥面的口子",
    );
    assert.match(text, /凭据面文件/u, "被隔离的份数照报");
  });
});

// ── 需确认档（`ask` 通道）：官方 `serviceAsk` 的每个出口都钉住 ────────────────────
//
// 这一组存在的理由（与上面几组同源）：`{ kind: "ask" }` 是**宿主的**决定形状，不是我们的。
// 单元层只能证"我们交出了那个形状"，证不了"官方怎么读它、怎么物化它的结论"。所以这里
// 用真 `ToolRuntime` 走到官方的 `prepareExecution` → `serviceAsk`，而**答案**从一枚替身
// 审批服务来（官方那一侧只负责把答案映射成放行/拒绝——那是我们要钉的那一段）。
//
// 四条命题：
//   ① 无审批面（headless / CI）⇒ **fail-closed**：拒绝，且用**我们**交的 reason 当理由；
//   ② `allowed-once` ⇒ 真的放行并执行（审批不是"再拒一次"）；
//   ③ `rejected` / `unavailable` ⇒ 拒绝，且**工具体没有被调用**（物理停止在 dispatch 之前）；
//   ④ 请求带上了我们的 `reason` 与**逐语言**的 `displayReason`（弹窗那一面）。
/** 官方四种结论里我们最常用的那一枚（收常量：sonarjs 的 no-duplicate-string 盯重复字面量）。 */
const ALLOWED_ONCE: ApprovalOutcome = "allowed-once";

/** 装一台带假审批服务的 spine。`outcome` 是官方四种结论之一。
 *  提到模块层而不是放进 describe 体内：它不捕获任何外层变量，放在体内每轮重建（lint 的
 *  consistent-function-scoping 正是盯这件事）。 */
async function stageAsk(outcome?: ApprovalOutcome): Promise<{
  spine: Spine;
  agent: Agent;
  requests: ApprovalRequestEvent[];
}> {
  const requests: ApprovalRequestEvent[] = [];
  const spine = await bootSpine(
    {},
    outcome === undefined ? {} : { approval: { requests, outcome } },
  );
  stages.push(spine);
  return { spine, agent: await createAgent(spine, spine.project.root), requests };
}

describe("需确认档（ask 通道）：官方 serviceAsk 的四个出口", () => {
  /** 一条必然落在 `ask` 档的命令：引号不闭合 ⇒ 取不出体 ⇒ `nestedShellUnconfirmed`。 */
  const ASK_COMMAND = 'bash -c "rm -rf /';
  // `description` 是宿主那条 bash 夹具的必填参数（缺它会先被工具自己的参数校验拦下，
  // 那样测到的就不是审批通道）——照既有用例的给法补齐。
  const askExec = { description: "检查嵌套体", command: ASK_COMMAND } as const;

  it("无审批面 ⇒ fail-closed：拒绝，理由用我们交的那句（不是静默放行）", async () => {
    const { spine, agent } = await stageAsk();
    const text = modelText(await dispatch(spine, agent, "ask-none", TOOL_BASH, askExec));
    // 官方的降级臂给的是 `ask.reason ?? <它自己的兜底句>` —— 我们交了就一定是我们的那句。
    assert.equal(text, `Error: ${MESSAGES.zh.nestedShellUnconfirmed}`);
  });

  it("allowed-once ⇒ 真的放行并执行（审批不是换一种方式的拒绝）", async () => {
    const { spine, agent } = await stageAsk(ALLOWED_ONCE);
    const result = await dispatch(spine, agent, "ask-ok", TOOL_BASH, askExec);
    const text = modelText(result);
    assert.equal(result.isError, false, `审批放行后不该是错误结果：${text}`);
    assert.match(text, /ran .*rm -rf/u, "工具体确实被执行了");
  });

  it("rejected ⇒ 拒绝，且工具体没有被调用（物理停止在 dispatch 之前）", async () => {
    const { spine, agent } = await stageAsk("rejected");
    const result = await dispatch(spine, agent, "ask-no", TOOL_BASH, askExec);
    assert.equal(result.isError, true);
    // 文案归宿主（"the user rejected tool ..."）：这一句不是我们的，钉它是为了证
    // "拒绝确实发生了"，而不是证措辞。
    assert.match(modelText(result), /rejected/u);
  });

  it("unavailable ⇒ 拒绝并点明没有审批通道（headless 与'人说了不'要分得开）", async () => {
    const { spine, agent } = await stageAsk("unavailable");
    const text = modelText(await dispatch(spine, agent, "ask-unavail", TOOL_BASH, askExec));
    assert.match(text, /no approval channel is available/u);
    assert.doesNotMatch(text, /rejected/u, "两种拒绝的理由不同源，模型可分辨");
  });

  it("cancelled ⇒ 拒绝并点明审批被撤回（与'人说了不'是两回事）", async () => {
    const { spine, agent } = await stageAsk("cancelled");
    const text = modelText(await dispatch(spine, agent, "ask-cancel", TOOL_BASH, askExec));
    assert.match(text, /was cancelled/u);
  });

  it("审批请求带上我们的 reason 与**逐语言**的 displayReason（弹窗那一面）", async () => {
    const { spine, agent, requests } = await stageAsk(ALLOWED_ONCE);
    await dispatch(spine, agent, "ask-payload", TOOL_BASH, askExec);
    assert.equal(requests.length, 1, "一次 ask 恰好问一次");
    const req = requests.at(0);
    assert.ok(req !== undefined, "请求已记下");
    assert.equal(req.toolName, TOOL_BASH);
    assert.equal(req.reason, MESSAGES.zh.nestedShellUnconfirmed, "reason 用当次语言（默认中文）");
    // 逐语言的展示文案：写死 `{zh, en}` 会让宿主新增的语言静默取不到（见 displayReasonOf 注释）。
    assert.deepEqual(req.displayReason, {
      en: MESSAGES.en.nestedShellUnconfirmed,
      zh: MESSAGES.zh.nestedShellUnconfirmed,
    });
  });

  it("deny 档的命令**不问审批**（同一张 RULE_TIER：两档互斥，不可能双重收口）", async () => {
    const { spine, agent, requests } = await stageAsk(ALLOWED_ONCE);
    const result = await dispatch(spine, agent, "ask-not", TOOL_BASH, {
      description: "清理",
      command: "rm -rf /",
    });
    assert.equal(result.isError, true, "deny 档照旧硬拒");
    assert.match(modelText(result), /danger-guard/u);
    assert.equal(requests.length, 0, "deny 档不该弹审批（弹了就是把它也交给用户批准）");
  });
});
