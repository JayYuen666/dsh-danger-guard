// lib/secret-patterns.ts —— 用户扩展密钥模式的**校验与编译**（零宿主依赖、零词表依赖）。
//
// 为什么单列一枚模块：这一层有两个读者，而它们住在不同的产物里——设置条目要在**装配时**
// 校验并点名非法片段（`lib/secret-pattern-report.ts`），拦截半要在匹配前拿到编译好的正则
// （`lib/danger-rules.ts` 的 `secretRegexes`）。留在词表模块里就等于让设置条目去 import
// 整份拦截规则，产物里多出一棵它从不读的子树（实测 `settings.js` 从 3.5 KB 预算涨到 6.5 KB，
// 撞在本包的产物体积门上）。拆出来之后两侧读的都是这一枚小模块，判据仍然只有一份。
import { isSlashPatternLiteral } from "./danger-regexes.ts";
import { lruPut } from "./lru.ts";

/** 用户扩展模式的编译结果（合法的要能用、非法的要知道是哪条——静默跳过等于让用户以为保护已生效）。 */
export interface SecretPatternPartition {
  accepted: string[];
  rejected: string[];
}

/** 单条扩展模式的长度上限：正则本身的病（灾难回溯）没法静态判定，但"超长"是配置写错的
 *  最强信号，先按长度收一道，剩下的口径写在 README 的「扩展模式由配置者自负」。 */
const MAX_SECRET_PATTERN_LENGTH = 512;

/**
 * 是不是被写成了 JS 正则**字面量**（`/…/` 或 `/…/gi`）。
 *
 * 判据刻意窄到"只认整串被一对斜杠包住"这一种形状：模式本身常含斜杠（`secrets/prod\.env$`），
 * 所以不能只看到斜杠就拒。这里要求「首字符是 `/`、末字符是 `/`」——那是把路径分隔符写在
 * 两端的写法（如 `/etc/shadow`），而用户要的语义正是"匹配这个片段"，
 * 此时该写 `^/etc/shadow$` 而不是用斜杠当定界符。真正带 flags 的形状（`/x/i`）与
 * 「首尾都是斜杠」两种都拒，且都给出同一条可读理由。
 */
function looksLikeRegexLiteral(pattern: string): boolean {
  const first = pattern.at(0);
  const last = pattern.at(-1);
  if (first !== "/") {
    return false;
  }
  if (last === "/") {
    return true;
  }
  return isSlashPatternLiteral(pattern);
}

/** 一份清单的校验结果与编译好的匹配正则（不含内置那一枚，由调用方前缀）。 */
interface CompiledSecretPatterns extends SecretPatternPartition {
  readonly regexes: readonly RegExp[];
}

/** 内容相同的清单只编译一次：判定链每次现读设置值，逐次重编译就是把加载期的活儿搬到
 *  工具调用的同步主路径上重做。键是清单的 JSON 形（模式串里的任何字符都参与成键，不存在
 *  拼分隔符才会撞键的那种形状），换值即换键、自然重编，所以这里没有「改了配置不生效」那一档。
 *  容量按「一次会话里被反复读到的那几份清单」取，淘汰交给 `lruPut`。 */
const compiledByPatterns = new Map<string, CompiledSecretPatterns>();
const SECRET_PATTERN_CACHE_CAP = 8;

function buildCompiledSecretPatterns(patterns: readonly string[]): CompiledSecretPatterns {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const pattern of patterns) {
    if (pattern.length === 0 || pattern.length > MAX_SECRET_PATTERN_LENGTH) {
      rejected.push(pattern);
    } else if (looksLikeRegexLiteral(pattern)) {
      // 写成 `/…/i` 的形状**编得过**（首尾的斜杠只是普通字符、尾部 `i` 也是普通字符），
      // 于是它不会进 rejected、界面上看不到「本条未生效」，却永远匹配不到任何路径 ——
      // 用户以为开了保护，密钥面静默失效。这类输入必须点名拒掉，不能靠编译期抛错。
      rejected.push(pattern);
    } else {
      try {
        accepted.push(new RegExp(pattern, "u").source);
      } catch {
        rejected.push(pattern);
      }
    }
  }
  // **逐条独立编译、独立匹配**。不拼成一个大正则：拼接会改变捕获组编号与反向引用语义
  //（`(b)\1` 里的 `\1` 会指向前面模式的分组），还会让重复命名组在部分运行时组合失败。
  const regexes: readonly RegExp[] = accepted.map((pat) => new RegExp(pat, "iu"));
  return { accepted, rejected, regexes };
}

function compileSecretPatterns(patterns: readonly string[]): CompiledSecretPatterns {
  const key = JSON.stringify(patterns);
  const hit = compiledByPatterns.get(key);
  if (hit !== undefined) {
    lruPut(compiledByPatterns, key, hit, SECRET_PATTERN_CACHE_CAP);
    return hit;
  }
  const compiled = buildCompiledSecretPatterns(patterns);
  lruPut(compiledByPatterns, key, compiled, SECRET_PATTERN_CACHE_CAP);
  return compiled;
}

/**
 * 逐条试编译用户给的密钥模式：`new RegExp(pat, "u")` 抛错、长度为空或超限、或写成正则字面量的
 * 进 `rejected`。这是**加载期校验**的谓词（设置条目 apply 时调用一次并把 rejected 报出来，
 * 见 settings-host.ts；判定链里的补报走同一个函数，两侧不可能给出不一致的模式集合）。
 *
 * 交回的是新数组——调用方就地改写不会污染同一份清单的下一次读数。
 */
export function partitionSecretPatterns(patterns: readonly string[]): SecretPatternPartition {
  const compiled = compileSecretPatterns(patterns);
  return { accepted: [...compiled.accepted], rejected: [...compiled.rejected] };
}

/** 用户配置的密钥正则（`iu` 标志），按清单内容复用编译结果；内置那一枚由调用方前缀。 */
export function userSecretRegexes(patterns: readonly string[]): readonly RegExp[] {
  return compileSecretPatterns(patterns).regexes;
}
