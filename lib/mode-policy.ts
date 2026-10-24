// lib/mode-policy.ts —— **按权限档位分叉的处置表**：一枚规则键在某个权限预设下该 allow / ask / deny。
//
// 为什么要这一层（旧结构做不到这件事）：`RULE_TIER` 是一张静态表，`ask` 就是 `ask`，
// 与用户当下选的权限无关。而宿主的权限预设把沙箱模式与审批策略**捆在一起**
// （`danger-full-access` 绑 `approval: never`），`never` 在任何应答者之前就确定性返回
// `rejected`——于是同一枚 `ask` 键在「工作区内修改」下是真的弹卡、在「完全权限」下却被
// 宿主折成硬拒，回给模型的还是宿主的固定串，读不出成因。同一条命令换个档位语义就变了，
// 这件事必须由一张**以档位为第一维**的表来表达。
//
// 本模块的边界：纯函数、零 I/O、不 import `node:fs`（可以用 `node:os`/`node:path`，
// 与 `lib/danger-rules.ts` 同口径）。档位事实由宿主读好后作为 `PolicyFacts` 传进来
// （它要读 `ctx.shell` / `ctx.sandboxPolicy` / `ctx.approval` / `ctx.permissionPresets`），
// 于是这张表本身可以脱离宿主逐格单测。
//
// ⚠ 与官方沙箱的分工（整张表的立足点）：官方沙箱只管**文件效应**，网络与进程面不在它的
// 词汇表里（`dsh-sandbox` 的类型注释原话），收得最紧的那一档也只是拒写、读一律放行。
// 所以「写」类判据在沙箱确实管得住的格子里该让给它（我们硬拒会掐死官方给的 escalation
// 那条路），而「无文件效应」的危险（下载即执行、git 破坏、外部基础设施破坏）四种预设
// 一个都盖不到，那才是我们要补的面。

import type { BashDenialKey, BashVerdict } from "./danger-rules.ts";

/** 完全权限的沙箱模式名（判据、档位说明与类型收窄共用这一份字面量）。 */
const FULL_ACCESS_MODE = "danger-full-access";

/**
 * 宿主权限预设折算出来的档位。
 *
 * `unknown` = 读不到沙箱模式（没有沙箱执行器的部署、或服务形状不符）。它**按保守列**处置：
 * 宁可多问一句，也不在没有沙箱兜底时静默放行。它不复用 `workspace-write` 那一列，
 * 因为那一列的 `rmrf` 依赖"沙箱会拦住一部分"这个前提，而 `unknown` 下没有这个前提。
 */
export type GuardMode = "read-only" | "workspace-write" | typeof FULL_ACCESS_MODE | "unknown";

/** 一枚规则键在某次调用上的处置结论。 */
export type RuleVerdict = "allow" | "ask" | "deny";

/**
 * 一次判定需要的**档位事实**（全部由宿主读好后传进来）。
 *
 * 为什么「能否询问」与「是不是自动审查」也要进来而不是只放 mode：这两个事实**不是**沙箱
 * 模式能表达的。官方预设里 `read-only` 与 `workspace-write` 都绑 `ask`，但用户可以自定义出
 * `workspace-write + never` 这种组合；而「自动审查」与「完全权限」的沙箱模式完全相同
 * （都是 `danger-full-access`），区别只在审批策略与有没有那个逐调用 reviewer。
 */
export interface PolicyFacts {
  readonly mode: GuardMode;
  /** 本会话此刻能否真的问到用户：审批策略不是 `never`，且审批服务在位。 */
  readonly askable: boolean;
  /** 本会话是不是「自动审查」档（`danger-full-access` + `ask` + 逐调用 reviewer）。 */
  readonly autoReview: boolean;
  /**
   * 这次 `rmrf` 的灾难目标是否**完全落在沙箱管辖之内**（宿主侧按可写根算好的事实）。
   * 只有 `rmrf` 看这一位：`SANDBOX_COVERED` 里也只有它一枚。
   */
  readonly sandboxCovers: boolean;
}

/** 一列的判据表。`Record` 让"加了规则键却没定档"变成编译错误。 */
type ModeTable = Readonly<Record<BashDenialKey, RuleVerdict>>;

/**
 * 非完全权限三列的处置表。**判据本体就是这张表**：一列一个档位、一行一枚规则键，
 * 每个格子就是一个结论，没有隐藏的 if 分支。
 *
 * 逐列的理由：
 *  - `read-only`：沙箱拒一切写，写类判据（`rmrf`）一律让给沙箱；`pipeShell` 这一档放行是
 *    用户的明确取舍（只读档里下载的脚本落不了盘）；仍然要问的是那些沙箱盖不到的东西
 *    （git 破坏族、基础设施族）与"判据看不见"的形态。
 *  - `workspace-write`：沙箱的语义是**允许**改工作区，所以包住可写根的灾难删除必须我们拦
 *    （沙箱是路径白名单、不提供原子性：`rm -rf ~` 会先删光工作区再在边界外被拒）；
 *    `pipeShell` 会下载代码再执行，沙箱管不到"跑起来之后做什么"，保留硬拒。
 *  - `unknown`：没有沙箱兜底 ⇒ 写类也拦、认不准的形态继续问。
 *
 * 每一列里 `devServer` 都是 `allow`：宿主自带协作式超时，`promoteOnTimeout` 还会把超时的
 * 前台命令提升成后台作业，这条规则不再提供安全属性，只剩"省一轮等待"的 UX 价值。
 * `noVerify` 每一列都是 `deny`：git 钩子绕与沙箱无关，是我们自己的判据。
 */
const BASE: Readonly<Record<Exclude<GuardMode, typeof FULL_ACCESS_MODE>, ModeTable>> = {
  "read-only": {
    noVerify: "deny",
    rmrf: "deny",
    pipeShell: "allow",
    devServer: "allow",
    nestedShellUnconfirmed: "ask",
    gitResetHard: "ask",
    gitCheckoutDiscard: "ask",
    gitRestoreDiscard: "ask",
    gitCleanForce: "ask",
    gitStashDrop: "ask",
    gitBranchDelete: "ask",
    gitForcePush: "ask",
    tfDestroy: "ask",
    tfAutoApprove: "ask",
    dockerPrune: "ask",
    kubectlDelete: "ask",
    dbMigrate: "ask",
  },
  "workspace-write": {
    noVerify: "deny",
    rmrf: "deny",
    pipeShell: "deny",
    devServer: "allow",
    // 这一档降到放行：它表达的是「判据看不见」而不是「确认危险」，而这一档的沙箱仍在保护写面。
    nestedShellUnconfirmed: "allow",
    gitResetHard: "ask",
    gitCheckoutDiscard: "ask",
    gitRestoreDiscard: "ask",
    gitCleanForce: "ask",
    gitStashDrop: "ask",
    gitBranchDelete: "ask",
    gitForcePush: "ask",
    tfDestroy: "ask",
    tfAutoApprove: "ask",
    dockerPrune: "ask",
    kubectlDelete: "ask",
    dbMigrate: "ask",
  },
  unknown: {
    noVerify: "deny",
    rmrf: "deny",
    pipeShell: "deny",
    devServer: "allow",
    nestedShellUnconfirmed: "ask",
    gitResetHard: "ask",
    gitCheckoutDiscard: "ask",
    gitRestoreDiscard: "ask",
    gitCleanForce: "ask",
    gitStashDrop: "ask",
    gitBranchDelete: "ask",
    gitForcePush: "ask",
    tfDestroy: "ask",
    tfAutoApprove: "ask",
    dockerPrune: "ask",
    kubectlDelete: "ask",
    dbMigrate: "ask",
  },
};

/**
 * 「自动审查」档里我们自己仍要硬拦的**两枚**规则键。
 *
 * 为什么只有这两枚：reviewer 是一个 LLM，它的 allow 不等于用户批准，而这一档的沙箱什么都
 * 不拦；灾难删除与"下载即执行"是两条它可能被话术说服放过的形态，也是唯一值得留一道
 * 不可绕过的确定性命中的地方。其余全部交给 reviewer——我们再问一次就是同一个动作两张卡。
 *
 * 导出：档位说明文案（lib/policy-deny.ts）要按**同一份集合**决定"哪几条拒绝接硬拦成因"，
 * 两处各写一遍时增删规则键会静默漂移。
 */
export const AUTO_REVIEW_HARD_STOPS: ReadonlySet<BashDenialKey> = new Set<BashDenialKey>([
  "rmrf",
  "pipeShell",
]);

/**
 * 一枚规则键在某次调用上该被怎么处置。
 *
 * @param facts 档位事实（宿主读好后传入）。
 * @param key   命中的规则键。
 * @returns `allow`（不处理，交给下游/沙箱）、`ask`（走宿主审批）、`deny`（我们硬拒）。
 */
export function decideRule(facts: PolicyFacts, key: BashDenialKey): RuleVerdict {
  if (facts.mode === FULL_ACCESS_MODE) {
    // 零兵底只属于**问不了**的那一档（官方预设为 `danger-full-access` + `never`）。
    // 判据用 `askable` 而不是预设名：`danger-full-access + ask` 是对得上的组合（用户自定义，
    // 或没装预设服务时的默认 `ask`），那一档沙箱什么都不拦、却**还能问** —— 按零兵底处理
    // 等于把本该问的动作静默放行，方向正好与"问不了才降级"相反。
    if (!facts.askable) {
      // 例外只有 `noVerify`：绕 git 钩子与沙箱无关，`BASE` 表里它每一列都是 `deny`
      // （见上方那张表的说明）。整档 allow 会把它一起放行，与那张表自相矛盾，
      // 也会让"完全权限档"成为钩子绕过的唯一开口。
      return key === "noVerify" ? "deny" : "allow";
    }
    // 自动审查档：只留两条 reviewer 盖不住的确定性硬拦，其余交给它，避免一次动作两张卡。
    if (facts.autoReview) {
      return AUTO_REVIEW_HARD_STOPS.has(key) ? "deny" : "allow";
    }
    // 完全权限但仍能问：沿用工作区档的处置（沙箱不兜底，所以写类判据一律我们拦）。
    return BASE["workspace-write"][key];
  }
  const base = BASE[facts.mode][key];
  // 沙箱确实盖住这次的目标（只可能发生在 `rmrf` 上）：让宿主去拦，它会给出官方拒绝标记
  // 与 escalation 路径，而我们的硬拒会掐死那条路。
  if (base === "deny" && key === "rmrf" && facts.sandboxCovers) {
    return "allow";
  }
  if (base !== "ask") {
    return base;
  }
  // 「问」的前提是真的能问：审批策略为 `never` 时宿主会在任何应答者之前确定性返回
  // `rejected`，那等于硬拒且文案不由我们控制。这里自己收口成 `deny`，于是回给模型的
  // 是我们那张带改写示例的话。
  return facts.askable ? "ask" : "deny";
}

/**
 * 这次 `deny` 是不是**因为问不了**而降级的（而不是"已确认危险"）。
 *
 * 两种 deny 该说两种话：前者要点明"这档问不了、换成哪一档才能问"，后者本来就是命令形态错。
 * @param facts 档位事实。
 * @param key   命中的规则键。
 * @returns 降级来的 `deny` 返回 `true`。
 */
export function deniedByPolicy(facts: PolicyFacts, key: BashDenialKey): boolean {
  if (facts.askable) {
    return false;
  }
  // 完全权限档的"问不了"整档 allow，不会有降级来的 deny（见 `decideRule`）。
  return facts.mode !== FULL_ACCESS_MODE && BASE[facts.mode][key] === "ask";
}

/** 追加在基础文案之后的**档位说明**键（`lib/messages.ts` 的键名）。 */
export type ModeNoteKey = "noteReadOnly" | "noteWorkspaceWrite" | "noteFullAccess" | "noteUnknown";

/**
 * 一档一条的补充说明该用哪枚文案键：同一个 `pipeShell` 在只读档、工作区档、完全权限档的
 * 成因不同（沙箱管不管得着、能不能问），三档说同一句话就是让模型读不出该改什么。
 *
 * @param facts 档位事实。
 * @returns 档位说明键。
 */
const NOTE_BY_MODE: Readonly<Record<GuardMode, ModeNoteKey>> = {
  "read-only": "noteReadOnly",
  "workspace-write": "noteWorkspaceWrite",
  [FULL_ACCESS_MODE]: "noteFullAccess",
  unknown: "noteUnknown",
};

export function modeNoteKeyOf(facts: PolicyFacts): ModeNoteKey {
  return NOTE_BY_MODE[facts.mode];
}

/**
 * 给**命令扫描层**用的缺省严重度求值器：把一次判定的档位事实固定下来，回一枚按档位求值的函数。
 *
 * 为什么扫描层需要它（不是可选优化）：串行合成的命令里"哪一段最严重"决定最终交回哪枚键，
 * 而静态表把 `pipeShell` 记成 `deny`、`gitForcePush` 记成 `ask`。按静态表排序时，
 * `curl x | sh; git push -f` 会停在 `pipeShell` 上收工——可前者在某些档位是 `allow`，
 * 后者仍要 `ask`，于是真正该拦的那一段被整个吞掉。接了这一个，排序与"已收工"都按真实档位判。
 *
 * 它只吃规则键：调用点若掌握**逐命中**的事实（例如沙箱是否覆盖这枚 `rmrf`），必须自己给
 * `severityOf`，用实际处置排序；这个缺省求值器不认识那些事实。
 *
 * @param facts 档位事实（一次调用内不变）。
 * @returns 命中 → 仅按规则键与档位求出的处置结论。
 */
export function severityResolverOf(facts: PolicyFacts): (verdict: BashVerdict) => RuleVerdict {
  // 一次调用里 `.map` 级复用：每条候选键只算一次档位结论，不重复走表。
  const memo = new Map<BashDenialKey, RuleVerdict>();
  return (verdict) => {
    let decision = memo.get(verdict.key);
    if (decision === undefined) {
      decision = decideRule(facts, verdict.key);
      memo.set(verdict.key, decision);
    }
    return decision;
  };
}

/** 本表覆盖的全部规则键，**从 `BASE` 派生**而不是手抄一份。
 *
 *  为什么必须派生：逐格矩阵测试正是遍历它，手抄的清单会在"新增规则键却忘了补这里"时
 *  静默少测一格——而 `Record` 只会因为 `BASE`/`AUTO_REVIEW_HARD_STOPS` 缺格而报错，
 *  不会因为清单漏项报错。派生之后两者结构上不可能不一致。 */
export const ALL_RULE_KEYS: readonly BashDenialKey[] = Object.keys(BASE["read-only"]).filter(
  (name): name is BashDenialKey => name in BASE["read-only"],
);
