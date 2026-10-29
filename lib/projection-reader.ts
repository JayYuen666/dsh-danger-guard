// lib/projection-reader.ts —— 会话投影的**双协议**挂载：旧宿主交回 disposer，新宿主交回 handle。
//
// 为什么单列：host.ts 顶着 `eslint/max-lines` 的 2000 行预算，而这一段是自成一体的一次判断
//（一次注册、形状分流、发布读口、卸载释放），与判定链没有别的关系。
//
// ⚠ 判别只能发生在 **`await` 之后**：两版 `register()` 的原始返回值都是函数——新宿主那份是
// 「可调用 + 可等待」的合成值，旧宿主那份的 `fiber.effect` 结果同样带 `then`。所以在 await
// 之前比较 `typeof`、查 `.then`、或 `instanceof Promise` 都分不开；await 之后旧版得到
// disposer（函数）、新版得到带 `stateOf`/`dispose` 的对象，那才是可靠的分流点。

import { asLedger, LEDGER_KEY, toolLedgerProjection } from "./tool-ledger.ts";

/**
 * `ctx.sessionProjections` 的本包读面。`stateOf` 的第一参按 `unknown` 收（官方钉名义类
 * `Session`，替身会话永远满足不了）；`register` 的返回域按 `unknown` 收，理由见文件头。
 */
export interface ProjectionsRegistry {
  register: (definition: typeof toolLedgerProjection) => unknown;
  stateOf: (session: unknown, key: typeof LEDGER_KEY) => unknown;
}

/** 新版注册的结果：`await register()` 之后拿到的那一枚。 */
interface ProjectionHandle {
  readonly stateOf: (session: unknown) => unknown;
  readonly dispose: () => Promise<void> | undefined;
}

/** 旧版注册的结果就是 disposer 本身。 */
const isDisposer = (value: unknown): value is () => void => typeof value === "function";

/** 新版注册的结果：可读、可释放。 */
const isProjectionHandle = (value: unknown): value is ProjectionHandle =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { stateOf?: unknown }).stateOf === "function" &&
  typeof (value as { dispose?: unknown }).dispose === "function";

/** 挂载这一段要的外部动作：发布/撤下读口，以及注册一条随插件卸载的收尾。 */
export interface LedgerReadFace {
  /** 传 `undefined` 表示撤下读口（卸载时的第一步）。 */
  readonly publish: (reader: ((session: unknown) => unknown) | undefined) => void;
  /** 注册一条随插件卸载的收尾；收尾可以异步（新宿主的释放是异步的）。 */
  readonly effect: (factory: () => () => void) => unknown;
}

/**
 * 注册投影并把可信读口发布出去。
 *
 * 发布时机：**注册成功之后**。新宿主的注册可能异步失败，那时先发布出去的读者会永远读到
 * `undefined`，闸门却以为自己有台账；注册失败与注册表缺席同档——整条判定回退扫描。
 *
 * 卸载顺序：先撤对外读口、再释放这次注册。新宿主的 handle 释放后**仍可读**，留着它等于让
 * 已卸载的插件继续参与判定。
 *
 * @param registry 宿主注入的投影注册表
 * @param face 发布读口与挂卸载收尾的两个动作
 */
export async function mountLedgerReader(
  registry: ProjectionsRegistry,
  face: LedgerReadFace,
): Promise<void> {
  let read: (session: unknown) => unknown;
  let release: () => void;
  try {
    const ready: unknown = await registry.register(toolLedgerProjection);
    if (isDisposer(ready)) {
      read = (session) => registry.stateOf(session, LEDGER_KEY);
      release = ready;
    } else if (isProjectionHandle(ready)) {
      read = (session) => ready.stateOf(session);
      // 新版释放是异步的，但这条路径上没有任何东西需要等它：`dispose()` 的拒绝由宿主那一侧
      // 自己报告，这里显式丢弃 promise（`void` 是 lint 认可的写法）。要等它的场合在官方那边
      // 是「卸载完成」的语义，本插件卸载时已经没有后续判定了。
      release = () => {
        void ready.dispose();
      };
    } else {
      throw new TypeError("sessionProjections.register 交回了既非 disposer 也非 handle 的形状");
    }
  } catch (error) {
    console.warn(
      `[danger-guard] sessionProjections register failed, falling back to log scan: ${String(error)}`,
    );
    return;
  }
  face.publish((session) => asLedger(read(session)));
  face.effect(() => () => {
    face.publish(undefined);
    release();
  });
}
