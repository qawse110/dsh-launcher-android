#!/data/user/0/com.dsh.launcher/t/bin/bash
# ↑ 短前缀 `t` **已等价于 `usr`**（t -> files/termux/usr），故正确路径是 t/bin/bash。
#   写成 t/usr/bin/bash 会多一层 usr → bad interpreter（真机实测 exit=126）。
#   PrefixPatcher 用等长替换把官方前缀 /data/data/com.termux/files/usr（31 字符）
#   换成 /data/user/0/com.dsh.launcher/t（31 字符），只跳一次链接。
# dsh web 启动脚本 —— 由 DshLauncher 渲染 assets/web-launcher.sh.tpl 生成，勿手改
# 模板内共有四个占位符（导出集、HOME、node 命令、日志文件），按顺序被 DshFlow 替换；
# 注意：本注释**不得**写出占位符字面量——渲染是纯字符串 replace，会连注释里的
# 一起展开，把注释行变成一条真实执行的杂散命令（已在真机 dsh-web.sh 上实测）。
@EXPORTS@
# 应用进程默认 cwd=/（不可写）：显式 cd 到可写 HOME（dsh 状态目录 files/.dsh 也在这里）
cd "@HOME@" || exit 1
# 内置 Termux bash 必带 nohup，直接后台化
nohup @NODE_CMD@ > "@LOG_FILE@" 2>&1 &
echo DSH_WEB_PID=$!
