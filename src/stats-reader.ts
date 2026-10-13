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
// ⚠ 类型一律 `import type`（产物里零新说明符）：发布面那条纪律要求 `@deepseek-ai/*` 只作
// 类型消费，值导入面只有四枚（schemastery / shared / dsh-brand / zod）。
import type { InvocationDescriptor, RemoteResult } from "@deepseek-ai/dsh-typert-protocol";

// 形状从**叶子**模块取，不从 lib/judge-stats.ts：后者带 node:os/node:path，
// 那会把它们拖进客户端类型程序（实测 TS2591）。
import type { StatsSnapshot } from "../lib/stats-shape.ts";

/** 宿主侧那枚服务键（= 线上命名空间）。与 `lib/stats-remote.ts` 的 `STATS_SERVICE_KEY` 同值：
 *  两侧各自内联 `lib/` 的那一份是**两个产物**，所以这个串在两处各写一次是必然的 —— 而它一旦
 *  分叉，读侧会拿到"未知命名空间"而不是静默错值（网关按命名空间路由）。 */
const STATS_NAMESPACE = "dangerGuardStats";

/** 卡片所在 bundle 的包名（`$mount` 的 `package` 位与槽位键同源，见 client-entry.ts 的 BUNDLE_PKG）。 */
const PACKAGE_NAME = "@jayyuen66/dsh-danger-guard";

/** 把宿主那枚方法挂到客户端远程面上的描述符（`id` 的形状照生成器：`<包>#<命名空间>/<方法>`）。
 *  导出它只为一件事：`test/stats-remote.test.ts` 拿它与宿主侧 `remoteMethods()` 的标记对质
 *  —— 两侧分叉时卡片不会报错，只会"读不到"，所以那条比较必须在门禁里。 */
export const STATS_DESCRIPTORS: readonly InvocationDescriptor[] = [
  {
    id: `${PACKAGE_NAME}#${STATS_NAMESPACE}/stats`,
    service: STATS_NAMESPACE,
    namespace: STATS_NAMESPACE,
    method: "stats",
    invocation: { kind: "direct" },
    parameters: [],
    result: { mode: "src-json" },
  },
];

/** `ctx.remote` 的读取面：本卡只用 `$mount` 一位 + 挂上之后的那个命名空间。
 *  按方法面投影而不是收整条官方接口：官方 `TypertClientRemote` 还带 `$on` 与每一门命名空间的
 *  索引签名，而本卡不订阅任何转发事件（见下面的读取策略）。 */
export interface RemoteFace {
  $mount: (contribution: {
    package: string;
    descriptors: readonly InvocationDescriptor[];
  }) => Promise<unknown>;
  dangerGuardStats: {
    stats: () => Promise<RemoteResult<StatsSnapshot>>;
  };
}

/** 声明进官方的命名空间映射（与 `SlotMap` / `LocaleNamespaceMap` 同一条：合并式扩展）。
 *  生成器发射的就是这一条，我们手写它 —— 少了它 `ctx.remote.dangerGuardStats` 不成立。 */
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface TypertRemoteNamespaceMap {
    dangerGuardStats: RemoteFace["dangerGuardStats"];
  }
}

/**
 * 读一次宿主侧的判定统计。
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
 * @param remote - 客户端上下文里的远程面（`ClientCtx.remote`）
 * @returns 宿主侧统计快照
 */
export function createStatsReader(remote: RemoteFace): () => Promise<StatsSnapshot> {
  let mounted: Promise<unknown> | undefined;
  return async () => {
    mounted ??= remote.$mount({ package: PACKAGE_NAME, descriptors: STATS_DESCRIPTORS });
    await mounted;
    const result = await remote.dangerGuardStats.stats();
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`);
    }
    return result.value;
  };
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

/** 按键的次数降序取前 `limit` 格（并列时按键名字典序，保证同一份快照渲染稳定）。 */
export function topLines(counts: Readonly<Record<string, number>>, limit: number): StatsLine[] {
  return Object.entries(counts)
    .toSorted(([leftKey, left], [rightKey, right]) =>
      right === left ? leftKey.localeCompare(rightKey) : right - left,
    )
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}
