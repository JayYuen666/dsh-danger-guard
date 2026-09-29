// danger-guard client 半：设置卡（总开关 + 事实门开关/放行次数/严格模式/写面阈值/引用取证
// 检索工具名单 + 两份危险面词表）。
// 参照 session-rescue / ctx-observe / quality-gate 的卡片模式：keyed plugins.bundle.config
// 槽（key = bundle 包名 `@jayyuen666/dsh-danger-guard`，见 BUNDLE_PKG）+ 0.1.7 的
// ctx.configForms.get(条目 id) 表单（id = 设置条目 `danger-guard-settings`），React 由模块
// 系统提供（rolldown external），只用 createElement。

import { createElement, useEffect, useState } from "react";
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
import {
  DEFAULT_MAX_DENIES,
  DEFAULT_SMALL_EDIT_CHARS,
  DEFAULT_BIG_EDIT_CHARS,
} from "../lib/fact-gate.ts";
// 名单默认值与 host 的取证判据、指令文案兜底同源（lib/ref-search-policy.ts），卡片只是回退显示它。
import { DEFAULT_REF_SEARCH_TOOLS } from "../lib/ref-search-policy.ts";
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
 * `plugins.bundle.config` 的 key = **bundle 的 npm 包名**，与上面两个串互不相干
 * （本包刻意有三个串：locale 命名空间 / settings 命名空间 / slot key）。
 * 派发证据（installed dsh 0.1.7）：
 *   · dsh-client-ui-plugin-manager/lib/client.js:1821 `renderSlot("plugins.bundle.config",
 *     { view: "page" }, { entryKey: pkg.name })`——pkg.name 由 :306/:320 的
 *     `packageView()` 取 `bundle.name`（= bundle 包名）；:2698
 *     `configured: ledger.bundles.has(openPkg.name)` 决定页面**要不要**开这个槽位；
 *   · 同包 lib/types/client/slot-contract.d.ts:96-100「A bundle's own configuration,
 *     **keyed by the bundle's package name**」，kind `keyed` → `key` 必填；
 *   · dsh-client-ui-renderer/lib/client.js:1154 逐字相等匹配 `options.key === entryKey`，
 *     写错不是回落而是**整张卡不渲染**；
 *   · 官方占位者 dsh-experimental-client-ui-voice-input/lib/client.js:5659-5661 亦用包名。
 * 行槽（本包未用）写成 `<pkg>#<rowId>`（plugin-manager/lib/client.js:27-28 `rowConfigKey`）。
 * bulkhead 的第二行 `danger-guard-settings` 只是同一个 bundle 里的**行**（name 是
 * `@jayyuen666/dsh-danger-guard/settings`，导出子路径而非 bundle），profile 的 bundles
 * 清单里只有本包名这一条，所以 key 不能是 `-settings` 那条。
 * 值必须与 package.json 的 name 一致并出现在 `~/.dsh/profiles/web/package.json` 的
 * `dsh.profile.bundles` 里——test/client-card.test.ts 从该文件解析校验，不抄硬编码。
 */
const BUNDLE_PKG = "@jayyuen666/dsh-danger-guard";

const CARD_CSS = [
  ".dgc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
  ".dgc-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
  ".dgc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
  ".dgc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
  ".dgc-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
  ".dgc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
  ".dgc-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
  ".dgc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".dgc-chevron-open{transform:rotate(180deg)}",
  ".dgc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:8px 0 12px}",
  ".dgc-row{display:flex;flex-direction:row;justify-content:space-between;align-items:center;gap:12px;padding:9px 0}",
  ".dgc-label{font-size:13px;color:var(--dsw-alias-label-primary,inherit)}",
  ".dgc-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99);line-height:1.5;margin-top:2px}",
  ".dgc-switch{appearance:none;position:relative;width:34px;height:20px;border-radius:10px;background:var(--dsw-alias-fill-primary,#d8dbe2);transition:background .16s;cursor:pointer;border:0;flex:none}",
  '.dgc-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);transition:left .16s}',
  ".dgc-switch-on{background:var(--dsw-alias-brand-primary,#e07856)}",
  ".dgc-switch-on::after{left:16px}",
  ".dgc-switch:disabled{cursor:not-allowed;opacity:.6}",
  ".dgc-input{width:100%;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px;margin-top:4px}",
  ".dgc-numinput{width:64px;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px;margin-top:4px;text-align:center}",
  ".dgc-textarea{width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l2,transparent);border-radius:8px;padding:6px 8px;margin-top:4px;resize:vertical;font-family:ui-monospace,SFMono-Regular,monospace}",
  // 保存条（改动先暂存，点「保存」才写入生效；「撤销」丢弃本地改动）
  ".dgc-savebar{display:flex;gap:8px;align-items:center;padding:10px 0 2px;border-top:1px dashed var(--dsw-alias-border-l2);margin-top:6px;flex-wrap:wrap}",
  ".dgc-btn{appearance:none;font:inherit;font-size:12px;cursor:pointer;border-radius:6px;padding:4px 12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit)}",
  ".dgc-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
  ".dgc-btn-primary{background:var(--dsw-alias-brand-primary,#e07856);border-color:var(--dsw-alias-brand-primary,#e07856);color:var(--dsw-alias-label-primary-foreground,#fff)}",
  ".dgc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#e07856);outline-offset:1px}",
  ".dgc-btn:disabled{opacity:.5;cursor:not-allowed}",
  ".dgc-dirty{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}",
  ".dgc-saveerr{font-size:12px;color:#c4483f}",
].join("\n");

/** SVG path 的 path-data 属性键（`d` 单字符过短被 id-length 拦截，用常量间接触达）。 */
const SVG_PATH_KEY = "d";

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

interface ToggleRowProps {
  label: string;
  hint: string;
  checked: boolean;
  /** 稳定锚点（与 ListInputRow 同约定）：测试/样式按字段定位控件，不依赖行序与中文文案。 */
  field: string;
  /** 快照未 ready（loading/unavailable）时禁用——免得向未就绪的表单写。 */
  disabled?: boolean;
  onToggle: () => void;
}

function ToggleRow(props: ToggleRowProps): ReactNode {
  return createElement(
    "div",
    { className: "dgc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "dgc-label" }, props.label),
      createElement("div", { className: "dgc-hint" }, props.hint),
    ),
    createElement("button", {
      type: "button",
      className: `dgc-switch${props.checked ? " dgc-switch-on" : ""}`,
      role: "switch",
      "aria-checked": props.checked,
      "data-field": props.field,
      disabled: props.disabled === true ? true : undefined,
      onClick: props.onToggle,
    }),
  );
}

interface ListInputRowProps {
  label: string;
  hint: string;
  field: string;
  value: unknown;
  /** 取文案（未给 placeholder 的行用字典里的通用占位）。 */
  t: Translate;
  /** 条目分隔：'newline'（textarea，每行一条，适合含逗号的正则）| 'comma'（单行输入）。 */
  separator?: "newline" | "comma";
  placeholder?: string;
  /** 快照未 ready 时禁用输入（与开关同理）。 */
  disabled?: boolean;
  onChange: (field: string, list: string[]) => void;
}

/** 词表/模式输入行：设置数组 ↔ UI 串（v6 词表可配置）。
 *  保存条模式：本行只上报草稿（onChange），写入统一由「保存」触发——
 *  旧实现的 300ms 防抖直写 + 卸载 flush 整体移除。 */
function ListInputRow(props: ListInputRowProps): ReactNode {
  const multiline = props.separator === "newline";
  const splitEntries = (raw: string): string[] =>
    raw
      .split(multiline ? "\n" : ",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  const list = Array.isArray(props.value)
    ? (props.value as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const external = list.join(multiline ? "\n" : ", ");
  // 占位先取成变量：t() 嵌进 createElement 的对象字面量里会超 max-nested-calls 上限。
  const inputPlaceholder = props.placeholder ?? props.t("listPlaceholder");
  const [text, setText] = useState(external);
  // 外部值变化（别处写入/快照刷新）时回同步——但正打字时不抢光标。
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) {
      setText(external);
    }
  }, [external, focused]);
  return createElement(
    "div",
    { className: "dgc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "dgc-label" }, props.label),
      createElement("div", { className: "dgc-hint" }, props.hint),
      createElement(multiline ? "textarea" : "input", {
        className: multiline ? "dgc-textarea" : "dgc-input",
        // 稳定锚点：卡片新增/调整行序时，测试与样式都不必再依赖"第几个 .dgc-input"。
        "data-field": props.field,
        value: text,
        disabled: props.disabled === true ? true : undefined,
        placeholder: inputPlaceholder,
        onFocus: () => {
          setFocused(true);
        },
        onBlur: () => {
          setFocused(false);
        },
        onChange: (event: { target: { value: string } }) => {
          const next = event.target.value;
          setText(next);
          props.onChange(props.field, splitEntries(next));
        },
      }),
    ),
  );
}

/** 数字输入行：单个整数设置（强校验参数，如 maxDenies 放行次数）。
 *  未配置时显示 fallback（单源默认值），不是 min——min 只是合法下界。 */
function NumberInputRow(props: {
  label: string;
  hint: string;
  field: string;
  value: unknown;
  fallback: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}): ReactNode {
  const num =
    typeof props.value === "number" && Number.isFinite(props.value) ? props.value : props.fallback;
  const [text, setText] = useState(String(num));
  const [focused, setFocused] = useState(false);
  // 外部值变化（设置卡写回/快照刷新）时回同步——正打字时不抢光标。
  useEffect(() => {
    if (!focused) {
      setText(String(num));
    }
  }, [num, focused]);
  return createElement(
    "div",
    { className: "dgc-row" },
    createElement(
      "div",
      null,
      createElement("div", { className: "dgc-label" }, props.label),
      createElement("div", { className: "dgc-hint" }, props.hint),
    ),
    createElement("input", {
      type: "number",
      min: props.min,
      max: props.max,
      className: "dgc-numinput",
      "data-field": props.field,
      value: text,
      disabled: props.disabled === true ? true : undefined,
      style: { width: "64px", textAlign: "center" },
      onFocus: () => {
        setFocused(true);
      },
      onBlur: () => {
        setFocused(false);
      },
      onChange: (event: { target: { value: string } }) => {
        const raw = event.target.value;
        setText(raw);
        const numValue = Number(raw);
        if (Number.isFinite(numValue) && numValue >= props.min && numValue <= props.max) {
          props.onChange(Math.trunc(numValue));
        }
      },
    }),
  );
}

/** touched 层与快照的差异字段（值语义比较；undefined 与缺失等价）。 */
export function diffTouched(
  touched: Record<string, unknown>,
  value: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(touched)) {
    if (JSON.stringify(touched[key] ?? null) !== JSON.stringify(value[key] ?? null)) {
      out.push(key);
    }
  }
  return out;
}

/**
 * 快照值 → 字符串名单。非数组（字段未配置 / 持久段被手改成标量）回落 fallback 默认名单，
 * 与 host 的 `strArray(...) ?? DEFAULT_*` 读取口径**同形**——卡片显示"空"而门禁其实按默认
 * 判，就会把说明与判定分成两张皮；显式空数组则照实返回 []（用户的选择）。
 */
const nameListOf = (value: unknown, fallback: readonly string[]): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [...fallback];

interface SaveBarProps {
  dirty: boolean;
  writable: boolean;
  busy: boolean;
  error: string | null;
  t: Translate;
  onSave: () => void;
  onDiscard: () => void;
}

/** 保存条状态文案（可写 + 草稿状态四象限）。 */
function dirtyText(t: Translate, writable: boolean, dirty: boolean): string {
  if (!writable) {
    return t("statusReadOnly");
  }
  return dirty ? t("statusDirty") : t("statusClean");
}

function SaveBar(props: SaveBarProps): ReactNode {
  const { t } = props;
  const dis = !props.writable || props.busy;
  const statusText = props.error ?? dirtyText(t, props.writable, props.dirty);
  const statusClass = props.error === null ? "dgc-dirty" : "dgc-saveerr";
  return createElement(
    "div",
    { className: "dgc-savebar" },
    createElement(
      "button",
      {
        type: "button",
        className: "dgc-btn dgc-btn-primary",
        "data-field": "save",
        disabled: dis || !props.dirty,
        onClick: props.onSave,
      },
      props.busy ? t("saving") : t("save"),
    ),
    createElement(
      "button",
      {
        type: "button",
        className: "dgc-btn",
        "data-field": "discard",
        disabled: dis || !props.dirty,
        onClick: props.onDiscard,
      },
      t("revert"),
    ),
    createElement("span", { className: statusClass }, statusText),
  );
}

interface DgCardProps {
  /** 取文案（官方 ctx.locale.bind 的结果，见 apply）。 */
  t: Translate;
  useCard: <Out>(selector: (snap: CardSnapshot) => Out) => Out;
  set: (field: string, value: unknown) => Promise<void>;
  unset: (field: string) => Promise<void>;
}

/** 一列设置行的渲染上下文：可写位 + 草稿优先的取值 + 写草稿 + 取文案。
 *  行族与表头原本长在 DgCard 体内，提到模块层后它们只要这一枚入参（各自也只有它）。 */
interface RowCtx {
  t: Translate;
  writable: boolean;
  /** 渲染取值：touched 优先，快照兜底（未触碰字段实时跟随外部快照）。 */
  eff: (field: string) => unknown;
  setField: (field: string, val: unknown) => void;
}

/** 表头（标题 + 说明 + 折叠箭头），拆成独立函数以压低 createElement 嵌套深度
 *  （t() 嵌进 createElement 里再叠上 className 模板就超 unicorn/max-nested-calls 上限）。 */
function cardHeader(t: Translate, open: boolean, onToggleOpen: () => void): ReactNode {
  const headTitle = t("cardTitle");
  const headDesc = t("cardDescription");
  return createElement(
    "button",
    {
      type: "button",
      className: "dgc-header",
      "aria-expanded": open,
      onClick: onToggleOpen,
    },
    createElement(
      "div",
      { className: "dgc-head" },
      createElement("div", { className: "dgc-name" }, headTitle),
      createElement("div", { className: "dgc-desc" }, headDesc),
    ),
    createElement(
      "svg",
      {
        width: 14,
        height: 14,
        viewBox: "0 0 14 14",
        "aria-hidden": true,
        className: `dgc-chevron${open ? " dgc-chevron-open" : ""}`,
      },
      createElement("path", {
        [SVG_PATH_KEY]: "M3 5l4 4 4-4",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ),
  );
}

/** 开关/阈值族（总开关、事实门、放行次数、严格模式、两份写面阈值）。 */
function gateRows(rc: RowCtx): ReactNode[] {
  const { t, writable, eff, setField } = rc;
  // 事实门 hint 里点名的检索工具来自**生效名单**（草稿优先、快照兜底），与 host 的
  // refSearchTools 读取口径同源：门禁认什么工具，说明里就只写什么工具。
  const refTools = nameListOf(eff("refSearchTools"), DEFAULT_REF_SEARCH_TOOLS);
  const refToolsText = refTools.length > 0 ? refTools.join("/") : t("refToolsEmpty");
  // 带插值的三行先取成变量：t(key, params) 嵌进 createElement 的对象字面量里会超
  // unicorn/max-nested-calls 上限（createElement → t → 取值）。
  const factGateHint = t("factGateHint", { tools: refToolsText });
  const smallHint = t("smallHint", { chars: DEFAULT_SMALL_EDIT_CHARS });
  const bigHint = t("bigHint", { chars: DEFAULT_BIG_EDIT_CHARS });
  const rowEnabled = createElement(ToggleRow, {
    label: t("enabledLabel"),
    hint: t("enabledHint"),
    field: "enabled",
    checked: eff("enabled") !== false,
    disabled: !writable,
    onToggle: () => {
      setField("enabled", eff("enabled") === false);
    },
  });
  const rowFactGate = createElement(ToggleRow, {
    label: t("factGateLabel"),
    hint: factGateHint,
    field: "factGateEnabled",
    checked: eff("factGateEnabled") !== false,
    disabled: !writable,
    onToggle: () => {
      setField("factGateEnabled", eff("factGateEnabled") === false);
    },
  });
  const rowMaxDenies = createElement(NumberInputRow, {
    label: t("maxDeniesLabel"),
    hint: t("maxDeniesHint"),
    field: "maxDenies",
    value: eff("maxDenies"),
    fallback: DEFAULT_MAX_DENIES,
    min: 1,
    max: 5,
    disabled: !writable,
    onChange: (num) => {
      setField("maxDenies", num);
    },
  });
  const rowStrict = createElement(ToggleRow, {
    label: t("strictLabel"),
    hint: t("strictHint"),
    field: "strictMode",
    checked: eff("strictMode") === true,
    disabled: !writable,
    onToggle: () => {
      setField("strictMode", eff("strictMode") !== true);
    },
  });
  const rowSmall = createElement(NumberInputRow, {
    label: t("smallLabel"),
    hint: smallHint,
    field: "smallEditChars",
    value: eff("smallEditChars"),
    fallback: DEFAULT_SMALL_EDIT_CHARS,
    min: 1,
    max: 2000,
    disabled: !writable,
    onChange: (num) => {
      setField("smallEditChars", num);
    },
  });
  const rowBig = createElement(NumberInputRow, {
    label: t("bigLabel"),
    hint: bigHint,
    field: "bigEditChars",
    value: eff("bigEditChars"),
    fallback: DEFAULT_BIG_EDIT_CHARS,
    min: 2,
    max: 100_000,
    disabled: !writable,
    onChange: (num) => {
      setField("bigEditChars", num);
    },
  });
  return [rowEnabled, rowFactGate, rowMaxDenies, rowStrict, rowSmall, rowBig];
}

/** 名单/词表族（引用取证两份名单、测试目录、两份 dev 词表、密钥路径正则）。 */
function vocabRows(rc: RowCtx): ReactNode[] {
  const { t, writable, eff, setField } = rc;
  const refToolsHint = t("refToolsHint", { tools: DEFAULT_REF_SEARCH_TOOLS.join("/") });
  const rowRefTools = createElement(ListInputRow, {
    t,
    label: t("refToolsLabel"),
    hint: refToolsHint,
    field: "refSearchTools",
    value: eff("refSearchTools"),
    disabled: !writable,
    onChange: (field, list) => {
      setField(field, list);
    },
  });
  const rowRefStrictTools = createElement(ListInputRow, {
    t,
    label: t("refStrictLabel"),
    hint: t("refStrictHint"),
    field: "refSearchStrictTools",
    value: eff("refSearchStrictTools"),
    disabled: !writable,
    onChange: (field, list) => {
      setField(field, list);
    },
  });
  const rowTestDirs = createElement(ListInputRow, {
    t,
    label: t("testDirsLabel"),
    hint: t("testDirsHint"),
    field: "extraTestDirs",
    value: eff("extraTestDirs"),
    disabled: !writable,
    onChange: (field, list) => {
      setField(field, list);
    },
  });
  const rowDevWords = createElement(ListInputRow, {
    t,
    label: t("devWordsLabel"),
    hint: t("devWordsHint"),
    field: "extraDevServerWords",
    value: eff("extraDevServerWords"),
    disabled: !writable,
    onChange: (field, list) => {
      setField(field, list);
    },
  });
  const rowDevRunArgs = createElement(ListInputRow, {
    t,
    label: t("devRunArgsLabel"),
    hint: t("devRunArgsHint"),
    field: "extraDevRunArgs",
    value: eff("extraDevRunArgs"),
    disabled: !writable,
    onChange: (field, list) => {
      setField(field, list);
    },
  });
  const rowSecretPatterns = createElement(ListInputRow, {
    t,
    label: t("secretLabel"),
    hint: t("secretHint"),
    field: "extraSecretPatterns",
    value: eff("extraSecretPatterns"),
    separator: "newline",
    placeholder: t("secretPlaceholder"),
    disabled: !writable,
    onChange: (field, list) => {
      setField(field, list);
    },
  });
  return [
    rowRefTools,
    rowRefStrictTools,
    rowTestDirs,
    rowDevWords,
    rowDevRunArgs,
    rowSecretPatterns,
  ];
}

function DgCard(props: DgCardProps): ReactNode {
  const { t } = props;
  const [open, setOpen] = useState(false);
  // 框架把 slots.register 注入的 hooks.card 映射为 useCard prop（client-runner PropsHooks）——
  // 直接读 props.hooks.card 会崩（props.hooks 不存在）。与 ctx-observe / quality-gate 卡同契约。
  // 快照出自本包 cardStore.getSnapshot()（见文件末尾的 `hooks: { card: store }`）：
  // 它总是现造一枚完整的 CardSnapshot，value 也在那儿落好兜底，故这里不再判空。
  const snap = props.useCard((current) => current);
  const { value } = snap;
  // 官方快照的 writable 是必选 boolean（memory 模式永假），故直接取值即可，
  // 不再 `=== true` 假装它可能是别的形状；status==='ready' 仍是必要前置
  //（loading/unavailable 时快照未就绪或命名空间未服务——禁用写入控件）。
  const writable = snap.status === "ready" && snap.writable;
  // 保存条状态：touched = 用户动过的字段（undefined = 恢复默认/unset）
  const [touched, setTouched] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 渲染取值：touched 优先，快照兜底（未触碰字段实时跟随外部快照）。 */
  const eff = (field: string): unknown => (field in touched ? touched[field] : value[field]);
  const dirty = diffTouched(touched, value).length > 0;
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
    try {
      await Promise.all(ops);
      setBusy(false);
      setTouched({});
    } catch (error) {
      setBusy(false);
      setSaveError(`${t("saveFailed")}${String(error instanceof Error ? error.message : error)}`);
      console.error("[danger-guard] save failed:", error);
    }
  };
  const discard = (): void => {
    setTouched({});
    setSaveError(null);
  };
  const rc: RowCtx = { t, writable, eff, setField };
  // 各设置行（各自独立 createElement，避免最终返回式里层层嵌套超深）。
  const body = createElement(
    "ul",
    { className: "dgc-body" },
    ...gateRows(rc),
    ...vocabRows(rc),
    createElement(SaveBar, {
      t,
      dirty,
      writable,
      busy,
      error: saveError,
      onSave: () => {
        void save();
      },
      onDiscard: discard,
    }),
  );
  return createElement(
    "li",
    { className: `dgc-card${open ? " dgc-card-open" : ""}` },
    cardHeader(t, open, () => {
      setOpen(!open);
    }),
    open ? body : null,
  );
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
    tag.id = "danger-guard-card-css";
    tag.textContent = CARD_CSS;
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
    //（config-form-types.d.ts:36-74）里根本没有 dispose，消费者无从销毁；provider 在自己的
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
