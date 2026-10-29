# 危险命令拦截

在破坏性命令动手前拦下它，并要求一个文件在本会话第一次被修改前先留下证据。

## 设置卡上改的是什么

- **拦截** — `enabled`（默认开）关掉后所有命令直接放行；`factGateEnabled`（默认开）要求某文件第一次被改前先读过它、并做过一次引用检索，严格程度按风险档走。
- **判定与放行** — `judgeStats`（默认开）只采集每次判定的耗时，不改变任何规则。`maxDenies`（1–5，默认 2）决定连续几次「零证据拒绝」之后放行写入。`strictMode`（默认关）开了就不看档位，每个文件都跑完整探查。
- **分级规则** — `smallEditChars`（200）与 `bigEditChars`（2000）划出低档与高档的边界。`refSearchTools`（`grep`、`glob`、`zg_search`）列出哪些工具算引用检索证据；`refSearchStrictTools`（`zg_search`）里的那些额外按「根目录 + 路径签名」的严格口径判。
- **你自己的词表** — `extraTestDirs`、`extraDevServerWords`、`extraDevRunArgs` 扩充测试层目录、开发服务器与开发命令的识别；`extraSecretPatterns` 追加密钥正则，装载时编译，编译不过的会在日志里点名而不是静默丢弃。

卡上这些档都是每次判定现读，改完下一次调用就生效，不需要重启宿主。

## 要重启的，以及卡上没有的

卡上能改的值都不需要重启：写入后下一次判定就按新值读。

有一档卡上没有旋钮：`preflightEnabled` 标了即时生效，但设置条目以 `auto: false` 注册表单。要改它只能走设置行的 `config:`。

## 需要外部提供什么

不需要任何本插件给不了的东西：没有外部 CLI、没有解释器、没有凭据。`zg_search` 只有在装了「Zvec 索引检索」插件时才存在。

## 更完整的说明

规则词表、四种权限预设的差别、沙箱让位边界都写在随包的 README（`README.md` / `README.zh-CN.md`）。
