// test/agent-loop-e2e.test.ts —— **点对点层**：真 AgentLoop 跑完整回合，断言"模型到底看见了什么"。
//
// 这一层是上一轮 A/B 混合改造的**唯一实证**。原因很具体：预检的全部论点是一句话——
// "证据在模型**下一次动手之前**就出现在它的上下文里"。这在单元层只能测到"我们往结果面上挂了
// 一块 additionalContexts"，而挂上去 ≠ 看得见：官方的链是
//   post-execute 收下 additionalContexts → agent-loop 排到 **next-step** 边界 → 下一次
//   pre-step 才 claim 进请求（packages/core/agent-loop/src/tool-calls.ts:157）。
// 这三级里任何一级把我们的上下文吃掉，整套设计就是空的，而单元层全绿。
// 于是这里跑真 AgentLoop + 真 SessionStore + 真 ToolRuntime，只把**模型**换成脚本
// （ScriptedModel，按官方 LlmAdapter 面实现），断言取在两个地方：
//  - `model.requests[i]`：第 i 次请求里模型能看见的消息面（决定看得见，才叫前置）；
//  - 真磁盘：编辑放行后文件内容真的变了（结果不是我们自说自话）。
import { describe, it, afterAll } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import type { Agent } from "@deepseek-ai/dsh-agent";

import { MESSAGES } from "../lib/messages.ts";
import {
  PREFLIGHT_SOURCE_KIND,
  TOOL_READ,
  addSource,
  bootSpine,
  callResultOf,
  capTree,
  createAgent,
  disposeSpine,
  gateMarkOf,
  highBlind,
  midBlind,
  multiCallReply,
  preflightNotices,
  readDisk,
  registerModel,
  runTurn,
  textReply,
  toolCallReply,
  toolResultCount,
  visibleAt,
  writeDisk,
} from "./host-spine.ts";
import type { Spine } from "./host-spine.ts";
import { loggedText } from "./setup-logs.ts";

const { zh } = MESSAGES;
// 判别段的取法见 host-spine.ts：`[fact-gate]` 是三种口径共用的前缀，拿它当标记等于没断言。
const HANDOFF_MARK = gateMarkOf(zh.preflightHandoff);
const ATTACH_MARK = gateMarkOf(zh.preflightAttach);
const LIST_MARK = gateMarkOf(zh.headFirst);

/** 本轮开出去的测试台，随 describe 收。 */
const stages: Spine[] = [];

/** 装配一台 + 起一个真 Agent（cwd 指向那台的临时工程）。 */
async function staged(row: Record<string, unknown> = {}): Promise<{ spine: Spine; agent: Agent }> {
  const spine = await bootSpine(row);
  stages.push(spine);
  const agent = await createAgent(spine, spine.project.root);
  return { spine, agent };
}

/** 某次请求里本包投出去的那几条（按 source.kind 认，不靠文案猜）。 */
function preflightOfRequest(model: ReturnType<typeof registerModel>, index: number): string[] {
  return visibleAt(model, index)
    .filter((message) => message.sourceKind === PREFLIGHT_SOURCE_KIND)
    .map((message) => message.text);
}

describe("前置的实证：模型在下一次编辑之前就看到引用面", () => {
  afterAll(async () => {
    await Promise.all(stages.map(async (spine) => disposeSpine(spine)));
    stages.length = 0;
  });

  it("read 然后 edit(mid)：决定这次编辑的那一条请求里已经带着引用面，编辑当场放行并真落盘", async () => {
    const { spine, agent } = await staged();
    const file = await addSource(spine, "front.ts");
    // 造一个真实引用者：引用面要点名得出它，才算"扫过这棵树"而不是背了一句模板
    await writeDisk(
      path.join(spine.project.root, "test", "front.test.ts"),
      'import "src/front";\n',
    );
    const model = registerModel(spine, [
      toolCallReply("r1", "read", { file_path: file }),
      toolCallReply("e1", "edit", midBlind(file)),
      textReply("done"),
    ]);
    await runTurn(spine, agent, "改一下 front.ts");

    // 第 2 次请求 = 模型据此决定"要不要现在就改"的那一次：读取结果已进去，引用面必须在。
    const deciding = visibleAt(model, 1);
    assert.ok(
      deciding.some((message) => message.sourceKind === PREFLIGHT_SOURCE_KIND),
      "引用面没进模型上下文 ⇒ 所谓前置只是插件自己跑了一遍扫描",
    );
    const notice = preflightOfRequest(model, 1).join(" ");
    assert.ok(notice.includes(ATTACH_MARK));
    assert.ok(notice.includes("test/front.test.ts"), "引用面内容是真扫出来的（点名真实引用者）");
    assert.equal(
      preflightOfRequest(model, 1).length,
      1,
      "一步只投一条 notice（多于一条就是上下文 flooding）",
    );

    assert.equal(
      callResultOf(agent, "e1").isError,
      false,
      "read 由会话日志计入、refs 由 A 面水位计入 ⇒ 当场放行",
    );
    assert.match(
      await readDisk(file),
      /const padded = "x{230}"/u,
      "放行是真执行：文件内容按 new_string 改了",
    );
  });

  it("同一枚目标读两次只投一次引用面；换一枚目标重新投", async () => {
    const { spine, agent } = await staged();
    const first = await addSource(spine, "once-a.ts");
    const second = await addSource(spine, "once-b.ts");
    registerModel(spine, [
      toolCallReply("r1", "read", { file_path: first }),
      toolCallReply("r2", "read", { file_path: first }),
      toolCallReply("r3", "read", { file_path: second }),
      textReply("done"),
    ]);
    await runTurn(spine, agent, "先看两个文件");
    const notices = preflightNotices(agent);
    assert.equal(notices.length, 2, "同目标去重、异目标各投一次");
    assert.ok(notices.every((text) => text.includes(ATTACH_MARK)));
  });
});

describe("预检 B 面的实证：带证据的拒绝在真回合里一轮就够", () => {
  it("盲改被拦一次并把正文与引用面写进理由，模型原样重试即放行", async () => {
    const { spine, agent } = await staged();
    const file = await addSource(spine, "blind.ts");
    const model = registerModel(spine, [
      toolCallReply("e1", "edit", midBlind(file)),
      toolCallReply("e2", "edit", midBlind(file)),
      textReply("done"),
    ]);
    await runTurn(spine, agent, "改 blind.ts");

    const first = callResultOf(agent, "e1");
    assert.equal(first.isError, true);
    assert.ok(first.text.includes(HANDOFF_MARK));
    assert.ok(first.text.includes("const alpha = 1;"), "正文当场给了");
    assert.doesNotMatch(
      first.text,
      /满足任一即计入/u,
      "引用面已作为证据给出，就不该再以缺项的形式重复要求",
    );
    assert.equal(callResultOf(agent, "e2").isError, false, "重试凭水位放行");
    assert.ok(visibleAt(model, 2).length > visibleAt(model, 1).length, "回合在往前走");
  });

  it("清单点名的检索口径可以照做：read 加 grep(pattern,path) 之后重试放行", async () => {
    const { spine, agent } = await staged();
    // 要读到"清单"就得让 B 面答不出证据（它答得出就当场递证据、不给清单）：吃光扫描预算。
    // 于是这一枚用例证的正是集成层证不到的那一半——凭证来自**会话日志里模型自己的**读与搜。
    await capTree(spine);
    const file = await addSource(spine, "follow.ts");
    registerModel(spine, [
      toolCallReply("e1", "edit", highBlind(file, "1")),
      toolCallReply("r1", "read", { file_path: file }),
      toolCallReply("g1", "grep", { pattern: "follow.ts", path: spine.project.root }),
      toolCallReply("g2", "grep", {
        pattern: "follow.ts",
        path: path.join(spine.project.root, "test"),
      }),
      toolCallReply("e2", "edit", highBlind(file, "1")),
      textReply("done"),
    ]);
    await runTurn(spine, agent, "改导出面");
    const denied = callResultOf(agent, "e1");
    assert.equal(denied.isError, true);
    assert.ok(denied.text.includes(LIST_MARK), "high 档给清单");
    assert.equal(callResultOf(agent, "e2").isError, false, "照清单做过即放行");
    assert.match(await readDisk(file), /export const probe1 = 1;/u);
  });

  // 同一步里的多枚调用怎么排序是官方调度器的事（edit 声明为 exclusive ⇒ 形成屏障），
  // 而闸门只认"判定那一刻会话里有没有成功的读取"。两个方向都钉住，因为**顺序反过来
  // 就该拦**：只钉一边就等于没测到"闸门被自己这一批调用绕过去"那种形状。
  it("同一步里先读后改：读取已落地 ⇒ 编辑放行", async () => {
    const { spine, agent } = await staged();
    const file = await addSource(spine, "batch-read-first.ts");
    registerModel(spine, [
      multiCallReply([
        ["r1", "read", { file_path: file }],
        ["e1", "edit", midBlind(file)],
      ]),
      textReply("done"),
    ]);
    await runTurn(spine, agent, "一口气读并改");
    assert.equal(callResultOf(agent, "e1").isError, false, "读取先落地 ⇒ 取证成立");
    assert.match(await readDisk(file), /const padded/u, "编辑确实执行了");
  });

  it("同一步里先改后读：判定那一刻还没有任何成功读取 ⇒ 拦下来递证据", async () => {
    const { spine, agent } = await staged();
    const file = await addSource(spine, "batch-edit-first.ts");
    registerModel(spine, [
      multiCallReply([
        ["e1", "edit", midBlind(file)],
        ["r1", "read", { file_path: file }],
      ]),
      textReply("done"),
    ]);
    await runTurn(spine, agent, "把改放在读前面");
    const batched = callResultOf(agent, "e1");
    assert.equal(batched.isError, true, "改在读取之前 ⇒ 那一刻就是盲改");
    assert.ok(batched.text.includes(HANDOFF_MARK));
    assert.doesNotMatch(await readDisk(file), /const padded/u, "拦下来就没有落盘");
  });

  it("配额用尽：第二次放行并留下一条警告（真轮次、真事件序）", async () => {
    const { spine, agent } = await staged({ maxDenies: 1 });
    // 配额是 guard 的记账，只有走**行动清单**的那条路才推进轮次；B 面递证据拦的那一趟不计。
    // 所以先把扫描预算吃光，让 high 档的层证据答不出来（正向的递证据路径见上面几枚用例）。
    await capTree(spine);
    const file = await addSource(spine, "quota.ts");
    registerModel(spine, [
      toolCallReply("e1", "edit", highBlind(file, "a")),
      toolCallReply("e2", "edit", highBlind(file, "b")),
      // 决策 ④：配额只免上层探查、不免 read ⇒ 先补上 read，配额这条路才打开。
      toolCallReply("r1", TOOL_READ, { file_path: file }),
      toolCallReply("e3", "edit", highBlind(file, "c")),
      toolCallReply("e4", "edit", highBlind(file, "d")),
      textReply("done"),
    ]);
    await runTurn(spine, agent, "两次盲改 → 读过 → 再两次");
    const first = callResultOf(agent, "e1");
    assert.equal(first.isError, true);
    assert.ok(first.text.includes(LIST_MARK), `应走行动清单，实际：${first.text.slice(0, 200)}`);
    const withheld = callResultOf(agent, "e2");
    assert.equal(withheld.isError, true, "缺 read 时达上限也扣下配额");
    assert.match(withheld.text, /配额放行只免/u, "理由要说清配额免的是上层探查");
    assert.equal(callResultOf(agent, "e3").isError, true, "补 read 后先按正常过门再拒一轮");
    assert.equal(callResultOf(agent, "e4").isError, false, "熬满 maxDenies 换一次放行");
    assert.match(loggedText(), /maxDenies/u, "放行必须出声");
  });
});

describe("密钥面与危险命令在真回合里的表现", () => {
  it("编辑 .env：哨兵字符串不出现在任何一条模型可见消息里（任何一次请求、任何一个来源）", async () => {
    const { spine, agent } = await staged();
    const env = spine.project.envFile;
    const model = registerModel(spine, [
      toolCallReply("e1", "edit", {
        file_path: env,
        old_string: "OPENAI_API_KEY",
        new_string: "OPENAI_API_KEY_ROTATED",
      }),
      textReply("那我不改"),
    ]);
    await runTurn(spine, agent, "改一下 .env 里的 key");
    assert.equal(callResultOf(agent, "e1").isError, true, "密钥闸拦下了");
    const everyText = model.requests
      .map((_request, index) =>
        visibleAt(model, index)
          .map((message) => message.text)
          .join("\n"),
      )
      .join("\n");
    assert.doesNotMatch(everyText, /sk-test-sentinel/u, "凭据正文泄进了模型上下文");
    assert.match(await readDisk(env), /sk-test-sentinel/u, "文件本身没被动过");
  });

  it("危险命令的拒绝理由作为 tool 结果到达模型，回合继续跑而不是中断", async () => {
    const { spine, agent } = await staged();
    const model = registerModel(spine, [
      toolCallReply("b1", "bash", { description: "清理", command: "rm -rf /" }),
      textReply("换个说法"),
    ]);
    await runTurn(spine, agent, "清理一下根目录");
    const blocked = callResultOf(agent, "b1");
    assert.equal(blocked.isError, true);
    assert.ok(blocked.text.includes(zh.rmrf), "理由到了模型眼前");
    assert.equal(toolResultCount(agent), 1, "被拦的那次也照常落一条 tool/result");
    assert.ok(
      visibleAt(model, 1).some((message) => message.role === "tool"),
      "拒绝理由作为工具结果进了下一次请求 ⇒ 回合继续而不是断掉",
    );
  });
});
