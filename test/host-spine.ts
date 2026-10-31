// test/host-spine.ts —— 真实宿主 spine 的装配夹具（集成层 test/host-integration.test.ts 与
// 点对点层 test/agent-loop-e2e.test.ts 共用）。夹具只装配、不 it()（与 test/host-freshness.ts
// 同规矩：共享夹具自带用例会让 vitest 的结构类规则落到夹具头上）。
//
// 为什么值得把真 spine 请进来：此前所有 host 侧用例的 `tools` 服务是手搓桩
// （test/bulkhead-isolation.test.ts 里那句 `ctx.provide("tools", { guard })`），于是
// 「官方到底怎么把调用交给我们、我们的决定又被官方怎么处理」从来没被跑过：
//  pre-execute → guard → execute → post-execute 的真实顺序、deny 落成 `Error: <理由>` 的
//  isError 结果、`additionalContexts` 到底能不能被 loop 收下、真实会话事件
//  （`tool/call.arguments` 是 JSON **字符串**）能不能被本包台账读成凭证——这些在桩里全都
//  "测得出绿"，因为断言的对象就是桩自己的形状。
// 这里跑的是发布在 npm 上的同一份 0.2.1-alpha.2：ToolRuntime / AgentLoop / SessionStore /
// LlmRuntime 全是真件，只有**模型**是脚本（`ScriptedModel`，按官方 `LlmAdapter` 面实现）。
//
// 唯一保留的桩是 `settings`：真正的 `SettingsForms` 注入 `configEditor` + `profileContext`
// （installed @deepseek-ai/dsh-settings/lib/types/index.d.ts 的 `static inject`），两者属于
// Loader 启动层——实测缺它们时 `ctx.plugin(SettingsForms)` 直接抛
// "Cannot read properties of undefined (reading 'await')"。所以这里交回一份**按官方成员类型钉住**
// 的读数面（`Pick<SettingsForms, …>`，签名漂移当场编译期红），而闸门依赖的那位
// `SETTINGS_READER` 读数口由**本包自己的设置条目**真挂出来（不是测试替身）。
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Context } from "@deepseek-ai/cordis";
import type { Fiber } from "@deepseek-ai/cordis";
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from "@deepseek-ai/dsh-agent-loop-testkit";
import type { AgentLoopTestHarness } from "@deepseek-ai/dsh-agent-loop-testkit";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type {
  InferArgs,
  ParameterSchemaSpec,
  ToolDefinition,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";
import { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import type {
  ContentBlock,
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolCallId,
} from "@deepseek-ai/dsh-llm";
import type { SessionEvent, SessionId } from "@deepseek-ai/dsh-session";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SettingsForms, SettingsNamespace } from "@deepseek-ai/dsh-settings";
// 审批面的两个类型从**声明它那一侧**取（`@deepseek-ai/dsh-user-approval/types` 是 wire-safe
// 入口，不拖 cordis/service 链）：本包不依赖它、也不 import 它的运行期实现。
import type { ApprovalOutcome, ApprovalRequestEvent } from "@deepseek-ai/dsh-user-approval/types";
import { brandString } from "@deepseek-ai/dsh-brand";
import { LOCALE_SETTINGS_NAMESPACE } from "@jayyuen66/dsh-plugin-shared/lib/locale";

import guardPlugin from "../host.ts";
import { PREFLIGHT_MAX_DIRS } from "../lib/preflight-scan.ts";
import settingsPlugin from "../settings-host.ts";

/** 本包真实装配出来的两条 fiber 名（与 cordis.patch.yml 里的条目 id 同名）。 */
const GUARD_ENTRY = "danger-guard";
const SETTINGS_ENTRY = "danger-guard-settings";

/** 脚本模型的路由名：`registerAdapter([MOCK_ROUTE], …)` 与 AgentOptions 的 provider/model
 *  同一枚值。抄三遍不只被 sonarjs 点名，更是改一处漏两处的入口。 */
const MOCK_ROUTE = "mock";

/** 内容块类型名（StreamChunk 的臂名与结果块共用）。 */
const TEXT_BLOCK = "text";
const TOOL_CALL_BLOCK = "tool-call";

/** 会话事件名（台账读的就这几位，写三遍就会被 sonarjs 点名，更是改一处漏两处）。 */
const EVENT_TOOL_RESULT = "tool/result";
const EVENT_USER_MESSAGE = "user/message";

/** 工具名：stock 目录里的这几枚（spine 与两层用例共用，别各抄一份字形）。 */
export const TOOL_READ = "read";
export const TOOL_EDIT = "edit";
export const TOOL_BASH = "bash";

/** 预检注入消息的 `source.kind`——与 host.ts 那枚 `declare module` 声明的生产者名同字形。
 *  从夹具导出，用例侧就不许再手抄（改名时读的一侧先红，而不是断言静默失配）。 */
export const PREFLIGHT_SOURCE_KIND = "dangerguard-preflight";

/** `settings` 读数面里本包真正会调的那几位，按官方成员取（不手抄签名）。 */
type SettingsStub = Pick<SettingsForms, "configure" | "describe">;

/** 一次性建好一个"像真工程"的临时目录：门禁的 projectRootOf 认盘上的标记文件，
 *  层探查也按目录名判，替身路径会让"扫到了什么"整段退化成空断言。 */
export interface ProjectFixture {
  readonly root: string;
  /** 项目内的普通源文件（有真实引用者：test/main.test.ts）。 */
  readonly mainFile: string;
  readonly testFile: string;
  /** 密钥/凭据形态的目标（正文里放哨兵字符串，用于证明"正文绝不外泄"）。 */
  readonly envFile: string;
  /** 没有引用者的孤立文件。 */
  readonly orphanFile: string;
}

/** 一台装好真 spine 的测试台。 */
export interface Spine {
  readonly ctx: Context;
  readonly harness: AgentLoopTestHarness;
  readonly project: ProjectFixture;
  /** 会话/Agent 的 id：每台唯一——投递水位按「会话id|目标」记账，跨台同 id 会让上一台的
   *  水位串到这一台（本包的会话回收用例正是冲这条来的，见 host-integration.test.ts）。 */
  readonly sessionId: string;
  readonly guardFiber: Fiber;
  readonly settingsFiber: Fiber;
}

let spineCount = 0;

/** 一条脚本化回复：一组官方 StreamChunk。 */
export type ScriptedReply = readonly StreamChunk[];

const PROJECT_MARKER = "package.json";
/** 凭据值（用例断言"没有泄进模型上下文"时引用它，不另抄字形）。 */
export const SECRET_TOKEN = "sk-test-sentinel-do-not-emit";
/** `.env` 里那一整行（文件内容断言用）。 */
export const SECRET_SENTINEL = `OPENAI_API_KEY=${SECRET_TOKEN}`;
const MAIN_BODY =
  "export const value = 1;\nexport function helper(x: number) {\n  return x + 1;\n}\n";
const MAIN_IMPORT = `import { value } from "../src/main.ts";\nconsole.log(value);\n`;
const ORPHAN_BODY = "export const lonely = 1;\n";
/** addSource 的默认正文：用例断言"真正文到手"就比这一串（导出以免各处抄字形）。 */
const ALPHA_DECL = ["const", "alpha", "= 1;"].join(" ");
export const ALPHA_BODY = `${ALPHA_DECL}\n`;

/** 建临时工程目录（全异步：本仓 lint 不容许测试里铺一批 sync fs）。 */
export async function makeProject(): Promise<ProjectFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dg-spine-"));
  const mainFile = path.join(root, "src", "main.ts");
  const testFile = path.join(root, "test", "main.test.ts");
  const orphanFile = path.join(root, "src", "orphan.ts");
  const envFile = path.join(root, ".env");
  await Promise.all([
    writeFile(path.join(root, PROJECT_MARKER), '{ "name": "spine-fixture" }\n'),
    mkdir(path.join(root, "src"), { recursive: true }),
    mkdir(path.join(root, "test"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(mainFile, MAIN_BODY),
    writeFile(testFile, MAIN_IMPORT),
    writeFile(orphanFile, ORPHAN_BODY),
    writeFile(envFile, `${SECRET_SENTINEL}\n`),
  ]);
  return { root, mainFile, testFile, envFile, orphanFile };
}

/** 写任意路径并原样回传（超大目标、二进制目标、软链这些都是判据要的磁盘形状）。 */
export async function writeDisk(file: string, body: string | Buffer): Promise<string> {
  await writeFile(file, body);
  return file;
}

/** 读盘：断言"拦下来就没落盘 / 放行真的改了文件"，不靠插件自报。 */
export async function readDisk(file: string): Promise<string> {
  return readFile(file, "utf8");
}

/** 工程 src/ 下另起一枚目标文件。用例之间绝不共用目标：投递水位与扫描缓存都按
 *  「会话|目标」记账，同一枚文件被上一条用例碰过，这一条就已经不是"盲改"了。
 *  @param spine 测试台
 *  @param name src/ 下的文件名
 *  @param body 正文（默认可被 midBlind 的 old_string 命中）
 *  @returns 绝对路径 */
export async function addSource(spine: Spine, name: string, body = ALPHA_BODY): Promise<string> {
  return writeDisk(path.join(spine.project.root, "src", name), body);
}

/** 把引用扫描的遍历预算吃光（目录数超过 `PREFLIGHT_MAX_DIRS`）。只有"扫不完"的那一趟，
 *  B 面才答不出 refs / 层证据而整趟让路给 guard 的行动清单——两层用例都要用它才能读到
 *  「清单点了哪些检索工具」，以及让事实门的拒绝轮次真的推进（配额那条判据的唯一入口）。 */
export async function capTree(spine: Spine): Promise<void> {
  const dirs = Array.from({ length: PREFLIGHT_MAX_DIRS + 44 }, (_unused, index) =>
    mkdir(path.join(spine.project.root, `cap${String(index)}`), { recursive: true }),
  );
  await Promise.all(dirs);
}

/**
 * 官方 `defineTool` 的一层薄包装：把「返回一段文本」这个最常见形状收成 `Promise<string>`。
 *
 * 为什么不用官方的 `defineContentToolFixture`：它在支持窗口内**换过宿主包**（最新一版把它
 * 从 `@deepseek-ai/dsh-tools` 移到了 tool-testkit），而 `defineTool` 三版都在、签名逐字相同。
 * 这层包装只做 schema 填充与渲染，参数校验与执行链仍由官方那套给出。
 */
function contentTool<Spec extends ParameterSchemaSpec>(options: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Spec;
  readonly execute: (args: InferArgs<Spec>) => Promise<string>;
}): ToolDefinition {
  return defineTool({
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: TEXT_BLOCK, text: value }],
    },
    execute: (args) => options.execute(args),
  });
}

/** 官方参数面里"路径键"的真实出处（docs/tool-catalog.md + packages/fs/tool-fs/src/*.ts）：
 *  `dsh-tool-fs` 的 read/write/edit **只认 `file_path`**；`path` 只属于 opt-in 的
 *  `str_replace_editor`（且要求绝对路径）。本包额外认 `path` 是为那一条，不是为 stock 工具。 */
function registerFileTools(ctx: Context): void {
  ctx.tools.register(
    contentTool({
      name: TOOL_READ,
      description: "read a file",
      // 真件参数：file_path 必填，offset/limit 可只读一段（src/read.ts:78-84）
      parameters: {
        file_path: { type: "string", required: true },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      async execute(args) {
        const body = await readFile(args.file_path, "utf8");
        const lines = body.split("\n");
        const from = args.offset ?? 0;
        const count = args.limit ?? lines.length;
        return lines.slice(from, from + count).join("\n");
      },
    }),
  );
  ctx.tools.register(
    contentTool({
      name: TOOL_EDIT,
      description: "replace within a file",
      // 真件参数：只有一对 old/new（src/edit.ts:86-97），宿主没有 edits 数组那种形态
      parameters: {
        file_path: { type: "string", required: true },
        old_string: { type: "string", required: true },
        new_string: { type: "string", required: true },
        replace_all: { type: "boolean" },
      },
      async execute(args) {
        const before = await readFile(args.file_path, "utf8");
        const after =
          args.replace_all === true
            ? before.split(args.old_string).join(args.new_string)
            : before.replace(args.old_string, args.new_string);
        await writeFile(args.file_path, after);
        return `edited ${args.file_path}`;
      },
    }),
  );
  ctx.tools.register(
    contentTool({
      name: "write",
      description: "create or overwrite a file",
      parameters: {
        file_path: { type: "string", required: true },
        content: { type: "string", required: true },
      },
      async execute(args) {
        await writeFile(args.file_path, args.content);
        return `wrote ${args.file_path}`;
      },
    }),
  );
  // 真 bash 的必填面里还有 description，超时叫 timeoutMs、目录叫 workdir（不是 cwd）：
  // packages/shell/tool-bash/src/index.ts:368 起。本包只从里面取 `command`。
  ctx.tools.register(
    contentTool({
      name: TOOL_BASH,
      description: "run a shell command",
      parameters: {
        description: { type: "string", required: true },
        command: { type: "string", required: true },
        timeoutMs: { type: "number" },
        workdir: { type: "string" },
      },
      async execute(args) {
        return `ran ${args.command}`;
      },
    }),
  );
}

/** 检索类工具：本包只按"名字 + 参数口径 + 调用成功"给凭证，正文内容不参与判定，
 *  所以这里返回固定文本即可（真 grep 的命中与否不是门禁的判据）。
 *  ⚠ 这台 spine 只按 **stock profile 的真实工具**注册：`grep`(pattern*, path, include) 与
 *  `glob`(pattern*, path)（packages/fs/tool-fs-search/src/{grep,glob}.ts）。
 *  `zg_search`（root/query/fts/vector）由另一枚插件 `@jayyuen66/dsh-zvec-grep` 注册，这里**不装它**：
 *  于是"未注册的名字不该进指令"那两条用例有对照面（装了它的宿主上由
 *  test/host-contract.test.ts 的探测分支负责照点）。 */
function registerSearchTools(ctx: Context): void {
  const searchParameters = {
    pattern: { type: "string", required: true },
    path: { type: "string" },
    include: { type: "string" },
  } as const;
  for (const name of ["grep", "glob"]) {
    ctx.tools.register(
      contentTool({
        name,
        description: `search (${name})`,
        parameters: searchParameters,
        async execute() {
          return "no matches";
        },
      }),
    );
  }
  // opt-in 的第二条编辑器（tool-str-replace-editor/src/index.ts:429-467）：键名换成 path。
  // 单独开一台，才能证明本包对"另一种键形"确实接得住。
  ctx.tools.register(
    contentTool({
      name: "str_replace_editor",
      description: "edit via path",
      parameters: {
        command: { type: "string", required: true },
        path: { type: "string", required: true },
        old_str: { type: "string" },
        new_str: { type: "string" },
        file_text: { type: "string" },
      },
      async execute(args) {
        const { command } = args;
        if (command === "view") {
          return readFile(args.path, "utf8");
        }
        const before = command === "create" ? "" : await readFile(args.path, "utf8");
        const after =
          command === "str_replace"
            ? before.replace(args.old_str ?? "", args.new_str ?? "")
            : before + (args.file_text ?? "");
        await writeFile(args.path, after);
        return `${command} ${args.path}`;
      },
    }),
  );
}

/** 官方成员类型的桩：`configure` 交回真 disposer，`describe` 交出官方形状的清单。 */
function settingsStub(describe: SettingsStub["describe"]): SettingsStub {
  return {
    configure: (): (() => void) => (): void => {
      void 0;
    },
    describe,
  };
}

/** locale 条目的命名空间：名字从 shared 的常量取（本包读的正是这一位），品牌位按官方构造口给。 */
const LOCALE_NS = brandString<SettingsNamespace>(LOCALE_SETTINGS_NAMESPACE);

/** 品牌位一律经官方构造口给：`SessionId(...)`/`ToolCallId(...)` 那种"大写开头的直调"形会被
 *  new-cap 拦，而 brandString 就是官方自己的恒等构造（同 host.ts 用 brandNumber 的理由）。 */
const sessionIdOf = (raw: string): SessionId => brandString<SessionId>(raw);
const callIdOf = (raw: string): ToolCallId => brandString<ToolCallId>(raw);

/**
 * 假的审批服务：形状按官方 `ApprovalService` 的**被调用那一位**给（`request(req)`），
 * 返回官方的四种结论之一。
 *
 * 为什么不装官方的 `ApprovalService` 真件：本包要钉的不是"官方怎么收集答案"（那是官方的
 * 契约面），而是"**我们的 `{kind:'ask'}` 决定，官方是怎么读、怎么物化的**"。所以
 * 上面那一位由官方的 `serviceAsk` 提供，而答案从这一枚替身来。
 * ⚠ `request` 的入参形状按官方 `ApprovalRequestEvent` 声明收（不手抄字段名）：
 * 字段改名/换形状会在这里变成编译错误。
 */
export interface ApprovalSpy {
  /** 官方请求（含我们交的 `reason` 与 `displayReason`）原样记下，供断言。 */
  requests: ApprovalRequestEvent[];
  /** 下一条请求的结论；由用例按官方四种取值设定。 */
  outcome: ApprovalOutcome;
}

/**
 * 装配一台真 spine：真 ToolRuntime + 真 SessionStore + 真投影注册表 + 本包两条条目。
 * @param row 设置条目的**用户层 config**（越界值会只炸设置条目自己，见 bulkhead 用例）
 * @param options.localePreference 宿主 locale 偏好（`settings.describe()` 里那一条的真形状）
 * @param options.approval 装上假审批服务（不给 = 宿主没装审批面，走 `serviceAsk` 的降级臂）
 */
export async function bootSpine(
  row: Record<string, unknown> = {},
  options: { localePreference?: string; approval?: ApprovalSpy } = {},
): Promise<Spine> {
  // 工程目录先建：它不依赖 ctx，放在装配之后会让它一失败就留下已挂的 fiber、harness 与
  // 一份没被回收的 mkdtemp 目录（函数 reject 时拿不到 Spine，也就没人能 dispose）。
  const project = await makeProject();
  const ctx = new Context();
  // 描述符按官方 `SettingsDescriptor` 的**必填位**给齐（ns/autoGenerate/schema/value/revision/
  // applies）：本包只读 ns 与 value，但桩少给一位就是"桩比官方松"，而那正是漂移的入口。
  const describe: SettingsStub["describe"] = () =>
    options.localePreference === undefined
      ? []
      : [
          {
            ns: LOCALE_NS,
            autoGenerate: true,
            schema: {},
            value: { preference: options.localePreference },
            revision: 0,
            applies: "live",
          },
        ];
  ctx.provide("settings", settingsStub(describe));
  // 先解构出局部量：闭包里 `options.approval` 的收窄会丢（属性访问不参与控制流收窄）。
  const { approval } = options;
  if (approval !== undefined) {
    // 形状即官方 `ApprovalService` 上 `serviceAsk` 真正调的那一位（`request(req)`）：
    // 官方把服务改名/改签名时这里当场红。
    ctx.provide("approval", {
      request: (req: ApprovalRequestEvent): Promise<ApprovalOutcome> => {
        approval.requests.push(req);
        return Promise.resolve(approval.outcome);
      },
    });
  }
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
  registerFileTools(ctx);
  registerSearchTools(ctx);
  // 顺序照 shipped 拓扑：设置条目先挂出读数口，拦截条目随后 ctx.get 到它（反了则落回
  // BUILTIN_BASE——那条降级路径由 test/bulkhead-isolation.test.ts 专管，不在这里重测）。
  const settingsFiber = await ctx.plugin(
    {
      name: SETTINGS_ENTRY,
      inject: ["settings"],
      Config: settingsPlugin.Config,
      apply: settingsPlugin.apply,
    },
    row,
  );
  const guardFiber = await ctx.plugin({
    name: GUARD_ENTRY,
    inject: ["tools", "settings"],
    apply: guardPlugin.apply,
  });
  const harness = await mountAgentLoopTestHarness(ctx);
  spineCount += 1;
  return {
    ctx,
    harness,
    project,
    sessionId: `spine-${spineCount}`,
    guardFiber,
    settingsFiber,
  };
}

/** 起一个会话 cwd 指向临时工程的真 Agent。 */
export async function createAgent(spine: Spine, cwd: string): Promise<Agent> {
  return spine.harness.create(
    sessionIdOf(spine.sessionId),
    { provider: MOCK_ROUTE, model: MOCK_ROUTE },
    { cwd },
  );
}

/** 收台：真 fiber 全部卸载（插件的 disposer 随之跑），临时工程目录删掉。 */
export async function disposeSpine(spine: Spine): Promise<void> {
  await spine.ctx.fiber.dispose();
  await rm(spine.project.root, { recursive: true, force: true });
}

/** 直接经真 registry 派发一次调用（集成层用；点对点层走 runTurn）。 */
export async function dispatch(
  spine: Spine,
  agent: Agent,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  // 官方已把 `tools.execute` 收成**批次**入口：单发也要包成一条 `calls`，再把唯一那条结果
  // 拆回来。`arguments` 按模型产出的原形给——它是原始 JSON 串，不是已解析对象。
  const batch = await spine.ctx.tools.execute({
    calls: [
      {
        type: "tool-call",
        id: callIdOf(callId),
        name,
        arguments: JSON.stringify(args),
      },
    ],
    agent,
    signal: new AbortController().signal,
  });
  const [only] = batch.results;
  if (only === undefined) {
    throw new Error(`tools.execute 对单发调用没有交回结果：${name}`);
  }
  return only.result;
}

/** 若干枚调用 → 一串官方 chunk（每条占一个 block index，与官方适配器契约同形）。 */
function callChunks(
  calls: readonly (readonly [string, string, Record<string, unknown>])[],
): StreamChunk[] {
  const blocks = calls.flatMap(([rawCallId, name, args], index): StreamChunk[] => {
    const call = callIdOf(rawCallId);
    const argumentsJson = JSON.stringify(args);
    return [
      { type: "block-start", index, blockType: TOOL_CALL_BLOCK },
      { type: "tool-call-delta", index, id: call, name, argumentsDelta: argumentsJson },
      {
        type: "block-end",
        index,
        block: { type: TOOL_CALL_BLOCK, id: call, name, arguments: argumentsJson },
      },
    ];
  });
  // 一次响应只在所有 block 之后统一收尾一次：usage 与 finish 是"这一步"的，不是"每个调用"的。
  // 按调用各发一次会让适配器看到 N 份用量、N 个 finish（真宿主在第一个 finish 就结束该轮）。
  return [
    ...blocks,
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

/** 一段纯文本回复（回合收尾用）。 */
export function textReply(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: TEXT_BLOCK },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: TEXT_BLOCK, text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/** 一次工具调用回复（arguments 走官方 JSON 字符串形态，不是对象）。 */
export function toolCallReply(
  callId: string,
  name: string,
  args: Record<string, unknown>,
): StreamChunk[] {
  return callChunks([[callId, name, args]]);
}

/** 同一步里的多枚调用：真 loop 按官方调度序派发（工具体声明的 exclusive 形成屏障），
 *  脚本把它们放进**同一个响应**里就是"这一步一起动手"。 */
export function multiCallReply(
  calls: readonly (readonly [string, string, Record<string, unknown>])[],
): StreamChunk[] {
  return callChunks(calls);
}

/** 脚本化模型：每次 stream() 消耗一格剧本，并把收到的请求全量记下来（断言"模型看见了什么"）。 */
export class ScriptedModel extends LlmAdapter {
  public readonly requests: GenerateOptions[] = [];

  private readonly script: readonly ScriptedReply[];

  public constructor(script: readonly ScriptedReply[]) {
    super();
    this.script = script;
  }

  // 覆写的是官方契约里唯一需要模型元数据的一位；脚本模型没有"这台机器上有什么模型"
  // 这种状态可查，硬塞 this 只为过 lint。
  // oxlint-disable-next-line eslint/class-methods-use-this -- 理由见上一行
  public override async resolveModel(
    provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model };
  }

  public async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const entry = this.script[this.requests.length - 1];
    if (entry === undefined) {
      throw new Error("ScriptedModel: 剧本用完（模型多跑了一回合）");
    }
    for (const chunk of entry) {
      yield chunk;
    }
  }
}

/** 把剧本接进真 LlmRuntime。 */
export function registerModel(spine: Spine, script: readonly ScriptedReply[]): ScriptedModel {
  const model = new ScriptedModel(script);
  spine.ctx.llm.registerAdapter([MOCK_ROUTE], model);
  return model;
}

/** 发起一个回合并等它空闲（官方的 idle 判据就是 `agent/status`，不是自定义轮询）。
 *  发起与等待同处一身：先订阅再 followup，否则快回合可能在水位订阅之前就 idle 掉。 */
export async function runTurn(spine: Spine, agent: Agent, prompt: string): Promise<void> {
  // 先订阅再 followup：反过来的话快回合可能在订阅之前就 idle 掉，用例会挂到 testTimeout。
  // 等一枚官方事件必然是 deferred promise：`agent/status` 是事件而不是 promise，宿主没有可
  // 复用的等待原语。超时也不自建——交给 vitest 的 testTimeout，回合挂住就该红在超时上。
  // oxlint-disable-next-line promise/avoid-new -- 理由见上一行
  const idle = new Promise<void>((resolve, reject) => {
    const off = spine.ctx.on("agent/status", ({ agent: candidate, status }) => {
      if (candidate === agent && status === "idle") {
        off();
        resolve();
      }
    });
    try {
      // 官方签名回 `void`（不是 Promise）：这里只需接住同步抛错，并保证监听器一定撤下。
      agent.followup(
        createUserMessage({
          content: [{ type: TEXT_BLOCK, text: prompt }],
          source: { kind: "user" },
        }),
      );
    } catch (error: unknown) {
      off();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  await idle;
}

/** 一次模型请求里模型能看见的消息面（role + source.kind + 展平文本）。 */
export interface VisibleMessage {
  readonly role: string;
  readonly sourceKind: string;
  readonly text: string;
}

/** 一块内容 → 一行可比对的文本（非文本块留类型名，用例里断言"看见了调用"而不是字节）。 */
function flattenBlock(block: ContentBlock): string {
  return block.type === TEXT_BLOCK ? block.text : `<${block.type}>`;
}

/** 把某次请求的消息展平成可读文本。⚠ 真实的工具结果**不是** `tool-result` 内容块：
 *  它是 `role:'tool'` 的一条 ToolResultMessage，正文在它自己的 content 里
 *  （dsh-llm 的 ToolResultMessage）。按块类型猜会把结果读成空串，而"模型到底看见了什么"
 *  这条断言就退化成空断言。 */
export function visibleAt(model: ScriptedModel, requestIndex: number): VisibleMessage[] {
  const request = model.requests[requestIndex];
  if (request === undefined) {
    throw new Error(`没有第 ${requestIndex + 1} 次请求（模型少跑了一回合）`);
  }
  return request.messages.map((message) => ({
    role: message.role,
    sourceKind: message.source?.kind ?? "?",
    text: message.content.map(flattenBlock).join(" "),
  }));
}

/** 会话事件流的**唯一**读取点。官方把 `snapshotEvents` 标了 deprecated（新的同步事件读取被
 *  明令禁止，见 dsh 那条 deprecate-synchronous-session-event-reads note），而本包的取证判定
 *  读的正是这一位（host.ts 的 `SessionLogFace`）——这些用例要断言的也是"落到这一位上的有没有"。
 *  所以整仓只在这里调它、只关一次告警，而不是每条用例各关一遍。 */
function eventsOf(agent: Agent): readonly SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- 被测面就是这一位，读取点单点化
  return agent.session.snapshotEvents();
}

/** 会话里的事件总条数（集成层用它钉"直接 dispatch 不落会话日志"这条边界）。 */
export function sessionEventCount(agent: Agent): number {
  return eventsOf(agent).length;
}

/** 会话里 `tool/result` 的条数（"回合没被打断"这种结构性断言）。 */
export function toolResultCount(agent: Agent): number {
  return eventsOf(agent).filter((event) => event.type === EVENT_TOOL_RESULT).length;
}

/** 一次调用的结果正文与成败位。**取不到即抛**：会话里没这条结果不是"可以拿去断言 false"的
 *  普通形状，而是"这次调用根本没进会话"——静默回 undefined 会让下面的断言全塌成对 undefined
 *  的比较，那正是空断言的另一种写法。 */
export function callResultOf(
  agent: Agent,
  callId: string,
): { readonly text: string; readonly isError: boolean } {
  const hit = eventsOf(agent).find(
    (event): event is SessionEvent<"tool/result"> =>
      event.type === EVENT_TOOL_RESULT && event.data.message.toolCallId === callId,
  );
  if (hit === undefined) {
    throw new Error(`会话里没有 ${callId} 的 ${EVENT_TOOL_RESULT}`);
  }
  const { message } = hit.data;
  return {
    text: message.content.map(flattenBlock).join(" "),
    isError: message.isError === true,
  };
}

/** 会话里本包预检投出去的那条 notice 正文（A 面的落点）。 */
export function preflightNotices(agent: Agent): string[] {
  const notices = eventsOf(agent).filter((event) => event.type === EVENT_USER_MESSAGE);
  return notices
    .filter((event) => event.data.source.kind === PREFLIGHT_SOURCE_KIND)
    .map((event) => event.data.content.map(flattenBlock).join(" "));
}

/** mid 档盲改写进磁盘的正文（"放行即真落盘"的断言引用它，不另抄字形）。 */
export const MID_BLIND_NEW_STRING = `const padded = "${"x".repeat(230)}";`;

/** mid 档的盲改参数（写面 >200 字节、两侧都不碰导出面/签名关键字）。
 *  ⚠ old_string 里出现 `export`/`function` 会因"替换掉一枚导出"而升 high 档——那是真判据
 *  （改导出面确实更危险），但 mid 档的用例就会莫名其妙走清单而不是递证据。 */
export function midBlind(filePath: string): Record<string, unknown> {
  return {
    file_path: filePath,
    old_string: "const alpha = 1;",
    new_string: MID_BLIND_NEW_STRING,
  };
}

/** 高一档的盲改：触及导出面 ⇒ high ⇒ 缺项里多出"层"（test/e2e/docs）。B 面如今从**同一次**
 *  扫描派生层结论，所以这一档照样带证据拦；只有扫描跑不完时（见 capTree）才让路给行动清单——
 *  要读"指令点了哪些检索工具"、或要让事实门的拒绝轮次真推进，都得先把遍历预算吃光。 */
/** high 档盲改写进磁盘的导出行；`tag` 与 highBlind 同一取值。 */
export function highBlindNewString(tag: string): string {
  return `export const probe${tag} = 1;`;
}

export function highBlind(filePath: string, tag: string): Record<string, unknown> {
  return {
    file_path: filePath,
    old_string: "const alpha = 1;",
    new_string: highBlindNewString(tag),
  };
}

/** 带独占标签的文案（`[引用探查]` / `[目标内容]` / `[层探查]` / `[已截断]`）：标签本身就够判别，
 *  取到第一个空格为止。写在这里而不是各层各抄一份——抄开的两份正是下面那个坑的成因。 */
export const markOf = (template: string): string => {
  const at = template.indexOf(" ");
  if (at === -1) {
    // 没有空格 = 模板漂移：`slice(0, -1)` 会悄悄丢末字符，断言随之失配在别处。
    throw new Error(`模板没有标签分隔空格：${template.slice(0, 60)}`);
  }
  return template.slice(0, at);
};

/** `[fact-gate]` 那三种口径的判别段。⚠ 前缀是**共用**的（行动清单 / 当场递证据 / 随读取附上
 *  都以 `[fact-gate] ` 开头），所以拿 `markOf` 去判等于什么都没断言：本轮真踩过——「走清单」与
 *  「递证据」两条互斥的断言同时为真，一层用例因此在错误的分支上全绿。
 *  跳过前缀取到第一个标点为止，那一句才是三种口径各自独有的话。 */
export function gateMarkOf(template: string): string {
  const space = template.indexOf(" ");
  if (space === -1) {
    throw new Error(`模板没有标签分隔空格：${template.slice(0, 60)}`);
  }
  const body = template.slice(space + 1);
  const at = body.search(/[：（，。]/u);
  return at === -1 ? body : body.slice(0, at);
}
