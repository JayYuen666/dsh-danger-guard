// test/blast-radius.test.ts —— **爆炸半径预演**：常量表、上限收紧、渲染、以及接进 ask。
//
// 这一支的来源：dsh 官方自带的示例 mod `Blast Radius`
//（`packages/experimental/claude-code-mods/examples/blast-radius/`）对同一批 git 破坏命令
// 的做法是"先跑 `git status`/`git clean -n`/`du` 把清单量出来，再连面板一起给用户看"。
// 我们取它的一半（量证据），不取另一半（自定义 UI 面板归宿主）。
//
// ⚠ 这次改动**破了本包一条既有不变式**（「判定链没有任何 fs 写入、网络请求或子进程调用」）。
// 边界钉在 `lib/blast-radius.ts` 的文件头上；本文件按那三条边界逐条钉：
//   ① 只在 `ask` 档跑；② 只在执行器在位时跑；③ 命令表写死、不插值模型输入；
//   ④ 量不出来一律**退回盲问**（量证据是增强，不是判据）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  BLAST_COMMANDS,
  BLAST_MAX_CHARS,
  BLAST_MAX_LINES,
  BLAST_TIMEOUT_MS,
  clipBlast,
  measureBlastOf,
  renderBlast,
  withBlast,
} from "../lib/blast-radius.ts";
import { MESSAGES } from "../lib/messages.ts";
import { RULE_TIER } from "../lib/danger-rules.ts";
import { askRequestOf } from "../lib/confirm.ts";

const ZH = MESSAGES.zh;

/** 一条 `ask` 档请求的常驻夹具（git 族里最典型的那条）。 */
const ASK_COMMAND = "git reset --hard";
/** 上表里 `gitResetHard` 对应的预演命令（逐字引，免得两处漂）。 */
const STATUS_COMMAND = BLAST_COMMANDS.gitResetHard ?? "";
/** 一次预演的 spec 视图（假执行器把入参原样收下，断言按这几格取）。 */
interface SpecView {
  command?: unknown;
  onExpiry?: unknown;
  timeoutMs?: unknown;
  workdir?: unknown;
  /** 预演必须带的沙箱策略（与 runGate 同口径，见 measureBlastOf 的注释）。 */
  sandboxPolicy?: unknown;
}
const specOf = (calls: { spec: unknown }[], index = 0): SpecView => calls[index]?.spec ?? {};

/** 一台"照给定输出作答"的假执行器。记下实际跑的命令与入参，供断言。 */
function fakeShell(
  output: string,
  exitCode = 0,
): { calls: { command: unknown; spec: unknown }[]; shell: Record<string, unknown> } {
  const calls: { command: unknown; spec: unknown }[] = [];
  return {
    calls,
    shell: {
      resolve: (request: Record<string, unknown>) => request,
      execute: (spec: unknown) => {
        calls.push({ command: (spec as { command?: unknown }).command, spec });
        return Promise.resolve({
          result: () =>
            Promise.resolve({
              exitCode,
              timedOut: false,
              aborted: false,
              stdout: { text: output },
            }),
        });
      },
    },
  };
}

const signalOf = (): AbortSignal => new AbortController().signal;

describe("blast-radius：预演命令表", () => {
  it("表里全是**只读**命令（`--porcelain` / `-n` / `list` / `-vv` / `log`）", () => {
    for (const [key, command] of Object.entries(BLAST_COMMANDS)) {
      assert.match(
        command,
        /--porcelain|clean -nd|stash list|branch -vv|log /u,
        `${key}: ${command}`,
      );
    }
  });

  it("只覆盖 `ask` 档的 git 键 —— `deny` 档不跑预演（结论已定，量它不是用户要看的）", () => {
    for (const key of Object.keys(BLAST_COMMANDS)) {
      assert.equal(RULE_TIER[key as keyof typeof RULE_TIER], "ask", key);
    }
    // 反向：`deny` 档的四枚一律不在表里。
    for (const key of ["noVerify", "rmrf", "pipeShell", "devServer"] as const) {
      assert.equal(BLAST_COMMANDS[key], undefined, key);
    }
  });

  it("**不插值模型输入**：表里的命令是常量，逐条都不含占位/变量（那是注入面）", () => {
    for (const command of Object.values(BLAST_COMMANDS)) {
      assert.doesNotMatch(command, /\$\{|\$\(|`|;/u, command);
    }
  });

  it("墙钟上限与预检**同值**（同为工程上界，不是产品策略，故都不进设置面）", () => {
    assert.equal(BLAST_TIMEOUT_MS, 3000);
  });
});

describe("blast-radius：上限收紧与渲染", () => {
  it("空输出是**结论**（『此刻不会改动任何东西』），不是『什么都没查到』", () => {
    const line = renderBlast({ command: "git clean -nd", text: "" }, ZH);
    assert.match(line, /没有任何输出/u);
    assert.match(line, /不会改动任何东西/u);
    assert.match(line, /git clean -nd/u, "点名证据是哪条命令给的");
  });

  it("行数与字符数两道上限都生效，且**点明被收紧了**", () => {
    const manyLines = Array.from(
      { length: BLAST_MAX_LINES + 5 },
      (item, index) => `line${index}${String(item)}`,
    ).join("\n");
    const byLines = clipBlast(manyLines);
    assert.equal(byLines.text.split("\n").length, BLAST_MAX_LINES);
    assert.equal(byLines.clipped, true);

    const longLine = "x".repeat(BLAST_MAX_CHARS + 100);
    const byChars = clipBlast(longLine);
    assert.equal(byChars.text.length, BLAST_MAX_CHARS);
    assert.equal(byChars.clipped, true);

    const short = clipBlast("a\nb");
    assert.equal(short.clipped, false);

    const rendered = renderBlast({ command: "git log --oneline -n 10", text: longLine }, ZH);
    assert.match(rendered, /输出已按上限收紧/u);
    assert.match(rendered, new RegExp(String(BLAST_MAX_LINES), "u"));
    assert.match(rendered, new RegExp(String(BLAST_MAX_CHARS), "u"));
  });

  it("未被收紧时**不**添那句截断说明（假话比话少更糟）", () => {
    const rendered = renderBlast({ command: STATUS_COMMAND, text: " M a.ts" }, ZH);
    assert.doesNotMatch(rendered, /输出已按上限收紧/u);
  });

  it("渲染带块头与命令原文（让用户知道证据是哪来的）", () => {
    const rendered = renderBlast({ command: STATUS_COMMAND, text: " M a.ts" }, ZH);
    assert.match(rendered, /\[预演\]/u);
    assert.match(rendered, /git status --porcelain/u);
    assert.match(rendered, /M a\.ts/u);
  });

  it("英文块头不混汉字", () => {
    const rendered = renderBlast({ command: STATUS_COMMAND, text: " M a.ts" }, MESSAGES.en);
    assert.doesNotMatch(rendered, /\p{Script=Han}/u);
    const empty = renderBlast({ command: "git clean -nd", text: "" }, MESSAGES.en);
    assert.doesNotMatch(empty, /\p{Script=Han}/u);
  });
});

describe("blast-radius：接进 ask 的每一处文案", () => {
  it("接进 `reason`（模型侧）与 `displayReason` 的**每一门语言**（用户侧）", () => {
    // 只接 `reason` 不够：审批弹窗优先显示 `displayReason`，那样用户看不到证据。
    const ask = askRequestOf("bash", { command: ASK_COMMAND }, undefined, ZH);
    assert.ok(ask !== undefined);
    const enriched = withBlast(ask, "[预演] 证据");
    assert.ok(enriched.reason.endsWith("[预演] 证据"));
    assert.deepEqual(Object.keys(enriched.displayReason).toSorted(), ["en", "zh"]);
    assert.ok(enriched.displayReason.en.endsWith("[预演] 证据"));
    // 索引签名那一格要按方括号取（`noPropertyAccessFromIndexSignature`）。
    assert.ok(enriched.displayReason["zh"]?.endsWith("[预演] 证据") === true);
  });

  it("没有预演时原样交回（不凭空添一句『没有证据』）", () => {
    const ask = askRequestOf("bash", { command: ASK_COMMAND }, undefined, ZH);
    assert.ok(ask !== undefined);
    assert.equal(withBlast(ask, undefined), ask);
  });
});

describe("blast-radius：跑预演（**任何失败都退回盲问**）", () => {
  it("正常路径：按表里的命令跑，输出渲染好交回", async () => {
    const { shell, calls } = fakeShell(" M src/a.ts\n?? scratch.txt");
    const reading = await measureBlastOf({
      shellRaw: shell,
      policyRaw: undefined,
      command: STATUS_COMMAND,
      cwd: "/w/proj",
      session: undefined,
      signal: signalOf(),
      messages: ZH,
    });
    assert.match(reading ?? "", /scratch\.txt/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, STATUS_COMMAND);
    // 入参按官方 `ShellExecRequest` 给：到点杀进程、带取消信号、工作目录是会话 cwd。
    assert.equal(specOf(calls).onExpiry, "kill");
    assert.equal(specOf(calls).timeoutMs, BLAST_TIMEOUT_MS);
    assert.equal(specOf(calls).workdir, "/w/proj");
  });

  it("预演带上 sandboxPolicy：只读预演不许回落到部署级宽松策略", async () => {
    // `git status` 会刷 `.git/index`，那是一次**写**。不传策略时执行器按部署默认走，
    // 而部署默认可能是 `danger-full-access` —— 那这条"只读预演"就是唯一绕过沙箱写盘的路。
    // 与 runGate 那条路同口径：两处读同一个服务，只一处传就是两条纪律。
    const { shell, calls } = fakeShell(" M a.ts");
    const policy = {
      resolve: (request: { session?: unknown }) => ({ mode: "workspace-write", request }),
    };
    const session = { id: "s1" };
    await measureBlastOf({
      shellRaw: shell,
      policyRaw: policy,
      command: STATUS_COMMAND,
      cwd: "/w",
      session,
      signal: signalOf(),
      messages: ZH,
    });
    assert.deepEqual(specOf(calls).sandboxPolicy, {
      mode: "workspace-write",
      request: { session },
    });
    // 策略面读不到 ⇒ 不传这一位（预演照跑，失败即盲问，不额外造分支）。
    const bare = fakeShell(" M a.ts");
    await measureBlastOf({
      shellRaw: bare.shell,
      policyRaw: undefined,
      command: STATUS_COMMAND,
      cwd: "/w",
      session,
      signal: signalOf(),
      messages: ZH,
    });
    assert.equal("sandboxPolicy" in specOf(bare.calls), false);
    // session 缺席 ⇒ 给 resolve 空对象（官方读法：没 agent 就 resolve({})），不是「不调用」。
    const noSession = fakeShell(" M a.ts");
    const seen: unknown[] = [];
    await measureBlastOf({
      shellRaw: noSession.shell,
      policyRaw: {
        resolve: (request: unknown) => {
          seen.push(request);
          return { mode: "read-only" };
        },
      },
      command: STATUS_COMMAND,
      cwd: "/w",
      session: undefined,
      signal: signalOf(),
      messages: ZH,
    });
    assert.deepEqual(seen, [{}], "session 缺席时 resolve 收到空对象");
    // resolve 自己抛 ⇒ 同样不传这一位
    const throwing = {
      resolve: () => {
        throw new Error("nope");
      },
    };
    const bare2 = fakeShell(" M a.ts");
    await measureBlastOf({
      shellRaw: bare2.shell,
      policyRaw: throwing,
      command: STATUS_COMMAND,
      cwd: "/w",
      session,
      signal: signalOf(),
      messages: ZH,
    });
    assert.equal("sandboxPolicy" in specOf(bare2.calls), false);
  });

  it("会话目录缺席 ⇒ 不替它猜一个 cwd（`workdir` 那一键整个不送）", async () => {
    const { shell, calls } = fakeShell(" M a.ts");
    await measureBlastOf({
      shellRaw: shell,
      policyRaw: undefined,
      command: STATUS_COMMAND,
      cwd: undefined,
      session: undefined,
      signal: signalOf(),
      messages: ZH,
    });
    assert.equal("workdir" in specOf(calls), false);
  });

  it('`stdout` 整个缺席 ⇒ 盲问（`typeof undefined === "string"` 是假的）', async () => {
    const bare = {
      resolve: (request: Record<string, unknown>) => request,
      execute: () =>
        Promise.resolve({
          result: () => Promise.resolve({ exitCode: 0, timedOut: false, aborted: false }),
        }),
    };
    assert.equal(
      await measureBlastOf({
        shellRaw: bare,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
        messages: ZH,
      }),
      undefined,
    );
  });

  it("执行器缺席 ⇒ 盲问（不静默换一条命令，也不抛）", async () => {
    assert.equal(
      await measureBlastOf({
        shellRaw: undefined,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
        messages: ZH,
      }),
      undefined,
    );
    assert.equal(
      await measureBlastOf({
        shellRaw: {},
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
        messages: ZH,
      }),
      undefined,
    );
    assert.equal(
      await measureBlastOf({
        shellRaw: { resolve: 1 },
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
        messages: ZH,
      }),
      undefined,
    );
  });

  it("这一族没有预演命令 ⇒ 不跑（盲问）", async () => {
    const { shell, calls } = fakeShell("x");
    assert.equal(
      await measureBlastOf({
        shellRaw: shell,
        policyRaw: undefined,
        command: undefined,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
        messages: ZH,
      }),
      undefined,
    );
    assert.equal(calls.length, 0, "没有命令就一枚子进程都不该起");
  });

  it("非零退出 / 超时 / 取消 ⇒ 一律不采纳（那不是一条可用的结论）", async () => {
    const failing = {
      resolve: (request: Record<string, unknown>) => request,
      execute: () =>
        Promise.resolve({
          result: () =>
            Promise.resolve({
              exitCode: 128,
              timedOut: false,
              aborted: false,
              stdout: { text: "fatal" },
            }),
        }),
    };
    assert.equal(
      await measureBlastOf({
        shellRaw: failing,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
        messages: ZH,
      }),
      undefined,
    );

    const killedReadings = await Promise.all(
      (["timedOut", "aborted"] as const).map((flag) =>
        measureBlastOf({
          shellRaw: {
            resolve: (request: Record<string, unknown>) => request,
            execute: () =>
              Promise.resolve({
                result: () =>
                  Promise.resolve({
                    exitCode: 0,
                    timedOut: flag === "timedOut",
                    aborted: flag === "aborted",
                    stdout: { text: "x" },
                  }),
              }),
          },
          policyRaw: undefined,
          command: STATUS_COMMAND,
          cwd: "/w",
          session: undefined,
          signal: signalOf(),
          messages: ZH,
        }),
      ),
    );
    assert.deepEqual(killedReadings, [undefined, undefined], "超时与取消都不是可用的结论");
  });

  it("交回的形状不符（没有 result / 没有 stdout）⇒ 盲问，不抛", async () => {
    const badHandles: unknown[] = [
      {},
      { result: 1 },
      { result: () => Promise.resolve({}) },
      { result: () => Promise.resolve({ exitCode: 0, stdout: 1 }) },
    ];
    const badReadings = await Promise.all(
      badHandles.map((handle) =>
        measureBlastOf({
          shellRaw: {
            resolve: (request: Record<string, unknown>) => request,
            execute: () => Promise.resolve(handle),
          },
          policyRaw: undefined,
          command: STATUS_COMMAND,
          cwd: "/w",
          session: undefined,
          signal: signalOf(),
          messages: ZH,
        }),
      ),
    );
    // 每一项都必须是"没采纳"：`undefined` 而不是半份结论。
    assert.equal(badReadings.filter((item) => item !== undefined).length, 0);
  });

  it("`result()` 交回的根本不是对象 ⇒ 盲问", async () => {
    const bare = {
      resolve: (request: Record<string, unknown>) => request,
      execute: () => Promise.resolve({ result: () => Promise.resolve(undefined) }),
    };
    assert.equal(
      await measureBlastOf({
        shellRaw: bare,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
        messages: ZH,
      }),
      undefined,
    );
  });

  it("`resolve` 或 `execute` 抛错 ⇒ 盲问（预演失败不是告警，是『这次量不出来』）", async () => {
    const throwing = {
      resolve: () => {
        throw new Error("no executor");
      },
      execute: () => Promise.reject(new Error("spawn failed")),
    };
    assert.equal(
      await measureBlastOf({
        shellRaw: throwing,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
        messages: ZH,
      }),
      undefined,
    );
  });
});
