// lib/command-segments.ts —— 把一条 shell 源切成**顶层段**的那一刀：分隔符表 + 引号/转义感知。
//
// 为什么从 lib/danger-rules.ts 拆出来：四类规则问的都是"这一段命令是什么形状"，而"段在哪里
// 断开"是它们共同的前置问题——边界集合（传统分隔符之外还要收 `(`、`)`、反引号）决定
// `echo $(rm -rf /)`、`` echo `rm -rf ~` `` 里的 rm 到底进不进任何一段的视野。这一层与
// "命中哪条规则"无关，故与 danger-rules.ts 分家；此前它 export 只是因为单测也按这条边界取用，
// `fallow --production` 于是把它判成「只被测试养着的导出」。
//
// 生产消费者 = lib/danger-rules.ts 的 commandDanger（逐段判定前先在这里断段）。

/** 顶层段边界字符：传统分隔符之外，`(`/`)`/反引号**同样**是边界。 */
const SEG_SEPARATORS = new Set([";", "\n", "\r", "&", "|", "(", ")", "`"]);

/**
 * 把命令串切成顶层段。边界 = `; && || | 换行 &` **加上** `(`、`)`、反引号：
 * 子 shell / 命令替换的**体内**命令必须成为独立段，否则 `echo $(rm -rf /)`、
 * `` echo `rm -rf ~` `` 里的 rm 永远进不了任何一段（旧实现把括号体整块豁免，
 * 于是"括号包起来的危险命令"成了结构性漏拦面）。括号自身字符留在相邻段里，
 * 不参与命令头匹配，无副作用。
 * **切 | 但管道语义保留**：管道符是段边界（`||` 的第二根也是），但切出的段只做
 * "分段归因"——pipeToShell 在调用方被显式喂"整条含管命令"（见 commandDanger），
 * curl|sh 的判定仍在完整管道视野里完成。
 * 豁免：单/双引号内一律不切。引号外的 `\` 转义下一字符，其中 `\<换行>` 是 shell
 * 续行（把两行接成一个词），整对丢弃——`rm -rf \<换行> /` 不再被拆成两段。
 * 保守近似：引号未闭合（畸形输入）时其后内容按引号内处理，整段不再切分；
 * 双引号内的 `$( )` 在真实 shell 里会展开执行，本实现按引号内处理（不切）。
 */
export function splitTopLevel(command: string): string[] {
  const segs: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  const flush = (): void => {
    segs.push(cur);
    cur = "";
  };
  for (const ch of command) {
    if (escaped) {
      escaped = false;
      if (ch === "\n") {
        // 续行：把刚收下的 `\` 也退回去，两行接成一个词
        cur = cur.slice(0, -1);
      } else {
        cur += ch;
      }
    } else if (quote !== null) {
      cur += ch;
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === "\\") {
      escaped = true;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (SEG_SEPARATORS.has(ch)) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return segs.map((seg) => seg.trim()).filter((seg) => seg.length > 0);
}
