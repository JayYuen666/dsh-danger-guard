// test/blast-radius.test.ts —— **爆炸半径预演**：常量表、上限收紧、渲染、以及接进 ask。
//
// 这一支的来源：dsh 官方自带的示例 mod `Blast Radius`
//（`packages/experimental/claude-code-mods/examples/blast-radius/`）对同一批 git 破坏命令
// 的做法是"先跑 `git status`/`git clean -n`/`du` 把清单量出来，再连面板一起给用户看"。
// 我们取它的一半（量证据），不取另一半（自定义 UI 面板归宿主）。
//
// ⚠ 这次改动**破了本包一条既有不变式**（「判定链没有任何 fs 写入、网络请求或子进程调用」）。
// 边界钉在 `lib/blast-radius.ts` 的文件头上；本文件按那些边界逐条钉：
//   ① 只在 `ask` 档跑；② 只在执行器在位时跑；③ 命令表写死、不插值模型输入；
//   ④ 量不出来一律**退回盲问**（量证据是增强，不是判据）。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";

import {
  BLAST_COMMANDS,
  BLAST_MAX_CHARS,
  BLAST_MAX_LINES,
  BLAST_TIMEOUT_MS,
  blastTargetUncertainOf,
  clipBlast,
  measureBlastOf,
  renderBlast,
  withBlast,
} from "../lib/blast-radius.ts";
import type { BlastReading, MeasureBlastOptions } from "../lib/blast-radius.ts";
import { MESSAGES } from "../lib/messages.ts";
import { RULE_TIER } from "../lib/danger-rules.ts";
import { askRequestOf } from "../lib/confirm.ts";
import type { PolicyFacts } from "../lib/mode-policy.ts";

/** 夹具 cwd：按平台根拼（写死 `/w/proj` 在 Windows 上没有盘符）。 */
const FIXTURE_CWD = path.resolve(path.parse(process.cwd()).root, "w", "proj");

const ZH = MESSAGES.zh;

/** 「工作区内修改」档：能问、不是自动审查、沙箱不管这次目标 —— git 族在这档走审批。 */
const WS_MODE = "workspace-write";

const WORKSPACE_ASKABLE: PolicyFacts = {
  mode: WS_MODE,
  askable: true,
  autoReview: false,
  sandboxCovers: false,
};

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

interface FakeShell {
  calls: { command: unknown; spec: unknown }[];
  shell: Record<string, unknown>;
}

/** 一台"照给定输出作答"的假执行器。记下实际跑的命令与入参，供断言。 */
function fakeShell(output: string, exitCode = 0, truncated = false): FakeShell {
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
              stdout: { text: output, truncated },
            }),
        });
      },
    },
  };
}

/** 自报会沙箱的执行器：策略缺席时不应照跑。 */
const sandboxingShell = (output = " M a.ts"): FakeShell => {
  const fake = fakeShell(output);
  return {
    calls: fake.calls,
    shell: { ...fake.shell, sandboxMode: WS_MODE },
  };
};

/** 一台只按给定 `ShellRunResult` 作答的执行器（覆盖各种失败形状）。 */
const shellOfResult = (result: unknown): Record<string, unknown> => ({
  resolve: (request: Record<string, unknown>) => request,
  execute: () => Promise.resolve({ result: () => Promise.resolve(result) }),
});

const signalOf = (): AbortSignal => new AbortController().signal;

/** 测 `measureBlastOf` 的默认 `sourceCommand`；单个用例可按需覆盖。 */
const measure = (
  options: Omit<MeasureBlastOptions, "sourceCommand"> & { readonly sourceCommand?: string },
): Promise<BlastReading | undefined> => measureBlastOf({ sourceCommand: ASK_COMMAND, ...options });

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

describe("blast-radius：目标确定性", () => {
  it("`-C` / `--git-dir` / `--work-tree` 会让预演目标不确定", () => {
    for (const command of [
      "git -C sub reset --hard",
      'git "-C" sub reset --hard',
      "git --git-dir=/tmp/other reset --hard",
      "git --work-tree /tmp/other reset --hard",
    ]) {
      assert.equal(blastTargetUncertainOf(command), true, command);
    }
  });

  it("紧凑写法的 `-C` 同样会让预演目标不确定", () => {
    // git 自己接受 `-C<path>` 不带空格的形式。漏掉它们时，预演绑在会话 cwd 上跑，
    // 量到的是**另一棵树**的状态，而那段输出会被当成原命令的证据交给用户。
    for (const command of [
      "git -Csub reset --hard",
      "git -C/tmp/other reset --hard",
      'git -C"/tmp/other" reset --hard',
    ]) {
      assert.equal(blastTargetUncertainOf(command), true, command);
    }
  });

  it("`GIT_DIR` / `GIT_WORK_TREE` 环境变量同样会让预演目标不确定", () => {
    for (const command of [
      "GIT_DIR=/tmp/other/.git git reset --hard",
      "GIT_WORK_TREE=/tmp/other git reset --hard",
      "env GIT_WORK_TREE=/tmp/other git clean -fd",
    ]) {
      assert.equal(blastTargetUncertainOf(command), true, command);
    }
  });

  it("`cd` 离开 cwd 子树后目标不确定；留在子树里不算", () => {
    for (const command of [
      "cd /tmp/other && git reset --hard",
      "cd ~/other && git reset --hard",
      "cd $HOME/other && git reset --hard",
      "cd .. && git reset --hard",
      "cd /tmp/other; git clean -nd",
    ]) {
      assert.equal(blastTargetUncertainOf(command), true, command);
    }
    // `cd src` 之后仓库根仍然唯一，不该因此退回盲问。
    for (const command of [`cd src && ${ASK_COMMAND}`, ASK_COMMAND]) {
      assert.equal(blastTargetUncertainOf(command), false, command);
    }
  });

  it("普通 git 命令不受影响", () => {
    assert.equal(blastTargetUncertainOf(ASK_COMMAND), false);
    assert.equal(blastTargetUncertainOf("git commit -m x"), false);
    // `--config` 以 `-C` 打头，但它是另一枚选项：`(?!-)` 就是为了不把它误认成 `-C`。
    assert.equal(blastTargetUncertainOf("git --config core.x=y status"), false);
  });
});

describe("blast-radius：上限收紧与渲染", () => {
  it("空输出只说明探针没打印，**不是**安全结论", () => {
    const line = renderBlast({ command: "git clean -nd", text: "" }, ZH);
    assert.match(line, /没有任何输出/u);
    assert.match(line, /不能证明/u);
    assert.doesNotMatch(line, /此刻不会改动任何东西/u);
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

  it("只裁尾部空行：内部空行保留且不计入 `clipped`", () => {
    assert.deepEqual(clipBlast("a\n\nb"), { text: "a\n\nb", clipped: false });
    assert.deepEqual(clipBlast("a\nb\n"), { text: "a\nb", clipped: false });
    assert.deepEqual(clipBlast("\n\n"), { text: "", clipped: false });
  });

  it("未被收紧时**不**添那句截断说明（假话比话少更糟）", () => {
    const rendered = renderBlast({ command: STATUS_COMMAND, text: " M a.ts" }, ZH);
    assert.doesNotMatch(rendered, /输出已按上限收紧/u);
  });

  it("渲染带块头与命令原文（让用户知道证据是哪来的）", () => {
    const rendered = renderBlast({ command: STATUS_COMMAND, text: " M a.ts" }, ZH);
    assert.match(rendered, /\[预演\]/u);
    assert.ok(rendered.includes(STATUS_COMMAND));
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
    const ask = askRequestOf("bash", { command: ASK_COMMAND }, undefined, WORKSPACE_ASKABLE, ZH);
    assert.ok(ask !== undefined);
    const enriched = withBlast(ask, { command: STATUS_COMMAND, text: " M a.ts" }, ZH);
    assert.ok(enriched.reason.includes("[预演]"));
    assert.ok(enriched.reason.includes("M a.ts"));
    assert.deepEqual(Object.keys(enriched.displayReason).toSorted(), ["en", "zh"]);
    assert.ok(enriched.displayReason.en.includes("[rehearsal]"));
    assert.doesNotMatch(enriched.displayReason.en, /\[预演\]/u);
    // 索引签名那一格要按方括号取（`noPropertyAccessFromIndexSignature`）。
    assert.ok(enriched.displayReason["zh"]?.includes("[预演]") === true);
    assert.doesNotMatch(enriched.displayReason["zh"] ?? "", /\[rehearsal\]/u);
  });

  it("没有预演时原样交回（不凭空添一句『没有证据』）", () => {
    const ask = askRequestOf("bash", { command: ASK_COMMAND }, undefined, WORKSPACE_ASKABLE, ZH);
    assert.ok(ask !== undefined);
    assert.equal(withBlast(ask, undefined, ZH), ask);
  });
});

describe("blast-radius：跑预演（**任何失败都退回盲问**）", () => {
  it("正常路径：按表里的命令跑，读取结果交回", async () => {
    const { shell, calls } = fakeShell(" M src/a.ts\n?? scratch.txt");
    const reading = await measure({
      shellRaw: shell,
      policyRaw: undefined,
      command: STATUS_COMMAND,
      cwd: FIXTURE_CWD,
      session: undefined,
      signal: signalOf(),
    });
    assert.ok(reading !== undefined);
    assert.equal(reading.command, STATUS_COMMAND);
    assert.match(renderBlast(reading, ZH), /scratch\.txt/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, STATUS_COMMAND);
    // 入参按官方 `ShellExecRequest` 给：到点杀进程、带取消信号、工作目录是会话 cwd。
    assert.equal(specOf(calls).onExpiry, "kill");
    assert.equal(specOf(calls).timeoutMs, BLAST_TIMEOUT_MS);
    assert.equal(specOf(calls).workdir, FIXTURE_CWD);
  });

  it("预演带上 sandboxPolicy：只读预演不许回落到部署级宽松策略", async () => {
    // `git status` 会刷 `.git/index`，那是一次**写**。不传策略时执行器按部署默认走，
    // 而部署默认可能是 `danger-full-access` —— 那这条"只读预演"就是唯一绕过沙箱写盘的路。
    // 与 runGate 那条路同口径：两处读同一个服务，只一处传就是两条纪律。
    const { shell, calls } = fakeShell(" M a.ts");
    const policy = {
      resolve: (request: { session?: unknown }) => ({ mode: WS_MODE, request }),
    };
    const session = { id: "s1" };
    await measure({
      shellRaw: shell,
      policyRaw: policy,
      command: STATUS_COMMAND,
      cwd: "/w",
      session,
      signal: signalOf(),
    });
    assert.deepEqual(specOf(calls).sandboxPolicy, {
      mode: WS_MODE,
      request: { session },
    });
  });

  it("session 缺席时按空对象解析策略（官方读法）", async () => {
    const { shell } = fakeShell(" M a.ts");
    const seen: unknown[] = [];
    await measure({
      shellRaw: shell,
      policyRaw: {
        resolve: (request: unknown) => {
          seen.push(request);
          return { mode: WS_MODE };
        },
      },
      command: STATUS_COMMAND,
      cwd: "/w",
      session: undefined,
      signal: signalOf(),
    });
    assert.deepEqual(seen, [{}], "session 缺席时 resolve 收到空对象");
  });

  it("执行器自报不沙箱时策略面缺席 ⇒ 不传这一位照跑", async () => {
    const { shell, calls } = fakeShell(" M a.ts");
    await measure({
      shellRaw: shell,
      policyRaw: undefined,
      command: STATUS_COMMAND,
      cwd: "/w",
      session: { id: "s1" },
      signal: signalOf(),
    });
    assert.equal(calls.length, 1);
    assert.equal("sandboxPolicy" in specOf(calls), false);
  });

  it("执行器自报会沙箱时策略面缺席 ⇒ 盲问，不回落部署默认", async () => {
    const { shell, calls } = sandboxingShell();
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: { id: "s1" },
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(calls.length, 0, "没有会话策略就不该起子进程");
  });

  it("策略解析抛错 / 返回 undefined 或 null ⇒ 盲问", async () => {
    const throwing = {
      resolve: () => {
        throw new Error("nope");
      },
    };
    const { shell, calls } = fakeShell(" M a.ts");
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: throwing,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: { id: "s1" },
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(calls.length, 0);

    // oxlint-disable-next-line unicorn/no-useless-undefined -- 测的就是 resolve 返回 undefined 这一支
    const empty = { resolve: () => undefined };
    const second = fakeShell(" M a.ts");
    assert.equal(
      await measure({
        shellRaw: second.shell,
        policyRaw: empty,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: { id: "s1" },
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(second.calls.length, 0);

    // null 不是"没给"：若原样传下去，宿主的 `??` 会把它当成缺省并回落到部署默认。
    const nullPolicy = { resolve: () => null };
    const third = fakeShell(" M a.ts");
    assert.equal(
      await measure({
        shellRaw: third.shell,
        policyRaw: nullPolicy,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: { id: "s1" },
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(third.calls.length, 0);
  });

  it("策略服务形状不符且有沙箱 ⇒ 盲问", async () => {
    const { shell, calls } = sandboxingShell();
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: { resolve: 1 },
        command: STATUS_COMMAND,
        cwd: "/w",
        session: { id: "s1" },
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(calls.length, 0);
  });

  it("策略解析结果没有 mode ⇒ 盲问，不给执行器一个空壳", async () => {
    // `typeof === "object"` 这一层挡不住数组、Promise 与 `{}`。执行器拿到不带 mode 的策略时
    // 是按**部署默认**跑的 —— 那可能比会话当前档位宽松，甚至就是 `danger-full-access`。
    // 于是"我带上策略了"变成一句空话：命令照跑，沙箱退了一档。
    const resolvedCases = [{}, [], Promise.resolve({ mode: WS_MODE }), { mode: 1 }];
    const outcomes = await Promise.all(
      resolvedCases.map(async (resolved) => {
        const { shell, calls } = sandboxingShell();
        const verdict = await measure({
          shellRaw: shell,
          policyRaw: { resolve: () => resolved },
          command: STATUS_COMMAND,
          cwd: "/w",
          session: { id: "s1" },
          signal: signalOf(),
        });
        return { spawned: calls.length, verdict };
      }),
    );
    for (const { spawned, verdict } of outcomes) {
      assert.equal(verdict, undefined);
      assert.equal(spawned, 0, "没有 mode 就不该起子进程");
    }
  });

  it("`sandboxMode` 读取本身抛错 ⇒ 盲问，不让异常逃出", async () => {
    const { shell, calls } = fakeShell(" M a.ts");
    const throwingShell = {
      ...shell,
      get sandboxMode(): unknown {
        throw new Error("boom");
      },
    };
    assert.equal(
      await measure({
        shellRaw: throwingShell,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: "/w",
        session: undefined,
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(calls.length, 0);
  });

  it("会话目录缺席 ⇒ 盲问（不替执行器猜目录）", async () => {
    const { shell, calls } = fakeShell(" M a.ts");
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: undefined,
        session: undefined,
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(calls.length, 0);
  });

  it("原命令带仓库覆盖选项 ⇒ 盲问（不拿会话 cwd 的仓冒充目标）", async () => {
    const { shell, calls } = fakeShell(" M a.ts");
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        sourceCommand: "git -C sub reset --hard",
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(calls.length, 0);
  });

  it("信号已取消 ⇒ 一枚子进程都不起", async () => {
    const { shell, calls } = fakeShell(" M a.ts");
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: controller.signal,
      }),
      undefined,
    );
    assert.equal(calls.length, 0);
  });

  it("`resolve` 期间取消 ⇒ 不启动执行器", async () => {
    const { shell, calls } = fakeShell(" M a.ts");
    const controller = new AbortController();
    const resolve = shell["resolve"] as (request: Record<string, unknown>) => unknown;
    shell["resolve"] = (request: Record<string, unknown>) => {
      controller.abort();
      return resolve(request);
    };
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: controller.signal,
      }),
      undefined,
    );
    assert.equal(calls.length, 0);
  });

  it("`execute` 期间取消 ⇒ 不再等待、也不采纳输出", async () => {
    const controller = new AbortController();
    const shell = {
      resolve: (request: Record<string, unknown>) => request,
      execute: () => {
        controller.abort();
        return Promise.resolve({
          result: () =>
            Promise.resolve({ exitCode: 0, stdout: { text: "late", truncated: false } }),
        });
      },
    };
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: controller.signal,
      }),
      undefined,
    );
  });

  it("`result()` 永不结算时，取消信号一到就结束等待", async () => {
    const shell = {
      resolve: (request: Record<string, unknown>) => request,
      execute: () =>
        Promise.resolve({
          result: () =>
            // oxlint-disable-next-line promise/avoid-new -- 测的是"永不结算"
            new Promise<void>(() => {
              // 永不结算；由取消信号结束等待。
            }),
        }),
    };
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: AbortSignal.timeout(20),
      }),
      undefined,
    );
  });

  it("执行器缺席 / 形状不符 ⇒ 盲问（不静默换一条命令，也不抛）", async () => {
    const readings = await Promise.all(
      [undefined, {}, { resolve: 1 }, { resolve: () => ({}), execute: 1 }].map((shellRaw) =>
        measure({
          shellRaw,
          policyRaw: undefined,
          command: STATUS_COMMAND,
          cwd: FIXTURE_CWD,
          session: undefined,
          signal: signalOf(),
        }),
      ),
    );
    assert.deepEqual(readings, [undefined, undefined, undefined, undefined]);
  });

  it("这一族没有预演命令 ⇒ 不跑（盲问）", async () => {
    const { shell, calls } = fakeShell("x");
    assert.equal(
      await measure({
        shellRaw: shell,
        policyRaw: undefined,
        command: undefined,
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: signalOf(),
      }),
      undefined,
    );
    assert.equal(calls.length, 0, "没有命令就一枚子进程都不该起");
  });

  it("非零退出 / 超时 / 取消 / 宿主截断 ⇒ 一律不采纳", async () => {
    const rejected = await Promise.all(
      [
        { exitCode: 128, timedOut: false, aborted: false, stdout: { text: "fatal" } },
        { exitCode: 0, timedOut: true, aborted: false, stdout: { text: "x" } },
        { exitCode: 0, timedOut: false, aborted: true, stdout: { text: "x" } },
        {
          exitCode: 0,
          timedOut: false,
          aborted: false,
          stdout: { text: "x", truncated: true },
        },
      ].map((result) =>
        measure({
          shellRaw: shellOfResult(result),
          policyRaw: undefined,
          command: STATUS_COMMAND,
          cwd: FIXTURE_CWD,
          session: undefined,
          signal: signalOf(),
        }),
      ),
    );
    assert.deepEqual(rejected, [undefined, undefined, undefined, undefined]);
  });

  it("交回的形状不符（没有 result / 没有 stdout / 输出非字符串）⇒ 盲问，不抛", async () => {
    const badHandles: unknown[] = [
      {},
      { result: 1 },
      { result: () => Promise.resolve({}) },
      { result: () => Promise.resolve({ exitCode: 0, stdout: 1 }) },
      { result: () => Promise.resolve({ exitCode: 0, stdout: { text: 1 } }) },
      { result: () => Promise.resolve(undefined) },
    ];
    const badReadings = await Promise.all(
      badHandles.map((handle) =>
        measure({
          shellRaw: {
            resolve: (request: Record<string, unknown>) => request,
            execute: () => Promise.resolve(handle),
          },
          policyRaw: undefined,
          command: STATUS_COMMAND,
          cwd: FIXTURE_CWD,
          session: undefined,
          signal: signalOf(),
        }),
      ),
    );
    assert.equal(badReadings.filter((item) => item !== undefined).length, 0);
  });

  it("`resolve` 或 `execute` 抛错 / 拒绝 ⇒ 盲问（预演失败不是告警）", async () => {
    const throwing = {
      resolve: () => {
        throw new Error("no executor");
      },
      execute: () => Promise.reject(new Error("spawn failed")),
    };
    assert.equal(
      await measure({
        shellRaw: throwing,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: signalOf(),
      }),
      undefined,
    );

    const rejecting = {
      resolve: (request: Record<string, unknown>) => request,
      execute: () => Promise.reject(new Error("spawn failed")),
    };
    assert.equal(
      await measure({
        shellRaw: rejecting,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: signalOf(),
      }),
      undefined,
    );

    const throwingResult = {
      resolve: (request: Record<string, unknown>) => request,
      execute: () =>
        Promise.resolve({
          result: () => {
            throw new Error("result failed");
          },
        }),
    };
    assert.equal(
      await measure({
        shellRaw: throwingResult,
        policyRaw: undefined,
        command: STATUS_COMMAND,
        cwd: FIXTURE_CWD,
        session: undefined,
        signal: signalOf(),
      }),
      undefined,
    );
  });
});
