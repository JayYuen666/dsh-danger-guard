// lib/projection-reader.ts —— 会话投影的**双协议**挂载：旧宿主交回 disposer，新宿主交回 handle。
//
// 为什么单列：host.ts 顶着 `eslint/max-lines` 的 2000 行预算，而这一段是自成一体的一次判断
//（一次注册、形状分流、发布读口、卸载释放），与判定链没有别的关系。
//
// ⚠ 判别只能发生在 **`await` 之后**：两版 `register()` 的原始返回值都是函数——新宿主那份是
// 「可调用 + 可等待」的合成值，旧宿主那份的 `fiber.effect` 结果同样带 `then`。所以在 await
// 之前比较 `typeof`、查 `.then`、或 `instanceof Promise` 都分不开；await 之后旧版得到
// disposer（函数）、新版得到带 `stateOf`/`dispose` 的对象，那才是可靠的分流点。
//
// ⚠ 分流**先判 handle**：`isDisposer` 只认"是函数"，而 handle 的判据要求两个方法都在。
// 反过来判时，一个可调用的 handle 会先命中旧协议分支，读口落到新版注册表上已弃用的
// `stateOf(session, key)`，读错来源且不报错。

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

/** 新版注册的结果：可读、可释放。判据只看这两位方法在不在，**不看可调用性**——宿主当前的
 *  handle 是对象，但可调用性本是旧协议（disposer）的唯一判据，把它同时当成排除条件时，
 *  一份「可调用 + 带 stateOf/dispose」的合成值会掉进旧读口，去调注册表上已弃用的
 *  `stateOf(session, key)`，读错来源且不报错。 */
const isProjectionHandle = (value: unknown): value is ProjectionHandle =>
  (typeof value === "object" || typeof value === "function") &&
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
  let ready: unknown;
  try {
    ready = await registry.register(toolLedgerProjection);
  } catch (error) {
    console.warn(
      `[danger-guard] sessionProjections register failed, falling back to log scan: ${String(error)}`,
    );
    return;
  }
  // 先判更强的形状：新版 handle 必须带两个方法，而"可调用"只说明它是函数。宿主若交回
  // 一个**同时可调用**的 handle（函数对象上挂着 stateOf/dispose），先判 `isDisposer` 会
  // 把它当旧协议，转去调 `registry.stateOf(session, key)` —— 新版注册表上那一位是已弃用
  // 的兼容读口，读错来源也不会有任何报错。
  if (!isProjectionHandle(ready) && !isDisposer(ready)) {
    // 形状不符与注册抛错是两种故障：分开记，排障时才分得清"宿主换了协议"与"注册真的报错"。
    console.warn(
      "[danger-guard] sessionProjections.register returned neither a disposer nor a handle, falling back to log scan",
    );
    return;
  }
  let read: (session: unknown) => unknown;
  let release: () => void;
  if (isProjectionHandle(ready)) {
    read = (session) => ready.stateOf(session);
    // 新版释放是异步的：拒绝要接住并记录。调用本身留在当前拍上（卸载顺序要可观察），
    // 同步抛出与异步拒绝都在这里收口，不把异常留给外层卸载清理链路。
    release = () => {
      void (async () => {
        try {
          await ready.dispose();
        } catch (error) {
          console.warn(`[danger-guard] sessionProjections dispose failed: ${String(error)}`);
        }
      })();
    };
  } else {
    read = (session) => registry.stateOf(session, LEDGER_KEY);
    release = ready;
  }
  // 读口本身也要兜底：宿主 `stateOf` 抛错时交回"没有可信台账"，让判定照常回退扫描，
  // 而不是把异常冒进同步判定链。
  face.publish((session) => {
    try {
      return asLedger(read(session));
    } catch (error) {
      console.warn(
        `[danger-guard] sessionProjections stateOf threw, falling back to log scan: ${String(error)}`,
      );
      return asLedger(undefined);
    }
  });
  try {
    face.effect(() => {
      // 一次性闸门：宿主重复调用 disposer 时不能二次撤口/二次释放。
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        try {
          face.publish(undefined);
        } finally {
          release();
        }
      };
    });
  } catch (error) {
    // 卸载收尾没挂上：读口已经发布，必须自己撤下并释放，否则插件卸载后仍参与判定。
    face.publish(undefined);
    release();
    console.warn(
      `[danger-guard] sessionProjections effect registration failed, reader withdrawn: ${String(error)}`,
    );
  }
}
