// src/stats-reader.ts —— 设置卡读**宿主侧判定统计**的那一面（官方 Typert Remote 的消费侧）。
//
// 为什么需要它：设置卡跑在浏览器里，而统计是宿主进程的内存 —— 设置面没有"宿主计算值"的口子
// （`ctx.settings` 只有 configure/describe/update/replace/mutate），所以唯一的官方通道就是
// Remote。官方 `ui-permission-presets` 正是这么读宿主那份进程级目录的。
//
// 为什么 descriptor 是**手写**的而不是生成器的产物：本服务只有一个**无参、一元、JSON 结果**的
// 方法，而 `TypertCodec` 有一个 `{ mode: "src-json" }` 的源码模式变体 —— 它不需要 `typeSymbol`、
// 也不需要 `create()`，而那两样正是生成器存在的理由。手写这一枚 descriptor 比引入一条构建期
// 代码生成链（外加生成物随包发布）便宜得多。
//
// ⚠ **为什么走 `ctx.get("remote")` 而不是把 `remote` 写进 `inject`**：cordis 对**未 inject 的
// 服务**读取是**抛错**（`cannot get property "remote" without inject`，
// vendor/cordis/src/reflect.ts:144）。而本包的卡片在"没装远程面"的部署里也必须照常渲染（那是
// 一枚可选读面），`inject: ["remote", …]` 却会把整条 client 入口绑死在远程面上 —— 缺它就不激活。
// 本轮实测踩过这一脚：web boot 报 `1 entry did not activate: @jayyue66/dsh-danger-guard: failed`，
// 而产物本身完全正常（语法、导出、`apply` 都跑得通），抛的就是上面那条 inject 错误。
// `ctx.get` 是**显式读取**，不受 inject 门禁约束 —— 官方网关自己也是这么读可选服务的
// （packages/api/gateway/src/client/index.ts 的 `this.ownerCtx.get('connection')`）。
//
// ⚠ 类型一律 `import type`（产物里零新说明符）：发布面那条纪律要求 `@deepseek-ai/*` 只作
// 类型消费，值导入面只有四枚（schemastery / shared / dsh-brand / zod）。
import type { InvocationDescriptor, RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
// 槽位键与 descriptor 的 package 位共用一枚单源（src/bundle-pkg.ts）：两处各写一遍时，
// 改名漏一处没有任何编译期信号，表现是"读不到"而不是报错。
import { BUNDLE_PKG } from "./bundle-pkg.ts";
import { isRecord } from "@jayyuen66/dsh-plugin-shared/lib/record";
import { z } from "zod";

// 形状从**叶子**模块取，不从 lib/judge-stats.ts：后者带 node:os/node:path，
// 那会把它们拖进客户端类型程序（实测 TS2591）。
import type { StatsSnapshot } from "../lib/stats-shape.ts";

/** 宿主侧那枚服务键（= 线上命名空间）。与 `lib/stats-remote.ts` 的 `STATS_SERVICE_KEY` 同值：
 *  两侧各自内联 `lib/` 的那一份是**两个产物**，所以这个串在两处各写一次是必然的 —— 而它一旦
 *  分叉，读侧会拿到"未知命名空间"而不是静默错值（网关按命名空间路由）。 */
const STATS_NAMESPACE = "dangerGuardStats";

/** 网关给命名空间注册的**服务键**：`remote.<namespace>`（`remoteServiceKey`，
 *  packages/api/gateway/src/client/index.ts:752）。它在 `$mount` 完成之后才存在，所以只能
 *  在挂载后按这个键去读，而不是提前 inject。 */
const STATS_SERVICE_KEY = `remote.${STATS_NAMESPACE}`;

/** 把宿主那枚方法挂到客户端远程面上的描述符（`id` 的形状照生成器：`<包>#<命名空间>/<方法>`）。
 *  导出它只为一件事：`test/stats-remote.test.ts` 拿它与宿主侧 `remoteMethods()` 的标记对质
 *  —— 两侧分叉时卡片不会报错，只会"读不到"，所以那条比较必须在门禁里。 */
export const STATS_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${BUNDLE_PKG}#${STATS_NAMESPACE}/stats`,
    service: STATS_NAMESPACE,
    namespace: STATS_NAMESPACE,
    method: "stats",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
];

/** 客户端上下文里本模块用到的那一位：**显式读取**一个可选服务（见文件头为什么不用 inject）。 */
export interface RemoteHost {
  get?: (name: string, strict?: boolean) => unknown;
}

/** 官方网关的客户端服务面：本卡只用 `$mount` 一位（挂载一枚手写贡献）。 */
interface RemoteMounter {
  $mount: (contribution: {
    package: string;
    descriptors: readonly InvocationDescriptor[];
  }) => Promise<unknown>;
}

/** 挂载后由网关提供的命名空间服务面。 */
interface StatsNamespace {
  stats: () => Promise<RemoteResult<StatsSnapshot>>;
}

/** 这个值能当远程面用吗（只核我们要调的那一位；服务来自别的实现或版本时保守当作没有）。 */
const isRemoteMounter = (value: unknown): value is RemoteMounter =>
  isRecord(value) && typeof value["$mount"] === "function";

/** 同上：命名空间服务（挂载之后才有，缺它说明网关没认这枚贡献）。 */
const isStatsNamespace = (value: unknown): value is StatsNamespace =>
  isRecord(value) && typeof value["stats"] === "function";

/** 跨进程返回值的形状守卫：字段齐、表是对象、计数是有限数字。多出来的键不拦——
 *  这是消费侧的下限校验，不是对宿主实现的穷举。zod 只做校验，不把原对象换成解析产物：
 *  宿主多写的键仍照原样交给上层。 */
const STATS_SNAPSHOT_SCHEMA: z.ZodType<StatsSnapshot> = z.object({
  calls: z.record(z.string(), z.number()),
  slow: z.record(z.string(), z.number()),
  hits: z.record(z.string(), z.number()),
  asks: z.record(z.string(), z.number()),
  allowed: z.record(z.string(), z.number()),
  allowedByMode: z.record(z.string(), z.number()),
  skipped: z.record(z.string(), z.number()),
  quotaReleases: z.number(),
  slowMs: z.number(),
  window: z.number(),
});

const isStatsSnapshot = (value: unknown): value is StatsSnapshot =>
  STATS_SNAPSHOT_SCHEMA.validate(value);

/**
 * 造出真正的读取器（挂载一次 + 每次读命名空间服务）。
 * @param ctx - 客户端上下文
 * @param remote - 已核过形状的远程面
 * @returns 读取器
 */
function buildStatsReader(ctx: RemoteHost, remote: RemoteMounter): () => Promise<StatsSnapshot> {
  let mounted: Promise<unknown> | undefined;
  return async () => {
    mounted ??= remote.$mount({ package: BUNDLE_PKG, descriptors: STATS_DESCRIPTORS });
    try {
      await mounted;
    } catch (error: unknown) {
      // 挂载失败不缓存拒绝：首次打开卡片时"网关/连接尚未就绪"正是最常见的瞬时失败，
      // 缓存那枚 rejected promise 会让每次刷新都撞同一个旧错误，只能整页刷新才恢复。
      // `$mount` 幂等，清空后下一次读取重新挂即可。
      mounted = undefined;
      throw error;
    }
    const namespace = ctx.get?.(STATS_SERVICE_KEY, false);
    if (!isStatsNamespace(namespace)) {
      throw new Error(`${STATS_SERVICE_KEY} 未提供：宿主网关没有挂上这枚命名空间`);
    }
    const result = await namespace.stats();
    if (!result.ok) {
      // error 的形状由宿主侧实现交付，实现漂移时可能整体缺席——降级读取，而不是让
      // "读 undefined 的属性"的 TypeError 盖掉真正的失败原因。
      const detail = isRecord(result.error)
        ? `${result.error.code}: ${result.error.message}`
        : "远端报告失败但未附错误详情";
      throw new Error(detail);
    }
    if (!isStatsSnapshot(result.value)) {
      throw new Error("判定统计快照形状不符：宿主侧实现漂移，读数块按读取失败呈现");
    }
    return result.value;
  };
}

/**
 * 造一个"读一次宿主侧判定统计"的读取器；**当前部署没有远程面时返回 `undefined`**（卡片那一段
 * 显示「读不到」，其余照常 —— 与 host 侧可选读面同一条口径）。
 *
 * **读取策略：按需拉取，不订阅、不缓存跨连接的旧值。** 官方那套（`ui-permission-presets`
 * 的 catalog）要处理连接代际失效，是因为它**缓存**一份进程级目录并在 UI 上长期显示；本卡这份
 * 读数只在打开卡片时取一次、并给一个手动刷新 —— 不缓存就不存在"上一个宿主的旧值"，也就
 * 不需要代际那套机制（少一层状态，少一类竞态）。代价是数字不会自己跳动，而那正是我们要的
 * （判定统计的变化只发生在 agent 干活时）。
 *
 * `$mount` 是**幂等**的（挂进本 fiber，随卡片卸载自动撤），所以这里缓存那枚 promise：
 * 同一次会话里刷新多次只挂一次。
 *
 * @param ctx - 客户端上下文（只用 `get` 一位）
 * @returns 读取器；没有远程面时 `undefined`
 */
export function createStatsReader(ctx: RemoteHost): (() => Promise<StatsSnapshot>) | undefined {
  // strict 显式给 false：本读面是**可选读**——"没装远程面"要交回 undefined 降级，而不是抛。
  // 与 buildStatsReader 里那一次读取同形，"可选读"在代码上自证。
  const remote = ctx.get?.("remote", false);
  // 单 return（三元的另一支是 `undefined`）：`consistent-return` 不接受"早退 undefined + 晚退函数"
  // 这种混合形状，而这里两种结果本来就是同一件事的两面。
  return isRemoteMounter(remote) ? buildStatsReader(ctx, remote) : undefined;
}

/** 把一份快照折成一行行"面 · 次数"的读数（渲染归卡片，这里只做**排序与裁剪**的纯活）。
 *
 * 排序是刻意的：宿主侧的表是插入序（谁先命中谁在前），而卡片要的是"最常发生的先显示" ——
 * 一条统计里最该被看见的是**最大**的那几格。
 */
export interface StatsLine {
  readonly label: string;
  readonly count: number;
}

/** 并列时的键序：按码点比较（`localeCompare` 随宿主 locale 变，跨机器可能不同序）——
 *  "同一份快照渲染稳定"要的是逐字节确定的顺序。 */
const compareKeys = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** 按键的次数降序取前 `limit` 格（并列时按键码点序，保证同一份快照渲染稳定）。
 *  `limit` 只收正安全整数：其它取值按 0 处理交回空表——`slice` 对负数的"丢掉最后一格"
 *  与 NaN 的"全丢"都是静默的错位语义，调用方将来不一定是常量。 */
export function topLines(counts: Readonly<Record<string, number>>, limit: number): StatsLine[] {
  const take = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  return Object.entries(counts)
    .toSorted(([leftKey, left], [rightKey, right]) =>
      right === left ? compareKeys(leftKey, rightKey) : right - left,
    )
    .slice(0, take)
    .map(([label, count]) => ({ label, count }));
}
