// danger-guard client 半：设置卡（总开关 + 事实门开关/放行次数/严格模式/写面阈值/引用取证
// 检索工具名单 + 两份危险面词表）。
// 参照 session-rescue / ctx-observe / quality-gate 的卡片模式：keyed plugins.bundle.config
// 槽（key = bundle 包名 `@jayyuen66/dsh-danger-guard`，见 BUNDLE_PKG）+ 0.1.7 的
// ctx.configForms.get(条目 id) 表单（id = 设置条目 `danger-guard-settings`），React 由模块
// 系统提供（rolldown external），只用 createElement。

import { createElement, useEffect, useState } from "react";
import { z } from "zod";
import {
  CARD_UI_CSS,
  CardForm,
  ListField,
  NumberField,
  SaveBar,
  Section,
  ToggleField,
  splitHint,
} from "@jayyuen66/dsh-plugin-shared/lib/card-ui";
import type { ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { BuiltInLocaleId } from "@deepseek-ai/dsh-client-locale/client";
import type { LocaleDictOf } from "@deepseek-ai/dsh-client-ui-slots";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConfigForm, ConfigFormSnapshot } from "@deepseek-ai/dsh-client-ui-settings/client";
// 槽位契约的所有权在属主包：`plugins.bundle.config` 由 plugin-manager 通过
// `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap }` 交出
// （installed `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts:95-104`，
// 文件头明写「A registrant merges this contract with `import type` and registers through
// `ctx.slots`; it never imports this package at runtime」）。本包原先没有把那份 merge
// 载入 program，槽位名只是 `ClientCtx.slots` 手抄签名里的一枚 `string`——拼错 key 编译期
// 不红，而宿主按包名逐字相等匹配（见下面 BUNDLE_PKG 的证据链），症状是**整张卡不渲染**。
// 这里取 `ConfigPageForm` 是**一举两得**：既是把官方 merge 载入 program 的入口（TS 顺着
// `./client` 的再导出走到 slot-contract.ts），也是本卡渲染视模型两个状态位的真源
// （见下面 CardSnapshot）。lint 的 `require-module-specifiers` 禁空 import specifier，
// 正合本意——载入官方契约就该同时*用上*它。
import type { ConfigPageForm } from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import { diffTouched } from "@jayyuen66/dsh-plugin-shared/lib/card-diff";
import {
  DEFAULT_MAX_DENIES,
  DEFAULT_SMALL_EDIT_CHARS,
  DEFAULT_BIG_EDIT_CHARS,
} from "../lib/fact-gate.ts";
// 名单默认值与 host 的取证判据、指令文案兜底同源（lib/ref-search-policy.ts），卡片只是回退显示它。
import {
  DEFAULT_REF_SEARCH_STRICT_TOOLS,
  DEFAULT_REF_SEARCH_TOOLS,
} from "../lib/ref-search-policy.ts";
import { createStatsReader, topLines } from "./stats-reader.ts";
import type { StatsLine } from "./stats-reader.ts";
// 槽位键 = bundle 包名，单源在 src/bundle-pkg.ts（本包刻意有三个串：locale 命名空间 /
// settings 命名空间 / slot key；slot key 的派发证据链也随那份单源住在一起）。
import { BUNDLE_PKG } from "./bundle-pkg.ts";
// 形状从**叶子**模块取（见 src/stats-reader.ts 的说明：judge-stats 带 node:os/node:path）。
import type { StatsSnapshot } from "../lib/stats-shape.ts";
import { UI_MESSAGES } from "./ui-messages.ts";
import type { LocaleNs, Translate } from "./ui-messages.ts";

/** 官方 locale 的命名空间（本包字典的键）：与 slot key、settings 命名空间各自独立。
 *  它必须等于 src/ui-messages.ts 里 merge 进官方 `LocaleNamespaceMap` 的那枚键——
 *  两边分叉时下面 `LocaleCatalog` 的 `LocaleDictOf<typeof NS>` 在编译期就红（不在官方
 *  表里的串不满足该类型的 `N extends keyof LocaleNamespaceMap & string` 约束），不需要
 *  运行时比对。 */
const NS: LocaleNs = "danger-guard";
/**
 * 设置命名空间 == **持有 Config schema 的那个 profile 条目 id**。
 * 0.1.7 迁移的第一版这里写的是拦截条目 `danger-guard`——bulkhead 之后严格 schema 搬到了
 * 独立条目（settings-host.ts / cordis.patch.yml 的第二行），因为把用户可手改的严格
 * schema 挂在拦截条目上，等于一行越界配置就让危险命令闸门整体下线（apply 之前就 FAILED）。
 * 卡片写的是这一条，host 拦截半读的也是这一条（两侧靠 schema-coverage / host 测试对齐）。
 */
const SETTINGS_NS = "danger-guard-settings";
/**
 * `plugins.bundle.config` 的 key = **bundle 的 npm 包名**，单源在 src/bundle-pkg.ts
 * （本包刻意有三个串：locale 命名空间 / settings 命名空间 / slot key；slot key 的派发
 * 证据链也随那份单源住在一起）。
 */
/** 统计块保留自己的紧凑样式：它是只读领域内容，不是表单字段。颜色一律走主题令牌。 */
const STATS_CSS = [
  ".dgc-stats{padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}",
  ".dgc-row{display:flex;align-items:center;justify-content:space-between;gap:12px}",
  ".dgc-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
  ".dgc-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin-top:2px}",
].join("\n");

/** 错误色那一格：保存失败与统计读取失败共用（`sonarjs/no-duplicate-string` 盯着重复字面量）。 */
const ERROR_CLASS = "dgc-saveerr";

/**
 * 客户端配置面直接取官方声明：`@deepseek-ai/dsh-client-ui-settings/client` 交出的
 * `ConfigForm<T>` 与其快照 `ConfigFormSnapshot<T>`（installed
 * `lib/types/client/config-form-types.d.ts:6-74`：`getSnapshot:38` / `subscribe:44` /
 * `mutate:55` / `set:65` / `unset:73`，快照 `status:12` / `value:14` / `writable:29`）。
 * 原先这里手抄了一份 `getSnapshot: () => unknown`，快照字段全靠 `snapshotOf` 逐位再解析
 * 一遍——那个解析器只是丢失类型的补救，不是宿主契约（provider 侧已 decode/derive 过这层）。
 * ⚠ 入口仍是 `ctx.configForms.get(entryId)`（installed `.../client/config-form.d.ts:142`，
 * 服务本身由同文件 :94-98 的 `Context.configForms` 增强交出；`get()` 的入参就是命名空间
 * ——installed lib/client.js:1309-1313 把它原样交给
 * `new ConfigFormController(owner, { namespace: entryId }, …)`）。
 * 两处与旧 `settingsScope` 不同：
 *  - `set`/`unset` 多了**受理位**：`true` 宿主受理，`false` = 拒绝或写入被跳过，且
 *    **只有传输失败才 reject**（声明 installed `config-form-types.d.ts:62-64`、`:70-72`；
 *    实现 installed `lib/client.js:1183-1186` `!response.ok → false`、`:1213`
 *    memory/disposed 早退 `false`）。本卡维持 0.1.6 的行为：失败面只认 rejection，
 *    受理位 await 后即弃（见 apply 里的 payload 注释）——消费它要新增文案键与判定，
 *    属改行为而不是迁移（session-rescue / ctx-observe / quality-gate 同一条纪律）。
 *  - **没有 `dispose()`**：`get()` 交回的是 provider 自己持有的那张共享表单（installed
 *    `config-form.d.ts:138-142` "The entry's form, owned by this provider"），消费者无权
 *    销毁；provider 在自己的 fiber 上统一 dispose（installed lib/client.js:1289-1293）。 */
export type EntryForm = ConfigForm<Record<string, unknown>>;

/** 官方 `LocaleRuntime.register` 类型化重载的字典参数，取在本包命名空间上：
 * `Record<BuiltInLocaleId, LocaleDictOf<'danger-guard'>>`——两语（官方 `BuiltInLocaleId`）
 * 必须齐、每语的键集必须等于 `UiMessages`，都由官方表达式给出（少的键、多的键、缺一门
 * 语言都在编译期红）。 */
export type LocaleCatalog = Record<BuiltInLocaleId, LocaleDictOf<typeof NS>>;

/** 本卡自己的渲染视模型（官方 `ConfigFormSnapshot` 的有用子集 + 兜底值）。
 *  `status`/`writable` 两位不再手写联合：它们取自属主包交给配置页的那份官方状态
 *  （`ConfigPageForm['state']`，installed `dsh-client-ui-plugin-manager/lib/types/client/
 *  slot-contract.d.ts:150-155`，其类型就是官方 `ConfigFormSnapshot<Record<string, unknown>>`
 *  的再投影）。宿主把 status 的取值域或 writable 的必选性一改，这里当场红。
 *  两者都满足才允许写，故保持**必选**，不用可选位假装它们会缺；`value` 是本卡的兜底
 *  收窄（官方 `value: T | undefined` → 首个快照受理前落成空对象供渲染）。 */
interface CardSnapshot extends Pick<ConfigPageForm["state"], "status" | "writable"> {
  value: Record<string, unknown>;
}

/** 三个数值字段的 zod 形状：与 host schema 的 `natural().min/max` 同源；
 *  UI 那侧的 `max` 只是输入框的展示上限，不反过来约束 host 接受的值。 */
const MAX_DENIES_SCHEMA = z.int().min(1).max(5);
const SMALL_EDIT_CHARS_SCHEMA = z.int().min(1);
const BIG_EDIT_CHARS_SCHEMA = z.int().min(2);

/** zod 4.6 的 `.minValue`/`.maxValue` 是折叠后的边界；null 表示该方向没声明。 */
function boundsOf(schema: z.ZodNumber): { readonly min?: number; readonly max?: number } {
  const bounds: { min?: number; max?: number } = {};
  if (schema.minValue !== null) {
    bounds.min = schema.minValue;
  }
  if (schema.maxValue !== null) {
    bounds.max = schema.maxValue;
  }
  return bounds;
}

const MAX_DENIES_BOUNDS = boundsOf(MAX_DENIES_SCHEMA);

/** 数字字段的兜底显示：只有通过 zod 形状的值才交给输入框，其余展示 schema 默认值。 */
function numberValue(value: unknown, fallback: number, schema: z.ZodNumber): number {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/** 名单字段的取值：非数组按空表降级；refTools 两行另有内置默认名单兜底。 */
function listValue(value: unknown, fallback: readonly string[] = []): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : fallback;
}

/** 拦截小节：总开关 + 首次编辑事实门。 */
function buildBlockSection(props: SectionInputs): ReactNode {
  const { t, writable, eff, setField } = props;
  const disabled = !writable;
  const refTools = listValue(eff("refSearchTools"), DEFAULT_REF_SEARCH_TOOLS);
  const refToolsText = refTools.length > 0 ? refTools.join("/") : t("refToolsEmpty");
  const factGateHint = t("factGateHint", { tools: refToolsText });
  const enabled = createElement(ToggleField, {
    label: t("enabledLabel"),
    ...splitHint(t("enabledHint")),
    field: "enabled",
    checked: eff("enabled") !== false,
    disabled,
    onChange: (next: boolean): void => {
      setField("enabled", next);
    },
  });
  const factGate = createElement(ToggleField, {
    label: t("factGateLabel"),
    ...splitHint(factGateHint),
    field: "factGateEnabled",
    checked: eff("factGateEnabled") !== false,
    disabled,
    onChange: (next: boolean): void => {
      setField("factGateEnabled", next);
    },
  });
  return createElement(Section, { title: t("blockSection") }, enabled, factGate);
}

/** 判定与放行小节：统计开关、放行次数、严格模式。 */
function buildJudgeSection(props: SectionInputs): ReactNode {
  const { t, writable, eff, setField } = props;
  const disabled = !writable;
  const judgeStats = createElement(ToggleField, {
    label: t("statsLabel"),
    ...splitHint(t("statsHint")),
    field: "judgeStats",
    checked: eff("judgeStats") !== false,
    disabled,
    onChange: (next: boolean): void => {
      setField("judgeStats", next);
    },
  });
  const maxDenies = createElement(NumberField, {
    label: t("maxDeniesLabel"),
    ...splitHint(t("maxDeniesHint")),
    field: "maxDenies",
    value: numberValue(eff("maxDenies"), DEFAULT_MAX_DENIES, MAX_DENIES_SCHEMA),
    ...MAX_DENIES_BOUNDS,
    step: 1,
    unit: t("unitTimes"),
    invalidHint: t("outOfRange"),
    disabled,
    onChange: (next: number | undefined): void => {
      setField("maxDenies", next);
    },
  });
  const strict = createElement(ToggleField, {
    label: t("strictLabel"),
    ...splitHint(t("strictHint")),
    field: "strictMode",
    checked: eff("strictMode") === true,
    disabled,
    onChange: (next: boolean): void => {
      setField("strictMode", next);
    },
  });
  return createElement(Section, { title: t("judgeSection") }, judgeStats, maxDenies, strict);
}

/** 分级规则小节：两份写面阈值 + 六份名单/词表。 */
function buildRulesSection(props: SectionInputs): ReactNode {
  const { t, writable, eff, setField } = props;
  const disabled = !writable;
  const smallHint = t("smallHint", { chars: DEFAULT_SMALL_EDIT_CHARS });
  const bigHint = t("bigHint", { chars: DEFAULT_BIG_EDIT_CHARS });
  const refToolsHint = t("refToolsHint", { tools: DEFAULT_REF_SEARCH_TOOLS.join("/") });
  const listPlaceholder = t("listPlaceholder");
  const small = createElement(NumberField, {
    label: t("smallLabel"),
    ...splitHint(smallHint),
    field: "smallEditChars",
    value: numberValue(eff("smallEditChars"), DEFAULT_SMALL_EDIT_CHARS, SMALL_EDIT_CHARS_SCHEMA),
    ...(SMALL_EDIT_CHARS_SCHEMA.minValue === null ? {} : { min: SMALL_EDIT_CHARS_SCHEMA.minValue }),
    max: 2000,
    step: 1,
    unit: t("unitChars"),
    invalidHint: t("outOfRange"),
    disabled,
    onChange: (next: number | undefined): void => {
      setField("smallEditChars", next);
    },
  });
  const big = createElement(NumberField, {
    label: t("bigLabel"),
    ...splitHint(bigHint),
    field: "bigEditChars",
    value: numberValue(eff("bigEditChars"), DEFAULT_BIG_EDIT_CHARS, BIG_EDIT_CHARS_SCHEMA),
    ...(BIG_EDIT_CHARS_SCHEMA.minValue === null ? {} : { min: BIG_EDIT_CHARS_SCHEMA.minValue }),
    max: 100_000,
    step: 1,
    unit: t("unitChars"),
    invalidHint: t("outOfRange"),
    disabled,
    onChange: (next: number | undefined): void => {
      setField("bigEditChars", next);
    },
  });
  const refTools = createElement(ListField, {
    label: t("refToolsLabel"),
    ...splitHint(refToolsHint),
    field: "refSearchTools",
    value: listValue(eff("refSearchTools"), DEFAULT_REF_SEARCH_TOOLS),
    placeholder: listPlaceholder,
    disabled,
    onChange: (next: readonly string[]): void => {
      setField("refSearchTools", next);
    },
  });
  const refStrict = createElement(ListField, {
    label: t("refStrictLabel"),
    ...splitHint(t("refStrictHint")),
    field: "refSearchStrictTools",
    value: listValue(eff("refSearchStrictTools"), DEFAULT_REF_SEARCH_STRICT_TOOLS),
    placeholder: listPlaceholder,
    disabled,
    onChange: (next: readonly string[]): void => {
      setField("refSearchStrictTools", next);
    },
  });
  const testDirs = createElement(ListField, {
    label: t("testDirsLabel"),
    ...splitHint(t("testDirsHint")),
    field: "extraTestDirs",
    value: listValue(eff("extraTestDirs")),
    placeholder: listPlaceholder,
    disabled,
    onChange: (next: readonly string[]): void => {
      setField("extraTestDirs", next);
    },
  });
  const devWords = createElement(ListField, {
    label: t("devWordsLabel"),
    ...splitHint(t("devWordsHint")),
    field: "extraDevServerWords",
    value: listValue(eff("extraDevServerWords")),
    placeholder: listPlaceholder,
    disabled,
    onChange: (next: readonly string[]): void => {
      setField("extraDevServerWords", next);
    },
  });
  const devRunArgs = createElement(ListField, {
    label: t("devRunArgsLabel"),
    ...splitHint(t("devRunArgsHint")),
    field: "extraDevRunArgs",
    value: listValue(eff("extraDevRunArgs")),
    placeholder: listPlaceholder,
    disabled,
    onChange: (next: readonly string[]): void => {
      setField("extraDevRunArgs", next);
    },
  });
  const secretPatterns = createElement(ListField, {
    label: t("secretLabel"),
    ...splitHint(t("secretHint")),
    field: "extraSecretPatterns",
    value: listValue(eff("extraSecretPatterns")),
    separator: "newline",
    placeholder: t("secretPlaceholder"),
    disabled,
    onChange: (next: readonly string[]): void => {
      setField("extraSecretPatterns", next);
    },
  });
  return createElement(
    Section,
    { title: t("rulesSection") },
    small,
    big,
    refTools,
    refStrict,
    testDirs,
    devWords,
    devRunArgs,
    secretPatterns,
  );
}

/** 三个小节的入参。 */
interface SectionInputs {
  t: Translate;
  writable: boolean;
  eff: (field: string) => unknown;
  setField: (field: string, value: unknown) => void;
}

/** 一条读数的形状：`面名 12 · 键名 3`（各行的取值都过这里）。 */
const statsSummary = (lines: readonly StatsLine[]): string =>
  lines.map((line) => `${line.label} ${line.count}`).join(" · ");

/** 一行读数（读数块里的每一行都是它；`key` 只为 React 列表稳定，不参与渲染）。 */
const statLine = (key: string, text: string): ReactNode =>
  createElement("div", { className: "dgc-hint", key }, text);

/** 有快照时的各行。拆出来是为了**分开两件复杂度**：组件那层只管状态与生命周期，
 *  而"哪一格要不要显示"是纯展示判断（合在一起会顶爆 cognitive-complexity）。 */
function statsValueLines(t: Translate, snap: StatsSnapshot): ReactNode[] {
  const lines: ReactNode[] = [];
  const calls = topLines(snap.calls, 6);
  const hits = topLines(snap.hits, 6);
  const asks = topLines(snap.asks, 6);
  const allowed = topLines(snap.allowed, 6);
  const slow = topLines(snap.slow, 6);
  const skipped = Object.values(snap.skipped).reduce((sum, count) => sum + count, 0);
  // 每一格都先把文案落成变量再 push：本仓 lint 的 `max-nested-calls` 上限是 3，
  // 而 `push(statLine(…, t(…, { … })))` 那一串正好是第四层。
  if (calls.length > 0) {
    const callsText = t("statsCalls", { summary: statsSummary(calls) });
    lines.push(statLine("calls", callsText));
  }
  if (hits.length > 0) {
    const hitsText = t("statsHits", { summary: statsSummary(hits) });
    lines.push(statLine("hits", hitsText));
  }
  if (asks.length > 0) {
    const asksText = t("statsAsks", { summary: statsSummary(asks) });
    lines.push(statLine("asks", asksText));
  }
  if (allowed.length > 0) {
    const allowedText = t("statsAllowed", { summary: statsSummary(allowed) });
    lines.push(statLine("allowed", allowedText));
  }
  if (skipped > 0) {
    const skippedText = t("statsSkipped", { count: String(skipped) });
    lines.push(statLine("skipped", skippedText));
  }
  if (slow.length > 0) {
    const slowText = t("statsSlow", { ms: String(snap.slowMs), summary: statsSummary(slow) });
    lines.push(statLine("slow", slowText));
  }
  if (snap.quotaReleases > 0) {
    // 配额放行是"有目标一直凑不齐证据"的信号，比任何命中数都更该被看见 → 用告警色。
    const quotaText = t("statsQuota", { count: String(snap.quotaReleases) });
    lines.push(createElement("div", { className: ERROR_CLASS, key: "quota" }, quotaText));
  }
  return lines;
}

/** 读数块的四种"非正常"面 + 正常面（纯函数：组件只负责把它的结果摆出来）。 */
function statsLinesOf(
  t: Translate,
  read: unknown,
  failed: string | null,
  snap: StatsSnapshot | null,
): ReactNode[] {
  if (read === undefined) {
    return [statLine("unavailable", t("statsUnavailable"))];
  }
  // 读取失败照实说（含错误码），不假装"还没有判定" —— 那会把一次读取故障说成一条结论。
  if (failed !== null) {
    return [createElement("div", { className: ERROR_CLASS, key: "failed" }, failed)];
  }
  if (snap === null) {
    return [statLine("loading", t("statsLoading"))];
  }
  const values = statsValueLines(t, snap);
  return values.length === 0 ? [statLine("empty", t("statsEmpty"))] : values;
}

/**
 * 判定统计读数块：打开卡片时拉一次，另有手动刷新。
 *
 * **不订阅、不轮询**（见 `src/stats-reader.ts` 的读取策略）：判定统计的变化只发生在 agent
 * 干活时，而那时用户多半不在看设置页；少一层订阅就少一类竞态与"上一个宿主的旧值"。
 * 刷新用 tick 驱动同一个 effect：一条读取路径，不写两遍。
 */
function StatsBlock(props: {
  t: Translate;
  read: (() => Promise<StatsSnapshot>) | undefined;
}): ReactNode {
  const { t, read } = props;
  const [snap, setSnap] = useState<StatsSnapshot | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // 用 async + try/catch 而不是 then 链：本仓 lint 禁 then（`prefer-await-to-then`）与
    // promise 里的回调（`no-callback-in-promise`），而 `live` 那个"卸载后不再写状态"
    // 的护栏在 await 之后重判一次即可。
    let live = true;
    const load = async (): Promise<void> => {
      if (read === undefined) {
        return;
      }
      setBusy(true);
      try {
        const next = await read();
        if (live) {
          setSnap(next);
          setFailed(null);
        }
      } catch (error: unknown) {
        if (live) {
          setFailed(String(error instanceof Error ? error.message : error));
        }
      } finally {
        if (live) {
          setBusy(false);
        }
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [read, tick]);
  const refresh = createElement(
    "button",
    {
      type: "button",
      className: "dgc-btn",
      disabled: read === undefined || busy,
      onClick: () => {
        setTick((current) => current + 1);
      },
    },
    t("statsRefresh"),
  );
  const head = createElement(
    "div",
    { className: "dgc-row" },
    createElement("div", { className: "dgc-label" }, t("statsTitle")),
    refresh,
  );
  return createElement(
    "div",
    { className: "dgc-stats" },
    head,
    ...statsLinesOf(t, read, failed, snap),
  );
}

interface DgCardProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  /** 读一次宿主侧判定统计；`undefined` = 这个部署没装 Remote 面（那一段显示"读不到"）。 */
  readStats?: () => Promise<StatsSnapshot>;
  useCard: <Out>(selector: (snap: CardSnapshot) => Out) => Out;
  set: (field: string, value: unknown) => Promise<void>;
  unset: (field: string) => Promise<void>;
}

function DgCard(props: DgCardProps): ReactNode {
  const { t } = props;
  const snap = props.useCard((current) => current);
  const { value } = snap;
  const writable = snap.status === "ready" && snap.writable;
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const eff = (field: string): unknown => (field in touched ? touched[field] : value[field]);
  const dirtyKeys = diffTouched(touched, value);
  const dirty = dirtyKeys.length > 0;
  const setField = (field: string, val: unknown): void => {
    setTouched((prev) => ({ ...prev, [field]: val }));
  };
  const save = async (): Promise<void> => {
    const keys = diffTouched(touched, value);
    if (keys.length === 0) {
      return;
    }
    setBusy(true);
    setSaveError(null);
    const ops = keys.map((key) => {
      const val = touched[key];
      return val === undefined ? props.unset(key) : props.set(key, val);
    });
    const results = await Promise.allSettled(ops);
    const failed: string[] = [];
    let firstReason: unknown;
    for (const [index, key] of keys.entries()) {
      const outcome = results[index];
      if (outcome?.status === "rejected") {
        failed.push(key);
        if (firstReason === undefined) {
          firstReason = outcome.reason;
        }
      }
    }
    setBusy(false);
    if (failed.length === 0) {
      setTouched({});
      return;
    }
    setTouched((prev) => {
      const remaining: Record<string, unknown> = {};
      for (const key of failed) {
        remaining[key] = prev[key];
      }
      return remaining;
    });
    setSaveError(
      `${t("saveFailed")}${String(firstReason instanceof Error ? firstReason.message : firstReason)}`,
    );
    console.error("[danger-guard] save failed:", failed, firstReason);
  };
  const discard = (): void => {
    setTouched({});
    setSaveError(null);
  };
  const inputs: SectionInputs = { t, writable, eff, setField };
  const block = buildBlockSection(inputs);
  const judge = buildJudgeSection(inputs);
  const rules = buildRulesSection(inputs);
  const stats = createElement(StatsBlock, { t, read: props.readStats });
  const saveBar = createElement(SaveBar, {
    dirty,
    busy,
    writable,
    error: saveError,
    saveLabel: t("save"),
    savingLabel: t("saving"),
    revertLabel: t("revert"),
    dirtyLabel: t("dirtyCount", { count: dirtyKeys.length }),
    cleanLabel: t("statusClean"),
    readOnlyLabel: t("statusReadOnly"),
    onSave: () => {
      void save();
    },
    onDiscard: discard,
  });
  return createElement(CardForm, null, block, judge, rules, stats, saveBar);
}

/**
 * 本卡用到的 ctx 面：三位里两位直接投影官方服务面，不再手抄签名。
 *
 * - `effect`：cordis 官方效应面（installed `@deepseek-ai/cordis/lib/types/fiber.d.ts:8`
 *   的 `interface Context extends Pick<Fiber, 'effect'>`，:157/:159 两个重载）。原先这里
 *   手抄的是 `(factory, label?) => void`：官方返回的是 `Disposable`/`AsyncDisposable`，
 *   抄成 void 就把「效应可以 await 回收」这条真实契约藏掉了。
 * - `slots`：官方 `SlotRegistry`（renderer 把它增强进 cordis `Context`）的**方法面投影**。
 *   取 `Pick` 而不是 `Context["slots"]` 整个类型：`SlotRegistry` 是带 private 字段的 cordis
 *   `Service` 类（installed `dsh-client-ui-renderer/lib/types/client/registry.d.ts:46`），
 *   TS 对它做名义比较，测试桩件无法满足。`register` 逐字复用 `SlotCore['register']`
 *   （`registry.d.ts:85` 声明、实现在 slots 包的两个重载），`inject` 是
 *   `registry.d.ts:111` 的「按槽位声明生命周期装 effect」那一位（disposer 随 collapse
 *   重跑工厂的语义就写在 :100）。合并进 `SlotMap` 的槽位键在这里是**编译期受检**的：
 *   `inject`/`register` 的 key 参数域就是 `keyof SlotMap & string`，而
 *   `plugins.bundle.config` 那一枚由文件头那条 `import type` 从属主包载入。
 *   ⚠ 与手抄版的差异都在**类型面**，本卡行为不变，但值得记下来：
 *    ① 官方 `inject` 回一枚 idempotent disposer（手抄版写的是 `void`，等于把「注册可以
 *      被撤销」这条真实契约藏掉）；
 *    ② 官方工厂的返回面是 `SlotInjectionEffect`（`registry.d.ts:44`，那个联合没从 dts
 *      导出：`(() => void) | Iterable<() => void, void, void>`），手抄版只认「一枚函数或
 *      `undefined`」——**没有** undefined 那一支，所以「工厂什么都不回收」从今天起编译期
 *      就红；本卡交回的恰是 `unregister` 这一枚函数，形状不变。
 *    ③ `register` 的第二个实参在官方是**受检的组件面**（`SlotCore['register']` 把组件
 *      props 对上 owner + inject + 标准席位合成出的 `ComposedProps`），手抄版是
 *      `view: unknown` = 什么都不查。
 * - `configForms`：只投影用到的 `get`。官方 `ConfigForms.get` 是泛型
 *   （`<T>(entryId) => ConfigForm<T>`，installed `config-form.d.ts:142`），且
 *   `ConfigForms` 同样是 Service 类 → 既不能整类型用，也不能把 `Pick` 交给桩件；
 *   这里把 `T` 钉在本卡唯一取的那张表单上，返回面仍是官方 `ConfigForm`。
 * - `locale`：官方 `@deepseek-ai/dsh-client-locale` 的 client 面（`LocaleRuntime`，
 *   installed `lib/types/client/index.d.ts`）在本卡实际用到的那两条**类型化**重载上的
 *   投影，取在本包命名空间 `typeof NS` 上：
 *   - `register`：官方 :199 那条（`register<N extends Extract<keyof LocaleNamespaceMap,
 *     string>>(ns: N, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>)`）。字典参数即
 *     下面的 `LocaleCatalog`：两语必须一次交齐，键集必须等于 `UiMessages`。
 *     ⚠ 不走官方 :209 那条未类型化的三参重载（`dict: LocaleDict = Record<string, string>`）：
 *     `UiMessages` 按 lint 的 `consistent-type-definitions` 必须是 `interface`，而
 *     interface 拿不到隐式索引签名，实测
 *     `Index signature for type 'string' is missing in type 'UiMessages'`。走有限键映射
 *     那条既满足官方契约、又让「少一门语言」「多一个键」都在编译期红。
 *   - `bind`：官方 :219 那条（`bind<N …>(ns: N): TranslateNS<N>`）。本包命名空间已 merge
 *     进 `LocaleNamespaceMap`（见 ui-messages.ts），故取在 `typeof NS` 上就是官方
 *     `TranslateNS<'danger-guard'>`：键集由官方表达，本地不再手写函数形状。
 *     ⚠ 不写成 `LocaleRuntime['bind']`：那会把官方**未类型化**的重载（:226，返回
 *     `Translate<string>`）一起带进目标类型，任何单一实现都满足不了两条（实测
 *     `Type 'string' is not assignable to type 'LocaleKeysOf<"danger-guard">'`）。
 */
export interface ClientCtx {
  effect: Context["effect"];
  slots: Pick<SlotRegistry, "inject" | "register">;
  /** 0.1.7 的配置表单服务（installed
   *  `dsh-client-ui-settings/lib/types/client/config-form.d.ts:94-98` 交出
   *  `Context.configForms`，`get:142` 按 profile 条目 id 取那张共享表单）：取代已随宿主
   *  移除的 `settingsScope`（installed 全树零命中，继续注入它 = 整条 client 入口挂不上、
   *  设置卡静默消失）。注入只需 `configForms` 本身——写侧的 `remote.settings` 由 provider
   *  自己的 fiber 承担（同文件 :113-118 明写「letting a shared form write through the
   *  caller's context would make every caller declare `remote.settings`」，故此处不必声明）。 */
  /** 只用 `get` 这一位，故按方法面投影 —— 官方 `ConfigForms` 是带 private 字段的
   *  Service 类，TS 对其做名义比较，测试桩件无法满足。返回类型仍绑官方
   *  `ConfigForm<Record<string, unknown>>`（本卡只按设置条目取这一张表单，故不必
   *  带泛型），快照字段一名一改，这里就会编译失败。 */
  configForms: {
    get: (entryId: string) => EntryForm;
  };
  locale: {
    register: (ns: typeof NS, dicts: LocaleCatalog) => () => void;
    bind: (ns: typeof NS) => Translate;
  };
  /** 显式读一个**可选**服务（`ctx.get`，不受 cordis 的 inject 门禁约束）。本卡只用它读远程面：
   *  **不能**把 `remote` 写进 `inject` —— 那会把整条 client 入口绑死在远程面上，而它是一枚
   *  可选读面（没装它的部署里卡片仍要照常渲染）。为什么与怎么读，见 src/stats-reader.ts 文件头。 */
  get?: (name: string, strict?: boolean) => unknown;
}

function cardStore(form: EntryForm): {
  getSnapshot: () => CardSnapshot;
  subscribe: (listener: () => void) => () => void;
} {
  // 缓存必须 per-form（闭包内）：模块全局会在多表单交错 getSnapshot 时互相
  // 冲 memo，导致 useSyncExternalStore 每次拿到新引用 → 无限重渲染。官方也承诺
  // 快照引用在下次变更前稳定，故身份比较成立。
  let cachedSnap: ConfigFormSnapshot<Record<string, unknown>> | null = null;
  let cachedView: CardSnapshot | null = null;
  return {
    getSnapshot() {
      const snap = form.getSnapshot();
      if (snap !== cachedSnap || cachedView === null) {
        cachedSnap = snap;
        cachedView = {
          status: snap.status,
          writable: snap.writable,
          // 官方 value 在首个快照受理前是 undefined，这里落到空对象供渲染。
          value: snap.value ?? {},
        };
      }
      return cachedView;
    },
    subscribe(listener) {
      return form.subscribe(listener);
    },
  };
}

const inject = ["slots", "configForms", "locale"];

function apply(ctx: ClientCtx): void {
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.id = "dsh-card-ui-css-danger-guard";
    tag.textContent = `${STATS_CSS}\n${CARD_UI_CSS}`;
    document.head.append(tag);
    return () => {
      tag.remove();
    };
  }, "danger-guard-card: styles");
  // 0.1.7：表单按 **profile 条目 id** 取，而本包的条目 id == 设置命名空间 `SETTINGS_NS`
  //（= bulkhead 里持有 Config schema 的那一行 `danger-guard-settings`，见文件头注释与
  // cordis.patch.yml）。旧写法 `settingsScope.bind({ namespace: SETTINGS_NS })` 取的就是
  // 同一个串，故读写两侧的命名空间没有变化；host.test.ts 钉住 SETTINGS_NS 与那一行一致。
  const scope = ctx.configForms.get(SETTINGS_NS);
  const store = cardStore(scope);
  // 卡片文案交给官方 locale：把本包两语字典**一次性**交给官方那条类型化 register 重载
  // （`Record<BuiltInLocaleId, LocaleDictOf<NS>>`，缺一门语言即编译期红；disposer 随
  // effect 回收），再 bind 出稳定的取文案函数交给卡片。语言切换由宿主驱动 slot 重渲染，
  // 无需重载页面。
  // ⚠ 这与旧的「zh / en 各调一次 register、闭包里收两个 disposer」是**同一条代码路径**：
  // installed `dsh-client-locale/lib/client.js:1379-1406` 的 `register(ns, localeOrDicts,
  // dict)` 在第二参不是字符串时走 `Object.entries(localeOrDicts)`，逐语校验标签与重复
  // 后写进同一张 `dicts.get(ns)` 表，返回的**一枚** disposer 把这批 locale 全删掉。
  // 故注册项数与回收范围都不变，只是由一枚效应承载（旧写法要自己拼两个 disposer）。
  ctx.effect(() => ctx.locale.register(NS, UI_MESSAGES), "danger-guard-card: locale dictionaries");
  const t = ctx.locale.bind(NS);
  // 读取器自己判"当前部署有没有远程面"（没有就交 undefined ⇒ 卡片那段显示「读不到」）。
  const readStats = createStatsReader(ctx);
  ctx.slots.inject("plugins.bundle.config", () => {
    const unregister = ctx.slots.register(
      {
        // 0.1.6：settings.plugin.item 已删除；plugins.bundle.config 按 bundle 包名 keyed。
        // 0.1.7 复核：槽位仍在（installed dsh-client-ui-plugin-manager/lib/types/client/
        // slot-contract.d.ts:100），本段仍在用；键按上面的 BUNDLE_PKG 派发证据写
        // （旧注释把"bundle 包名"误当成裸条目 id `danger-guard`，那样宿主永远匹配不到，
        // 插件页面上的设置卡直接不渲染）。表单侧不变：`configForms.get(SETTINGS_NS)` 仍吃
        // 裸条目 id（installed dsh-client-ui-settings/lib/client.js:1309-1315 把入参当命名空间）。
        name: "plugins.bundle.config",
        key: BUNDLE_PKG,
        inject: () => ({
          t,
          hooks: { card: store },
          // 读数器在 apply 期造一次（`$mount` 幂等，见 stats-reader）；宿主没装 Remote 面时
          // 交 undefined，卡片那一段显示"读不到"而不是让整张卡挂不上。
          ...(readStats === undefined ? {} : { readStats }),
          // 0.1.7 的 set/unset 回 `Promise<boolean>`（受理位）。这里**刻意不消费**它：卡片的
          // 保存条沿用 0.1.6 的 `Promise<void>` 形状，失败面仍只认 rejection（传输失败），
          // 由 save() 的 try/catch 呈现为可见错误。改用受理位要新增判定与文案键，那是改
          // 行为而不是迁移（session-rescue / ctx-observe / quality-gate 同一条纪律）。
          set: async (field: string, value: unknown): Promise<void> => {
            await scope.set(field, value);
          },
          unset: async (field: string): Promise<void> => {
            await scope.unset(field);
          },
        }),
      },
      DgCard,
    );
    // disposer 只 unregister()，**不 dispose 表单**：0.1.7 的 `configForms.get(entryId)`
    // 交回的是 provider 自己持有的共享表单（installed config-form.d.ts:138-142
    // "The entry's form, owned by this provider"），消费契约 `ConfigForm`
    //（config-form-types.d.ts 的 ConfigForm）里根本没有 dispose，消费者无从销毁；provider 在自己的
    // fiber 上统一回收（installed lib/client.js:1289-1293）。slot collapse 会调用本 disposer
    // 并在再次声明时**重跑工厂**（installed dsh-client-ui-renderer/lib/types/client/
    // registry.d.ts:100 "Collapse disposes the effect and a later declaration runs it
    // again"）——表单共享且长活，所以重跑后写入依然落盘；旧 `settingsScope` 那种「离开插件页
    // 一次之后 scope 永久 disposed、之后每次保存被静默丢弃」的坑（0.1.6 的 fiber 级 dispose，
    // 现由 installed lib/client.js:1213 的 disposed 早退返回 false 承接）随该服务一起消失。
    return unregister;
  });
}

export { inject, apply };
