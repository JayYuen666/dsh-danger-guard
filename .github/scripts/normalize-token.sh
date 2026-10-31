#!/usr/bin/env bash
# 凭据清洗的唯一实现：从 stdin 读原始 secret，输出剔除换行与空白后的值。
#
# 预检与发布两步都必须在各自的 shell 里就地调用它，而不是把清洗后的值跨步骤传递：
# 步骤输出会落成 RUNNER_TEMP 下的文件，同 job 的依赖脚本也能读到，等于把凭据落盘。
# 两份拷贝各自演进时，一处改了另一处没改，会出现「whoami 通过、publish 401」。
set -euo pipefail
tr -d '\r\n[:space:]'
