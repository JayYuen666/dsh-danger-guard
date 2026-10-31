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
import path from "node:path";

import { asOsPath } from "../lib/path-format.ts";
import {
  sandboxCoveredFacts,
  sandboxDropsOf,
  sandboxModeOf,
  sandboxScopeOf,
} from "../lib/sandbox-scope.ts";
import type { Canonicalize, SandboxScope } from "../lib/sandbox-scope.ts";
import type { PolicyFacts } from "../lib/mode-policy.ts";
import { disasterTargetPathOf } from "../lib/danger-rules.ts";

/** 「工作区内修改」档的沙箱模式名（多处复用）。 */
const WS_MODE = "workspace-write" as const;

/** 以给定目录为唯一可写根的沙箱管辖面（多处复用）。 */
const scopeWith = (root: string): SandboxScope => ({ mode: WS_MODE, roots: [asOsPath(root)] });

/** 一台"规范化即原样"的折法（多数用例不需要软链语义，给恒等函数让断言看得清）。 */
const identity = (absolute: string): string => absolute;

/** 宿主实现抛错的替身（`resolve` 与 `canonicalize` 两处注入共用）。 */
const hostFailure = (): never => {
  throw new Error("host implementation failed");
};

/** 判据的主角 mode（收常量：它在本文件里出现十几次，sonarjs 的 no-duplicate-string 盯着）。 */
const WS_ROOT = "/ws";
const FULL_ACCESS_MODE = "danger-full-access";
const UNKNOWN_MODE = "something-new";
const WRITABLE_MODE = `workspace-write`;
/** 常驻夹具：工作区根与临时区（这两枚字面量在本文件里各出现多次）。 */
const WORKSPACE = path.resolve(path.parse(process.cwd()).root, "w", "proj");
const TEMP_ROOT = "/tmp";
/** 含根与工作区的 brace 目标（多处复用的 opaque 夹具）。 */
const BRACE_ROOT_TARGET = "{/workspace,/etc}";

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
    assert.equal(scopeOf(FULL_ACCESS_MODE), undefined);
  });

  it("mode 是没见过的字符串 ⇒ 不留 scope（保守：宁可不放行）", () => {
    assert.equal(scopeOf(UNKNOWN_MODE), undefined);
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

  it("`read-only` 与 `workspace-write` 都留 scope，且可写根含工作区根与临时区", () => {
    const writable = scopeOf(WRITABLE_MODE);
    assert.equal(writable?.mode, WS_MODE);
    assert.deepEqual(writable.roots, [WORKSPACE, TEMP_ROOT]);
    // read-only 也留 scope：它的「覆盖」判定走另一支（一切写都被禁），但仍要带上
    // 同一份根表，否则后续把 mode 换成 workspace-write 时根会凭空少一枚。
    const readOnly = scopeOf("read-only");
    assert.equal(readOnly?.mode, "read-only");
    assert.deepEqual(readOnly.roots, [WORKSPACE, TEMP_ROOT]);
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
    assert.equal(
      sandboxDropsOf(scope, [asOsPath(WORKSPACE), asOsPath("/"), asOsPath("/Users/x")]),
      true,
    );
  });

  it("`workspace-write`：不包住任何可写根 ⇒ 让路", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    assert.equal(
      sandboxDropsOf(scope, [asOsPath("/etc/nginx"), asOsPath("/Users/x/Downloads")]),
      true,
    );
  });

  it("`workspace-write`：**包住可写根** ⇒ 不让路（沙箱拦不住工作区那部分）", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    // `/` 与 `/w` 是 `/w/proj` 的祖先；`/w/proj` 是它本身；`/tmp` 是另一枚可写根。
    for (const target of ["/", "/w", WORKSPACE, TEMP_ROOT]) {
      assert.equal(
        sandboxDropsOf(scope, [asOsPath(target)]),
        false,
        `${target} 包着可写根，必须不让路`,
      );
    }
    // 反向对照：`/Users` 与这棵树无关，让路。
    assert.equal(sandboxDropsOf(scope, [asOsPath("/Users")]), true);
  });

  it("根目录那一支单独钉住：`/` 必须被判成『包住一切』", () => {
    // 踩过的坑：`"${candidate}/"` 对 `candidate = "/"` 拼出 `"//"`，`startsWith` 恒假，
    // 于是 `rm -rf /` 会被判成"包不住可写根"而**让路一次全盘删除**。
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    assert.equal(sandboxDropsOf(scope, [asOsPath("/")]), false);
  });

  it("多目标里**只要有一枚**包住可写根 ⇒ 整条不让路", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    assert.equal(sandboxDropsOf(scope, [asOsPath("/etc/foo"), asOsPath(WORKSPACE)]), false);
  });

  it("归一不出来的目标（`undefined`）⇒ 整条不让路", () => {
    const scope = scopeOf(WRITABLE_MODE);
    assert.ok(scope !== undefined);
    assert.equal(sandboxDropsOf(scope, [undefined]), false);
    assert.equal(sandboxDropsOf(scope, [asOsPath("/etc/foo"), undefined]), false);
  });

  it("规范化把 `/tmp/x` 折成 `/private/tmp/x` 时，`rm -rf /private` 的判定跟着规范形走", () => {
    // 折法参与之后，`/private` 是否包住临时区由**规范形**说了算 —— 逐字比较会误判。
    const scope = scopeOf(WRITABLE_MODE, "/tmp/x", privatePrefixed);
    assert.ok(scope !== undefined);
    assert.deepEqual(scope.roots, ["/private/tmp/x", "/private/tmp"]);
    assert.equal(
      sandboxDropsOf(scope, [asOsPath("/private")]),
      false,
      "包住规范形下的临时区 ⇒ 不让路",
    );
    assert.equal(sandboxDropsOf(scope, [asOsPath("/etc")]), true);
  });
});

describe("注入 pathApi：同一份判据按 Windows 规则验证（不伪装运行环境）", () => {
  // 这是**跨平台判据的验法**：把路径实现当参数传进来，而不是去 mock `node:path`。
  // mock 会让"`\\` 是不是分隔符"这类前提混进被测逻辑；注入则把前提交给 `path.win32` 说话。
  const bs = String.fromCodePoint(92);
  const winRoot = `C:${bs}w${bs}proj`;

  it("windows 规则：盘根与父目录「包住可写根」⇒ 不让路", () => {
    const scope = { mode: WS_MODE, roots: [asOsPath(winRoot)] };
    for (const target of [`C:${bs}`, `C:${bs}w`, winRoot]) {
      assert.equal(
        sandboxDropsOf(scope, [asOsPath(target)], path.win32),
        false,
        `${target} 包着可写根，必须不让路`,
      );
    }
  });

  it("windows 规则：可写根内的子路径 ⇒ 不让路；够不着的地方 ⇒ 让路", () => {
    const scope = { mode: WS_MODE, roots: [asOsPath(winRoot)] };
    // 根内子路径**可写**：沙箱不会拦下这条删除，所以不能让它替我们兜底。
    assert.equal(
      sandboxDropsOf(scope, [asOsPath(`${winRoot}${bs}build`)], path.win32),
      false,
      "可写根内的子路径必须不让路",
    );
    assert.equal(
      sandboxDropsOf(scope, [asOsPath(`C:${bs}elsewhere`)], path.win32),
      true,
      "够不着可写根 ⇒ 让路",
    );
  });

  it("windows 规则：额外可写根与工作区根同时在场 ⇒ 两者之下都不让路", () => {
    const extraRoot = `D:${bs}granted`;
    const scope = { mode: WS_MODE, roots: [asOsPath(winRoot), asOsPath(extraRoot)] };
    assert.equal(
      sandboxDropsOf(scope, [asOsPath(`${extraRoot}${bs}deep`)], path.win32),
      false,
      "额外根之下的删除会真实执行完",
    );
    assert.equal(sandboxDropsOf(scope, [asOsPath(`D:${bs}`)], path.win32), false, "盘根包住额外根");
    assert.equal(
      sandboxDropsOf(scope, [asOsPath(`${winRoot}${bs}build`)], path.win32),
      false,
      "工作区根一侧照旧",
    );
    assert.equal(sandboxDropsOf(scope, [asOsPath(`E:${bs}elsewhere`)], path.win32), true, "让路");
  });

  it("两种规则对同一棵树给出一致的结论（避免「只在 Windows 上错」）", () => {
    // ⚠ 这里**必须**用 `path.posix` 自己拼 posix 形态的串，不能拿"平台根"去拼。
    // 我第一版写的是 `path.resolve(process.cwd().root, "w", "proj")` —— 在 Windows 上它
    // 产出 `D:\\w\\proj`，再交给 `path.posix` 判，两个世界又混起来了（CI 就是这么红的）。
    // 教训：**方言由 pathApi 决定，测试输入必须与它同方言**，不能"按平台构造"。
    const posixRoot = path.posix.join("/w", "proj");
    const posixScope = { mode: WS_MODE, roots: [asOsPath(posixRoot)] };
    const parentDir = asOsPath(path.posix.dirname(posixRoot));
    const insideDir = asOsPath(path.posix.join(posixRoot, "build"));
    // 两个方向都「包着可写的东西」：祖先包住整棵根，子路径本身就在根里可写。
    assert.equal(sandboxDropsOf(posixScope, [parentDir], path.posix), false, "祖先包住可写根");
    assert.equal(sandboxDropsOf(posixScope, [insideDir], path.posix), false, "子路径落在可写根里");
    // 同形状的 Windows 方言再走一遍：判据由 pathApi 决定，两个方言的结论必须一致，
    // 否则「只在 Windows 上错」这类回归在这条用例里仍然看不见。
    const windowsRoot = path.win32.join(String.raw`C:\w`, "proj");
    const winScope = { mode: WS_MODE, roots: [asOsPath(windowsRoot)] };
    const windowsParent = asOsPath(path.win32.dirname(windowsRoot));
    const windowsInside = asOsPath(path.win32.join(windowsRoot, "build"));
    assert.equal(
      sandboxDropsOf(winScope, [windowsParent], path.win32),
      false,
      "Windows 方言：祖先包住可写根",
    );
    assert.equal(
      sandboxDropsOf(winScope, [windowsInside], path.win32),
      false,
      "Windows 方言：子路径落在可写根里",
    );
  });
});

describe("包含性判据的组件边界：`..` 只是名字前缀时不算上跳", () => {
  // 判据的失效方向是**放行**（"沙箱盖不住"为真 ⇒ 灾难删除让路给同样管不了它的沙箱），
  // 所以边界必须逐个钉住。这一组正是"只判 `startsWith('..')`"会误判的那一形。
  // ⚠ 这两条用 `path.posix` 判，所以**输入也必须用 `path.posix` 拼**。
  // 第一版我写的是 `path.resolve(process.cwd().root, …)` —— 那是"按宿主平台拼、再按 POSIX 判"，
  // 在 Windows 上 `path.resolve` 给出 `D:\w\proj`，`path.posix` 把它当文件名，判据自然错。
  // 教训：方言由判据那侧的 `pathApi` 决定，夹具必须同方言（CI 就是这么红的）。
  it("根内名为 `..cache` 的目录 ⇒ 在根内（不让路：它可写）", () => {
    const root = path.posix.join("/w", "proj");
    const tricky = asOsPath(path.posix.join(root, "..cache"));
    // 判据要的是"这枚目标底下有没有可写的东西"：`..cache` 本身就在可写根里。
    // 若把 `..cache` 误当成上跳（只判 `startsWith("..")` 就会），两个方向都不成立，
    // 结论会翻成"沙箱盖得住" ⇒ 放行一次真实删除。
    assert.equal(sandboxDropsOf(scopeWith(root), [tricky], path.posix), false);
    // 再深一层同样在根内。
    const deeper = asOsPath(path.posix.join(root, "..cache", "x"));
    assert.equal(sandboxDropsOf(scopeWith(root), [deeper], path.posix), false);
  });

  it("真正的上跳（`..` 单独一段）⇒ 在根外（不让路）", () => {
    const root = path.posix.join("/w", "proj");
    const parent = asOsPath(path.posix.dirname(root));
    assert.equal(sandboxDropsOf(scopeWith(root), [parent], path.posix), false);
  });

  it("windows 规则下同样成立（`..cache` 在根内）", () => {
    const bs = String.fromCodePoint(92);
    const winRoot = `C:${bs}w${bs}proj`;
    const tricky = asOsPath(`${winRoot}${bs}..cache`);
    assert.equal(sandboxDropsOf(scopeWith(winRoot), [tricky], path.win32), false);
    // 对照：真的上跳到 `C:\w` ⇒ 包住可写根 ⇒ 不让路。
    assert.equal(sandboxDropsOf(scopeWith(winRoot), [asOsPath(`C:${bs}w`)], path.win32), false);
  });
});

describe("disasterTargetPathOf：灾难目标词面 → 绝对路径", () => {
  it("家目录三形（`~` / `~/…` / `$HOME`）各自落在同一棵树里", () => {
    const home = disasterTargetPathOf("~", undefined);
    assert.ok(home !== undefined, "家目录形必须归一得出来");
    // 判据是「归一成宿主上的绝对路径」，不是「以 `/` 开头」：Windows 的绝对形是 `C:\\…`。
    assert.ok(path.isAbsolute(home), `家目录归一形必须是绝对路径：${home}`);
    // 子路径按**平台**拼接（词面里的分隔符永远是 `/`，产出必须落到宿主的形状上）。
    const docs = path.join(home, "Documents");
    assert.equal(disasterTargetPathOf("~/Documents", undefined), docs);
    assert.equal(disasterTargetPathOf("$HOME", undefined), home);
    assert.equal(disasterTargetPathOf("$HOME/Documents", undefined), docs);
  });

  it("绝对路径原样（只做词法归一）", () => {
    assert.equal(disasterTargetPathOf("/etc", undefined), "/etc");
    assert.equal(disasterTargetPathOf("/etc/../usr", undefined), "/usr");
  });

  it("带盘符的 Windows 字形不归一（落点要过盘符表，本包明令不猜）", () => {
    // `path.posix.isAbsolute("C:/etc")` 是假 ⇒ 它掉不进绝对形分支；而反斜杠形态在 opaque 里。
    // 判据是"宁可交回 undefined 让调用方不让路"，不是猜一个看起来合理的落点。
    assert.equal(disasterTargetPathOf("C:/etc", undefined), undefined);
    // 生产链路一定带会话 cwd：盘符形的「不猜」不能只在 cwd 缺席时成立，否则
    // `path.resolve(cwd, "C:/etc")` 会编出一个看似合理的落点。
    assert.equal(disasterTargetPathOf("C:/etc", asOsPath("/w")), undefined);
    assert.equal(disasterTargetPathOf("//server/share", asOsPath("/w")), undefined);
  });

  it("相对形按会话 cwd 归一；cwd 缺席则**交回 undefined**（保守）", () => {
    assert.equal(disasterTargetPathOf(".", asOsPath(WORKSPACE)), WORKSPACE);
    assert.equal(
      disasterTargetPathOf("..", asOsPath(WORKSPACE)),
      path.dirname(WORKSPACE),
      "上跳一级按平台语义",
    );
    assert.equal(disasterTargetPathOf(".", undefined), undefined);
  });

  it("判不出来的一律 undefined：glob / 反斜杠 / `~user` / 变量默认值形", () => {
    // 这几类的落点要过展开、盘符表或口令表才知道，猜它们就是给"误放行"开口子。
    for (const word of [
      "/*",
      "/usr/**",
      BRACE_ROOT_TARGET,
      "/e?c",
      "/et[c]",
      "/tmp/$VAR",
      String.raw`C:\Windows`,
      String.raw`~\notes`,
      "~root/.ssh",
      `\${HOME:-/}`,
    ]) {
      assert.equal(disasterTargetPathOf(word, asOsPath("/w")), undefined, word);
    }
  });

  // 这两段词面里的 `${` 与 `$(` 是**被测数据**，不是模板占位：拆成两段再拼，
  // 免得静态检查把普通字符串里的 `${` 判成「占位不会插值」。
  const BRACE_VAR = ["$", "{X}"].join("");
  const CMD_SUBST = ["~", "/$", "(id)"].join("");

  it("家目录**子段**单独判不透明：`~/x` 可判，`~/$W` 判不出来", () => {
    // 前缀 `~/` / `$HOME/` 是合法写法，但子段里的 `$` 展开后落到哪棵树要过口令表才知道。
    // 判据是「子段这一侧」：只判整串会把前缀的 `~`/`$HOME` 也算可疑，于是 `~/Documents`
    // 这种最常见、完全可判的写法退成 undefined —— 那是误伤（判不出来 ⇒ 让路 ⇒ 不让路）。
    const home = disasterTargetPathOf("~", undefined);
    assert.ok(home !== undefined);
    assert.equal(disasterTargetPathOf("~/Documents", undefined), path.join(home, "Documents"));
    assert.equal(disasterTargetPathOf("$HOME/Documents", undefined), path.join(home, "Documents"));
    for (const word of ["~/$W", `$HOME/${BRACE_VAR}`, "~/$HOME", "~/`id`", CMD_SUBST]) {
      assert.equal(disasterTargetPathOf(word, asOsPath(WORKSPACE)), undefined, word);
    }
  });

  it("变量在**工作区内**展开时不许让路：`rm -rf ~/$W` 真删的是整个工作区", () => {
    // 修复前 `~/$W` 归一成「家目录 + 字面 `$W`」，那个字符串落在可写根之外 ⇒
    // `sandboxDropsOf` 判「沙箱会整体拦下」⇒ 守卫让路。而它真实展开后正是工作区本身。
    // 让路的前提是「沙箱会拦下这枚目标」，判不出落点的词面根本不该进那条推理。
    const target = disasterTargetPathOf("~/$W", asOsPath(WORKSPACE));
    assert.equal(target, undefined);
    assert.equal(sandboxDropsOf(scopeWith(WORKSPACE), [target]), false);
  });

  it("反引号与引号也判不出来：命令替换要先执行才知落点", () => {
    // 修复前它们不在不透明字符集里：`/tmp/\`id\`` 被当普通绝对路径归一（`path.posix.normalize`
    // 只折 `.`/`..`，不碰反引号）⇒ 判出一个看起来合法的落点，而真实落点由另一条命令决定。
    for (const word of ["`cmd`", "/tmp/`id -u`", '/tmp/x"', "/tmp/a\nb"]) {
      assert.equal(disasterTargetPathOf(word, asOsPath(WORKSPACE)), undefined, word);
    }
  });

  it("含根的 brace 展开式不让路：不会把 /workspace/{...} 当成 workspace 内路径", () => {
    const target = disasterTargetPathOf(BRACE_ROOT_TARGET, asOsPath(WORKSPACE));
    assert.equal(target, undefined);
    assert.equal(sandboxDropsOf(scopeWith(WORKSPACE), [target]), false);
  });
});

describe("sandboxScopeOf 的两道前提：执行器自报在拦 + 策略也说在拦", () => {
  it("执行器自报 danger-full-access ⇒ 不留 scope（哪怕策略说自己 read-only）", () => {
    // 让路的前提是"沙箱真会拦下这枚目标"。一个自报不拦文件效应的执行器，
    // 拿它配出来的策略当判据就等于凭一句自述放行整道闸门。
    assert.equal(
      sandboxScopeOf(
        { sandboxMode: FULL_ACCESS_MODE },
        { resolve: () => ({ mode: "read-only", workspaceRoot: WS_ROOT }) },
        undefined,
        identity,
        TEMP_ROOT,
      ),
      undefined,
    );
  });

  it("执行器自报的默认模式不认识 ⇒ 也不留 scope", () => {
    assert.equal(
      sandboxScopeOf(
        { sandboxMode: "future-mode" },
        { resolve: () => ({ mode: "read-only", workspaceRoot: WS_ROOT }) },
        undefined,
        identity,
        TEMP_ROOT,
      ),
      undefined,
    );
  });

  it("宿主实现抛错 ⇒ 按读不到处理，不留 scope（异常不穿进判定链）", () => {
    assert.equal(
      sandboxScopeOf(
        { sandboxMode: WRITABLE_MODE },
        { resolve: hostFailure },
        undefined,
        identity,
        TEMP_ROOT,
      ),
      undefined,
    );
    assert.equal(
      sandboxScopeOf(
        { sandboxMode: WRITABLE_MODE },
        { resolve: () => ({ mode: WS_MODE, workspaceRoot: WS_ROOT }) },
        undefined,
        hostFailure,
        TEMP_ROOT,
      ),
      undefined,
    );
  });
});

/** `/ws` 折成 `/real/ws`、其余原样成功。 */
function wsCanonicalizesToReal(absolute: string): string | undefined {
  return absolute === WS_ROOT ? "/real/ws" : absolute;
}

/** `/tmp` 折不出来，其余原样成功。 */
function tempFails(absolute: string): string | undefined {
  return absolute === TEMP_ROOT ? undefined : absolute;
}

describe("writableRootsOf：规范化失败的那一枚按 path.resolve 形保留，不丢", () => {
  it("规范化成功的用规范形，失败的那一枚退回 resolve 形（两侧同世界）", () => {
    // 丢掉这一枚的后果是反方向的：它底下的目标看起来"谁都没包住"⇒ 判成沙箱覆盖 ⇒
    // 我们让路，而那条删除其实落在可写根里、会真实执行完。所以宁可保留 resolve 形。
    const scope = sandboxScopeOf(
      { sandboxMode: WRITABLE_MODE },
      { resolve: () => ({ mode: WRITABLE_MODE, workspaceRoot: WS_ROOT }) },
      undefined,
      wsCanonicalizesToReal,
      TEMP_ROOT,
    );
    // `/ws` 折成 `/real/ws`；`/tmp` 与 TEMP_ROOT 同值、去重后只留一枚。桩对 `/tmp` 是
    // identity（原样成功），所以那一枚保持字面形——不写 path.resolve：它在 Windows 上
    // 会折成盘符形，断言就平台相关了。
    assert.deepEqual(scope?.roots, ["/real/ws", TEMP_ROOT]);
  });

  it("一枚可写根都折不出来 ⇒ 并不缺席，按 resolve 形进表", () => {
    // 缺席 scope 与"空根表"是两个方向相反的坑；这里两者都不踩。
    const scope = sandboxScopeOf(
      { sandboxMode: WRITABLE_MODE },
      { resolve: () => ({ mode: WRITABLE_MODE, workspaceRoot: WS_ROOT }) },
      undefined,
      tempFails,
      TEMP_ROOT,
    );
    // `/ws` 被 identity 桩原样成功（保持字面形）；TEMP_ROOT 折不出来退 resolve 形——
    // 这一枚才是本组的主角，期望按 path.resolve 现推，两侧在任何平台同世界。
    assert.deepEqual(scope?.roots, [WS_ROOT, path.resolve(TEMP_ROOT)]);
  });

  it("workspaceRoot 读不出（非字符串）⇒ 整份不留 scope，不拿临时区顶替工作区根", () => {
    // 只丢这一枚会让工作区里的目标显得"谁都没包住" ⇒ 判成沙箱完全覆盖 ⇒ 让路，
    // 而 `workspace-write` 恰恰允许真实删完工作区。`/tmp` 与临时区照常可算，
    // 但它们不覆盖工作区，不能替它背书。
    const scope = sandboxScopeOf(
      { sandboxMode: WRITABLE_MODE },
      { resolve: () => ({ mode: WRITABLE_MODE, workspaceRoot: 42 }) },
      undefined,
      identity,
      TEMP_ROOT,
    );
    assert.equal(scope, undefined);
  });
});

/** 额外可写根那一族的宿主面：工作区根 `/ws`，额外根由用例给。 */
function scopeWithAdditional(
  additionalWritableRoots: unknown,
  canonicalize: Canonicalize = identity,
): SandboxScope | undefined {
  return sandboxScopeOf(
    { sandboxMode: WRITABLE_MODE },
    {
      resolve: () => ({
        mode: WRITABLE_MODE,
        workspaceRoot: WS_ROOT,
        additionalWritableRoots,
      }),
    },
    undefined,
    canonicalize,
    TEMP_ROOT,
  );
}

/** 额外可写根那一族的字面量（每枚在本节里出现多次，收常量）。 */
const EXTRA_ROOT = "/extra/granted";
const EXTRA_FIRST = "/extra/a";
const EXTRA_SECOND = "/extra/b";
const EXTRA_UNRESOLVED = "/extra/gone";
const READ_ONLY_MODE = "read-only";

describe("additionalWritableRoots：显式授予的目录也是可写根", () => {
  it("旧宿主不给这一位 ⇒ 根表与只读工作区根时逐字相同", () => {
    // rc.3 / rc.4 的 SandboxExecutionPolicy 没有此字段，`resolve()` 自然交回 undefined。
    assert.deepEqual(scopeWithAdditional(undefined)?.roots, [WS_ROOT, TEMP_ROOT]);
  });

  it("额外根本身进表，排在工作区根之后、临时区之前", () => {
    assert.deepEqual(scopeWithAdditional([EXTRA_ROOT])?.roots, [WS_ROOT, EXTRA_ROOT, TEMP_ROOT]);
  });

  it("多枚与重复枚：重复只留一枚", () => {
    assert.deepEqual(
      scopeWithAdditional([EXTRA_FIRST, EXTRA_SECOND, EXTRA_FIRST, WS_ROOT])?.roots,
      [WS_ROOT, EXTRA_FIRST, EXTRA_SECOND, TEMP_ROOT],
    );
  });

  it("非字符串条目与数组之外的形状 ⇒ 整份不留 scope", () => {
    // 丢掉读不出的那一枚等于用不完整的根表推出"沙箱盖得住"，方向是放行。
    assert.equal(scopeWithAdditional([EXTRA_FIRST, 42, "", null]), undefined);
    assert.equal(scopeWithAdditional(EXTRA_FIRST), undefined);
    assert.equal(scopeWithAdditional(null), undefined);
  });

  it("空数组与缺席同义：没有额外 grant", () => {
    assert.deepEqual(scopeWithAdditional([])?.roots, [WS_ROOT, TEMP_ROOT]);
  });

  it("规范化失败的额外根按 path.resolve 形保留，不丢", () => {
    // 与工作区根同一条口径：丢掉这一枚会让它底下的目标看起来"谁都没包住"。
    const scope = scopeWithAdditional([EXTRA_UNRESOLVED], (absolute) =>
      absolute === EXTRA_UNRESOLVED ? undefined : absolute,
    );
    assert.deepEqual(scope?.roots, [WS_ROOT, path.resolve(EXTRA_UNRESOLVED), TEMP_ROOT]);
  });

  it("额外根之下与其祖先的目标都不算被沙箱完全覆盖", () => {
    const scope = scopeWithAdditional([EXTRA_ROOT]);
    assert.ok(scope !== undefined);
    // 目标就是额外根 ⇒ 目标自身可写。
    assert.equal(sandboxDropsOf(scope, [asOsPath(EXTRA_ROOT)]), false);
    // 目标在额外根之下 ⇒ 沙箱会真的执行完那段删除。
    assert.equal(sandboxDropsOf(scope, [asOsPath(`${EXTRA_ROOT}/deep`)]), false);
    // 目标包住额外根 ⇒ 白名单不提供原子性，边界内那部分先删光。
    assert.equal(sandboxDropsOf(scope, [asOsPath("/extra")]), false);
    // 与任何根都无关的目标照常让路。
    assert.equal(sandboxDropsOf(scope, [asOsPath("/etc/foo")]), true);
  });

  it("read-only 档不受额外根影响：一切写都被禁，仍判完全覆盖", () => {
    const scope = sandboxScopeOf(
      { sandboxMode: WRITABLE_MODE },
      {
        resolve: () => ({
          mode: READ_ONLY_MODE,
          workspaceRoot: WS_ROOT,
          additionalWritableRoots: [EXTRA_ROOT],
        }),
      },
      undefined,
      identity,
      TEMP_ROOT,
    );
    assert.ok(scope !== undefined);
    assert.equal(scope.mode, READ_ONLY_MODE);
    assert.equal(sandboxDropsOf(scope, [asOsPath(EXTRA_ROOT)]), true);
  });
});

describe("sandboxModeOf：原始模式读法（按档位分叉用的那一份）", () => {
  it("三种模式都原样读出（`danger-full-access` 也在内，这是它与让路判据的分工差别）", () => {
    for (const mode of ["read-only", WS_MODE, FULL_ACCESS_MODE]) {
      assert.equal(
        sandboxModeOf({ sandboxMode: mode }, { resolve: () => ({ mode }) }, undefined),
        mode,
      );
    }
  });

  it("执行器不沙箱 / 形状不符 ⇒ undefined（调用方按 unknown 处理）", () => {
    assert.equal(
      sandboxModeOf({}, { resolve: () => ({ mode: "read-only" }) }, undefined),
      undefined,
    );
    assert.equal(
      sandboxModeOf(undefined, { resolve: () => ({ mode: "read-only" }) }, undefined),
      undefined,
    );
    assert.equal(sandboxModeOf({ sandboxMode: "read-only" }, undefined, undefined), undefined);
    assert.equal(sandboxModeOf({ sandboxMode: "read-only" }, {}, undefined), undefined);
  });

  it("策略解析出来的不是对象 / 模式名不认识 ⇒ undefined", () => {
    assert.equal(
      sandboxModeOf({ sandboxMode: "read-only" }, { resolve: () => 1 }, undefined),
      undefined,
    );
    assert.equal(
      sandboxModeOf({ sandboxMode: "read-only" }, { resolve: () => null }, undefined),
      undefined,
    );
    assert.equal(
      sandboxModeOf(
        { sandboxMode: "read-only" },
        { resolve: () => ({ mode: "future-mode" }) },
        undefined,
      ),
      undefined,
    );
  });

  it("执行器自报 danger-full-access 时以自报为准，不返回策略侧的受限档位", () => {
    // 自报不拦文件效应 ⇒ 策略解析出的 read-only 不描述实际环境；与 sandboxScopeOf 同一条前提。
    assert.equal(
      sandboxModeOf(
        { sandboxMode: FULL_ACCESS_MODE },
        { resolve: () => ({ mode: "read-only" }) },
        undefined,
      ),
      FULL_ACCESS_MODE,
    );
  });

  it("策略 resolve 抛错 ⇒ undefined（异常不穿进同步判定链）", () => {
    assert.equal(
      sandboxModeOf(
        { sandboxMode: "read-only" },
        {
          resolve: (): never => {
            throw new Error("host implementation failed");
          },
        },
        undefined,
      ),
      undefined,
    );
  });

  it("会话缺席时 resolve 收到空对象（官方读法：没 agent 就 resolve({})）", () => {
    const seen: unknown[] = [];
    sandboxModeOf(
      { sandboxMode: "read-only" },
      {
        resolve: (request: unknown) => {
          seen.push(request);
          return { mode: "read-only" };
        },
      },
      undefined,
    );
    assert.deepEqual(seen, [{}]);
  });
});

describe("sandboxCoveredFacts：只给 rmrf 的灾难目标补覆盖位", () => {
  const facts: PolicyFacts = {
    mode: WS_MODE,
    askable: true,
    autoReview: false,
    sandboxCovers: false,
  };
  const scope = scopeWith(WORKSPACE);

  it("无 fix / fix 不是 disasterTarget ⇒ 原样交回同一份 facts", () => {
    assert.equal(sandboxCoveredFacts(facts, "rmrf", undefined, scope, undefined), facts);
    const bypass = { role: "bypassFlag", offending: ["--no-verify"] } as const;
    assert.equal(sandboxCoveredFacts(facts, "rmrf", bypass, scope, undefined), facts);
  });

  it("非 rmrf 键 ⇒ 即使 scope 在场也不补覆盖位", () => {
    assert.equal(sandboxCoveredFacts(facts, "gitForcePush", undefined, scope, undefined), facts);
  });

  it("可判的灾难目标全部落在可写根之外 ⇒ 补成 sandboxCovers: true", () => {
    const fix = { role: "disasterTarget", offending: ["/etc/foo"] } as const;
    assert.deepEqual(sandboxCoveredFacts(facts, "rmrf", fix, scope, undefined), {
      ...facts,
      sandboxCovers: true,
    });
  });

  it("空 offending 或词面全判不出来 ⇒ 原样交回（空数组不能让 every 恒真）", () => {
    const empty = { role: "disasterTarget", offending: [] } as const;
    assert.equal(sandboxCoveredFacts(facts, "rmrf", empty, scope, undefined), facts);
    const windows = { role: "disasterTarget", offending: [String.raw`C:\Windows`] } as const;
    assert.equal(sandboxCoveredFacts(facts, "rmrf", windows, scope, undefined), facts);
  });
});
