// test/sandbox-scope.test.ts —— 宿主沙箱管辖面的判据：哪些灾难目标该让给宿主去拦。
//
// 这一支存在的理由（与 dsh 官方保护面对齐）：dsh 自带进程级沙箱（`ctx.shell.sandboxMode`
// 是执行器的自报、`ctx.sandboxPolicy.resolve()` 给出逐调用的 mode 与工作区根），而它的拒绝
// 会附带**官方认可的升级路径**（`sandbox_permissions` + `justification` → 用户审批）。
// 我们的硬拒跑在 bash 工具之前，会把那条路整个掐死 —— 所以"沙箱确实管得住的目标"要让路。
//
// ⚠ 本文件钉住的判据**不是**直觉上的"目标在可写根之外"，而是严格得多的
// **"目标包不住任何可写根"**：`workspace-write` 的语义是*允许*改工作区内的文件，
// 于是 `rm -rf ~`（工作区在 `~` 下）会先删光工作区内容、再在边界外被拒 ——
// 沙箱是路径白名单，**不提供原子性**。所以 `~`、`/`、`.` 一律不让路，
// 只有 `/etc/foo`、`~/Downloads` 这类"下面没有任何可写东西"的目标才让。
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { sandboxDropsOf, sandboxScopeOf } from "../lib/sandbox-scope.ts";
import type { SandboxScope } from "../lib/sandbox-scope.ts";
import { disasterTargetPathOf } from "../lib/danger-rules.ts";

/** 一台"规范化即原样"的折法（多数用例不需要软链语义，给恒等函数让断言看得清）。 */
const identity = (absolute: string): string => absolute;

/** 判据的主角 mode（收常量：它在本文件里出现十几次，sonarjs 的 no-duplicate-string 盯着）。 */
const WRITABLE_MODE = `workspace-write`;
/** 常驻夹具：工作区根与临时区（这两枚字面量在本文件里各出现多次）。 */
const WORKSPACE = "/w/proj";
const TEMP_ROOT = "/tmp";

/** 折成 `/private` 前缀的折法：模拟 darwin 上 `/tmp` → `/private/tmp`。 */
const privatePrefixed = (absolute: string): string =>
  absolute.startsWith("/private") ? absolute : `/private${absolute}`;

/** 一个"执行器自报在拦 + 策略解析出给定 mode/工作区根"的宿主面。 */
function scopeOf(
  mode: string,
  workspaceRoot: unknown = WORKSPACE,
  canonicalize = identity,
): SandboxScope | undefined {
  return sandboxScopeOf(
    { sandboxMode: WRITABLE_MODE },
    { resolve: () => ({ mode, workspaceRoot }) },
    undefined,
    canonicalize,
    TEMP_ROOT,
  );
}

describe("sandboxScopeOf：读宿主的两个能力面", () => {
  it("执行器自报不沙箱（`sandboxMode` 缺席）⇒ 不留 scope ⇒ 我们兜底", () => {
    assert.equal(
      sandboxScopeOf(
        {},
        { resolve: () => ({ mode: WRITABLE_MODE }) },
        undefined,
        identity,
        TEMP_ROOT,
      ),
      undefined,
    );
    assert.equal(
      sandboxScopeOf(
        { sandboxMode: undefined },
        { resolve: () => ({ mode: WRITABLE_MODE }) },
        undefined,
        identity,
        TEMP_ROOT,
      ),
      undefined,
    );
  });

  it("`ctx.sandboxPolicy` 缺席或形状不符 ⇒ 不留 scope", () => {
    assert.equal(
      sandboxScopeOf({ sandboxMode: WRITABLE_MODE }, undefined, undefined, identity, TEMP_ROOT),
      undefined,
    );
    assert.equal(
      sandboxScopeOf({ sandboxMode: WRITABLE_MODE }, {}, undefined, identity, TEMP_ROOT),
      undefined,
    );
    assert.equal(
      sandboxScopeOf(
        { sandboxMode: WRITABLE_MODE },
        { resolve: 1 },
        undefined,
        identity,
        TEMP_ROOT,
      ),
      undefined,
    );
  });

  it("`danger-full-access` 绕开限制 ⇒ 不留 scope（与我们已定的『保持硬拒』一致）", () => {
    assert.equal(scopeOf("danger-full-access"), undefined);
  });

  it("mode 是没见过的字符串 ⇒ 不留 scope（保守：宁可不放行）", () => {
    assert.equal(scopeOf("something-new"), undefined);
  });

  it("`resolve` 交回的形状不对 ⇒ 不留 scope", () => {
    assert.equal(
      sandboxScopeOf(
        { sandboxMode: WRITABLE_MODE },
        { resolve: () => 42 },
        undefined,
        identity,
        TEMP_ROOT,
      ),
      undefined,
    );
  });

  it("`read-only` 与 `workspace-write` 都留 scope，且可写根含工作区根与两枚临时区", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.equal(scope?.mode, "workspace-write");
    assert.deepEqual(scope.roots, [WORKSPACE, TEMP_ROOT]);
  });

  it("逐会话说：`session` 在场时原样交给 `resolve`（逐会话的 mode 覆盖归它解析）", () => {
    const seen: unknown[] = [];
    const session = { id: "s-1" };
    sandboxScopeOf(
      { sandboxMode: WRITABLE_MODE },
      {
        resolve: (request?: { session?: unknown }) => {
          seen.push(request);
          return { mode: "read-only", workspaceRoot: "/w" };
        },
      },
      session,
      identity,
      TEMP_ROOT,
    );
    assert.deepEqual(seen, [{ session }]);
  });

  it("会话缺席时按 `{}` 问（与官方 `tool-bash` 自己的读法同形）", () => {
    const seen: unknown[] = [];
    sandboxScopeOf(
      { sandboxMode: WRITABLE_MODE },
      {
        resolve: (request?: { session?: unknown }) => {
          seen.push(request);
          return { mode: "read-only" };
        },
      },
      undefined,
      identity,
      TEMP_ROOT,
    );
    assert.deepEqual(seen, [{}]);
  });
});

describe("sandboxDropsOf：『包不住可写根』才让路（核心安全判据）", () => {
  it("`read-only`：一切写都被禁 ⇒ 任何目标都被完全覆盖（不存在部分成功）", () => {
    const scope = scopeOf("read-only");
    assert.ok(scope !== undefined);
    // 连"包住工作区"的目标也让路 —— 因为这时工作区自己也写不了。
    assert.equal(sandboxDropsOf(scope, [WORKSPACE, "/", "/Users/x"]), true);
  });

  it("`workspace-write`：不包住任何可写根 ⇒ 让路", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    assert.equal(sandboxDropsOf(scope, ["/etc/nginx", "/Users/x/Downloads"]), true);
  });

  it("`workspace-write`：**包住可写根** ⇒ 不让路（沙箱拦不住工作区那部分）", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    // `/` 与 `/w` 是 `/w/proj` 的祖先；`/w/proj` 是它本身；`/tmp` 是另一枚可写根。
    for (const target of ["/", "/w", WORKSPACE, TEMP_ROOT]) {
      assert.equal(sandboxDropsOf(scope, [target]), false, `${target} 包着可写根，必须不让路`);
    }
    // 反向对照：`/Users` 与这棵树无关，让路。
    assert.equal(sandboxDropsOf(scope, ["/Users"]), true);
  });

  it("根目录那一支单独钉住：`/` 必须被判成『包住一切』", () => {
    // 踩过的坑：`"${candidate}/"` 对 `candidate = "/"` 拼出 `"//"`，`startsWith` 恒假，
    // 于是 `rm -rf /` 会被判成"包不住可写根"而**让路一次全盘删除**。
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    assert.equal(sandboxDropsOf(scope, ["/"]), false);
  });

  it("多目标里**只要有一枚**包住可写根 ⇒ 整条不让路", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    assert.equal(sandboxDropsOf(scope, ["/etc/foo", WORKSPACE]), false);
  });

  it("归一不出来的目标（`undefined`）⇒ 整条不让路", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    assert.equal(sandboxDropsOf(scope, [undefined]), false);
    assert.equal(sandboxDropsOf(scope, ["/etc/foo", undefined]), false);
  });

  it("规范化把 `/tmp/x` 折成 `/private/tmp/x` 时，`rm -rf /private` 的判定跟着规范形走", () => {
    // 折法参与之后，`/private` 是否包住临时区由**规范形**说了算 —— 逐字比较会误判。
    const scope = scopeOf(WRITABLE_MODE, "/tmp/x", privatePrefixed);
    assert.ok(scope !== undefined);
    assert.deepEqual(scope.roots, ["/private/tmp/x", "/private/tmp"]);
    assert.equal(sandboxDropsOf(scope, ["/private"]), false, "包住规范形下的临时区 ⇒ 不让路");
    assert.equal(sandboxDropsOf(scope, ["/etc"]), true);
  });
});

describe("disasterTargetPathOf：灾难目标词面 → 绝对路径", () => {
  it("家目录三形（`~` / `~/…` / `$HOME`）各自落在同一棵树里", () => {
    const home = disasterTargetPathOf("~", undefined);
    assert.ok(home !== undefined, "家目录形必须归一得出来");
    assert.ok(home.startsWith("/"));
    assert.equal(disasterTargetPathOf("~/Documents", undefined), `${home}/Documents`);
    assert.equal(disasterTargetPathOf("$HOME", undefined), home);
    assert.equal(disasterTargetPathOf("$HOME/Documents", undefined), `${home}/Documents`);
  });

  it("绝对路径原样（只做词法归一）", () => {
    assert.equal(disasterTargetPathOf("/etc", undefined), "/etc");
    assert.equal(disasterTargetPathOf("/etc/../usr", undefined), "/usr");
  });

  it("相对形按会话 cwd 归一；cwd 缺席则**交回 undefined**（保守）", () => {
    assert.equal(disasterTargetPathOf(".", WORKSPACE), WORKSPACE);
    assert.equal(disasterTargetPathOf("..", WORKSPACE), "/w");
    assert.equal(disasterTargetPathOf(".", undefined), undefined);
  });

  it("判不出来的一律 undefined：glob / 反斜杠 / `~user` / 变量默认值形", () => {
    // 这几类的落点要过展开、盘符表或口令表才知道，猜它们就是给"误放行"开口子。
    for (const word of [
      "/*",
      "/usr/**",
      String.raw`C:\Windows`,
      String.raw`~\notes`,
      "~root/.ssh",
      `\${HOME:-/}`,
    ]) {
      assert.equal(disasterTargetPathOf(word, "/w"), undefined, word);
    }
  });
});
