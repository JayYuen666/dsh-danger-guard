// test/ocr-fixes.test.ts —— OCR 核实轮（2026-10-30）里判为「属实」的每条修复的回归。
//
// 每个 describe 点名它对应哪一条评论编号，以及那条评论要的判据。这些用例的共同点：
// 修之前**必然红**（每条都先在本机跑出过修前的错误值），所以它们是判据而不是重复实现。
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "vitest";
import { strict as assert } from "node:assert/strict";

import { blastPreflightSkippedOf } from "../lib/blast-radius.ts";
import { askRequestOf } from "../lib/confirm.ts";
import { dockerDanger, kubectlDanger } from "../lib/container-rules.ts";
import { disasterTargetPathOf } from "../lib/disaster-target.ts";
import { declaredTargets } from "../lib/edit-targets.ts";
import { MESSAGES } from "../lib/messages.ts";
import type { PolicyFacts } from "../lib/mode-policy.ts";
import { UI_MESSAGES } from "../src/ui-messages.ts";
import { needsDecoratorLowering } from "../decorator-transform.mjs";

const ZH = MESSAGES.zh;
const WORKSPACE: PolicyFacts = {
  mode: "workspace-write",
  askable: true,
  autoReview: false,
  sandboxCovers: false,
};
const READ_ONLY: PolicyFacts = { ...WORKSPACE, mode: "read-only" };

describe("容器族：取值旗标后面的词不能被当成子命令（#69 / #71）", () => {
  it("kubectl 的 --as-group 取走 --dry-run=client 之后，delete 不是预演", () => {
    // 修前：kubectlDryRun 只看词面，把 --as-group 的取值当成了 kubectl 自己的预演旗标。
    assert.equal(
      kubectlDanger(["kubectl", "delete", "pod", "x", "--as-group", "--dry-run=client"]),
      "kubectlDelete",
    );
  });

  it("真的 --dry-run=client 仍是预演（不要为修上面一条把正常预演也判成删除）", () => {
    assert.equal(kubectlDanger(["kubectl", "delete", "pod", "x", "--dry-run=client"]), undefined);
  });

  it("docker 的 TLS 取值旗标不把取值当子命令（--tlscacert ca.pem system prune）", () => {
    // 修前 sub 读到的是 "ca.pem"，prune 整条漏判。
    assert.equal(
      dockerDanger(["docker", "--tlscacert", "ca.pem", "system", "prune"]),
      "dockerPrune",
    );
  });

  it("kubectl 的裸 --dry-run 取独立值：client/server 是预演，未知值仍算删除", () => {
    assert.equal(
      kubectlDanger(["kubectl", "delete", "pod", "x", "--dry-run", "client"]),
      undefined,
    );
    assert.equal(
      kubectlDanger(["kubectl", "delete", "pod", "x", "--dry-run", "server"]),
      undefined,
    );
    assert.equal(kubectlDanger(["kubectl", "delete", "pod", "x", "--dry-run"]), "kubectlDelete");
    assert.equal(
      kubectlDanger(["kubectl", "delete", "pod", "x", "--dry-run", "none"]),
      "kubectlDelete",
    );
  });

  it("kubectl 的日志与 --kuberc 取值不落进位置词", () => {
    // 修前 sub 读到的是 "/tmp/x"，delete 整条漏判。
    assert.equal(
      kubectlDanger(["kubectl", "--log-file", "/tmp/x", "delete", "pod", "foo"]),
      "kubectlDelete",
    );
    assert.equal(
      kubectlDanger(["kubectl", "--kuberc", "file.yaml", "delete", "pod", "foo"]),
      "kubectlDelete",
    );
  });

  it("docker buildx prune 与 builder prune 同判", () => {
    assert.equal(dockerDanger(["docker", "buildx", "prune"]), "dockerPrune");
    assert.equal(dockerDanger(["docker", "builder", "prune"]), "dockerPrune");
  });
});

describe("编辑载荷的键名拼法（#81 / #82）", () => {
  it("驼峰载荷键（newContent）在只读动词下也算写：目标清单不能为空", () => {
    // 修前白名单只认 snake_case / 少数驼峰变体，于是带写载荷的调用被当成纯读，
    // 目标清单为空 ⇒ 下游密钥闸连判都不判。
    assert.deepEqual(
      declaredTargets({ action: "read", file_path: ".ssh/id_rsa", newContent: "x" }),
      [".ssh/id_rsa"],
    );
  });

  it("对象载荷（patch: { hunks }）也算写", () => {
    assert.deepEqual(declaredTargets({ action: "read", path: "a.txt", patch: { hunks: [] } }), [
      "a.txt",
    ]);
  });

  it("负例：只读动词 + 无写载荷 ⇒ 目标清单仍为空", () => {
    assert.deepEqual(declaredTargets({ action: "read", path: "a.txt" }), []);
  });
});

describe("windows 形状的灾难目标不进 POSIX 路径世界（#57）", () => {
  it("盘符形与 UNC 形都不产出可被沙箱覆盖比较的绝对形", () => {
    // 修前 path.posix.isAbsolute("//server/share") 为真，会折成 POSIX 形交给
    // sandboxDropsOf，与 canonicalize 后的 Windows 根不是同一个路径世界 ⇒ 误判"盖得住"。
    assert.equal(disasterTargetPathOf(String.raw`C:\Windows`, undefined), undefined);
    assert.equal(disasterTargetPathOf(String.raw`\\server\share`, undefined), undefined);
  });

  it("普通绝对路径仍归一（别为了拦 Windows 形状把 POSIX 目标也丢了）", () => {
    assert.equal(disasterTargetPathOf("/etc/foo", undefined), "/etc/foo");
  });
});

describe("git clean 的预演清单会偏小时不量（#75）", () => {
  it("-x / -X（含与其他短旗标合写）都跳过预演", () => {
    for (const command of ["git clean -fdx", "git clean -fX", "git clean -x -d", "git clean -Xf"]) {
      assert.equal(blastPreflightSkippedOf("gitCleanForce", command), true, command);
    }
  });

  it("不带 ignored 位的命令仍量；其他规则键不受这条影响", () => {
    assert.equal(blastPreflightSkippedOf("gitCleanForce", "git clean -fd"), false);
    assert.equal(blastPreflightSkippedOf("gitResetHard", "git reset --hard -x"), false);
  });
});

describe("装饰器预转换的门槛只看程序正文（#50）", () => {
  it("注释里的 JSDoc @param 不触发预转换", () => {
    // 修前注释里的 @param 满足「@ 前是空白」，纯文档文件也白跑一次 tsc。
    assert.equal(
      needsDecoratorLowering("lib/a.ts", "/**\n * @param x - 参数\n */\nexport const a = 1;\n"),
      false,
    );
  });

  it("声明文件不触发（不产出 JS）", () => {
    assert.equal(
      needsDecoratorLowering("lib/a.d.ts", "export declare const a: number;\n@dec class X {}\n"),
      false,
    );
  });

  it("真实装饰器仍触发（收紧门槛不能把该转换的漏掉）", () => {
    assert.equal(needsDecoratorLowering("lib/a.ts", "class X { @dec m() {} }\n"), true);
  });
});

describe("档位说明只接在与这条规则有关时才出现（#66）", () => {
  it("workspace-write 下的 gitForcePush：reason 只有基础理由", () => {
    // 修前 confirm 的那两处文案无条件拼上档位说明，于是强推的审批理由里会多出
    // 一段讲「删除不具原子性」的话，把用户引到与本条无关的方面。
    const request = askRequestOf("bash", { command: "git push --force" }, undefined, WORKSPACE, ZH);
    assert.ok(request !== undefined);
    assert.equal(request.reason, ZH.gitForcePush);
    assert.equal(request.displayReason["zh"], ZH.gitForcePush);
  });

  it("read-only 下的 gitForcePush：reason 接上该档说明（这一档的说明对任何键都成立）", () => {
    const request = askRequestOf("bash", { command: "git push --force" }, undefined, READ_ONLY, ZH);
    assert.ok(request !== undefined);
    assert.equal(request.reason, `${ZH.gitForcePush}\n${ZH.noteReadOnly}`);
  });
});

/** DETAIL 文档里讲某个设置项的那一条项目符号。 */
const bulletOf = async (file: string, field: string): Promise<string> => {
  const doc = await readFile(path.join(import.meta.dirname, "..", file), "utf8");
  const line = doc.split("\n").find((row) => row.includes(`\`${field}\``));
  assert.ok(line !== undefined, `${file} 里没有讲 \`${field}\` 的那一条`);
  return line;
};

/** 从字段名起、到第一个分句结束符为止 —— 开启侧的语义只活在这一段里。 */
const onSideOf = (bullet: string, field: string): string =>
  bullet.slice(bullet.indexOf(`\`${field}\``)).split(/[;；]/u)[0]!;

/** 两份 DETAIL 的路径：同一个字面在三处判据里出现，写成常量再改就只有改一处。 */
const DETAIL_EN = "docs/DETAIL.md";
const DETAIL_ZH = "docs/DETAIL.zh.md";

describe("两份 DETAIL 里 `enabled` 的正反语义不许写反（#20）", () => {
  it("英文版：开启侧只说守卫生效，放行挂在关掉之后", async () => {
    // 实现面：host.ts 的 `if (rt.cfg.enabled)` 为真才进拦截链，`preflightSkipped` 里
    // `!cfg.enabled` 让整趟首次编辑探查也不参与。修前这句写的是 "(on) turns the whole
    // guard off, so every command passes"，读者照字面配置会把守卫关掉。
    const bullet = await bulletOf(DETAIL_EN, "enabled");
    assert.doesNotMatch(onSideOf(bullet, "enabled"), /off|pass/iu);
    assert.match(onSideOf(bullet, "enabled"), /active/iu);
    assert.match(bullet, /off[^.]*passes/iu);
  });

  it("中文版：同一条语义，放行写在「关掉」之后", async () => {
    const bullet = await bulletOf(DETAIL_ZH, "enabled");
    assert.match(onSideOf(bullet, "enabled"), /关掉.*放行/u);
  });
});

/** `maxDenies` 的四段文字面：两份 DETAIL 与卡片两语 hint。 */
const maxDeniesTexts = async (): Promise<string[]> => {
  const [en, zh] = await Promise.all([
    bulletOf(DETAIL_EN, "maxDenies"),
    bulletOf(DETAIL_ZH, "maxDenies"),
  ]);
  return [en, zh, UI_MESSAGES.zh.maxDeniesHint, UI_MESSAGES.en.maxDeniesHint];
};

describe("`maxDenies` 的口径：未收敛、超过上限、缺 read 不放行（#21）", () => {
  it("四处文字面都按 lib/fact-gate.ts 的决策写", async () => {
    // 实现面（decideAfterFirstDeny）：计数在缺项集合缩为真子集时重置为 1，其余情况 +1；
    // `denials > maxDenies` 才兑现配额，所以放行发生在第 maxDenies+1 次；而
    // `gaps.some(gap => gap.need === "read")` 时扣下配额照常拒绝。修前四处都写成
    // 「连续无证据拒绝 maxDenies 次后放行」，既错在触发次数，也错在把「未收敛」说成「零证据」。
    const texts = await maxDeniesTexts();
    for (const raw of texts) {
      const text = raw.replaceAll("`", "");
      assert.match(text, /未收敛|non-converging/iu);
      assert.doesNotMatch(text, /零证据|无证据|without any evidence|evidence-less/iu);
      assert.match(text, /超过|exceed/iu);
      assert.match(text, /仍有 read|读文件|read gap/iu);
      assert.match(text, /不放行|withheld/iu);
    }
  });

  it("英文标签不把配额绑在严格模式上", () => {
    // 配额在分档模式与 strictMode 下都兑现（`decideAfterFirstDeny` 不看 `strictMode`），
    // 修前那枚标签写作 "deadlock guard for strict mode"，读起来像只有开了严格模式才需要它。
    assert.doesNotMatch(UI_MESSAGES.en.maxDeniesLabel, /strict mode/iu);
    assert.match(UI_MESSAGES.en.maxDeniesLabel, /fact gate/iu);
    assert.equal(UI_MESSAGES.zh.maxDeniesLabel, "放行次数（强校验防死锁）");
  });
});

/** 取包含指定字样的小节标题（按 `## ` 分段）。 */
const sectionHeadingOf = async (file: string, needle: string): Promise<string> => {
  const doc = await readFile(path.join(import.meta.dirname, "..", file), "utf8");
  const section = doc.split(/^## /mu).find((part) => part.includes(needle));
  assert.ok(section !== undefined, `${file} 里没有含 \`${needle}\` 的小节`);
  return section.split("\n")[0]!;
};

describe("`preflightEnabled` 那一节的小节标题不许承诺重启（#23）", () => {
  it("两语标题都只说「卡上没有旋钮」", async () => {
    // 全 16 个字段都被标成 volatile（`test/host.test.ts` 钉住该集合），所以本包不存在
    // 需要重启的值；修前两语标题分别写着 "Restart-only and card-missing values" 与
    // 「要重启的，以及卡上没有的」，与同节正文「不需要重启」互相矛盾。
    const headings = await Promise.all([
      sectionHeadingOf(DETAIL_EN, "preflightEnabled"),
      sectionHeadingOf(DETAIL_ZH, "preflightEnabled"),
    ]);
    for (const heading of headings) {
      assert.doesNotMatch(heading, /restart|重启/iu);
      assert.match(heading, /knob|旋钮/u);
    }
  });
});

describe("changelog 的版本小节唯一且不倒退（#15）", () => {
  it("每个版本只出现一次，0.1.2 系列仍排在 0.1.1 之前", async () => {
    // 修前 0.1.2 / 0.1.2-rc / 0.1.1 各出现两份，第二份落在 0.1.1 之后，倒序被打断；
    // 读者无法判断哪一份权威，也无法确认合并时是否丢过条目。
    const text = await readFile(path.join(import.meta.dirname, "..", "CHANGELOG.md"), "utf8");
    const versions = Array.from(text.matchAll(/^## (?<version>\S+)$/gmu), (match) => {
      const version = match.groups?.["version"];
      assert.ok(version !== undefined);
      return version;
    });
    assert.deepEqual(versions, [...new Set(versions)], "版本小节重复");
    const at = (version: string): number => versions.indexOf(version);
    assert.ok(at("0.1.2") >= 0 && at("0.1.2") < at("0.1.2-rc"), "0.1.2 应排在 0.1.2-rc 之前");
    assert.ok(at("0.1.2-rc") < at("0.1.1"), "0.1.2-rc 应排在 0.1.1 之前");
  });
});
