#!/data/user/0/com.dsh.nextapp1/t/usr/bin/bash
# dsh web 启动脚本 —— 由 DshLauncher 渲染 assets/web-launcher.sh.tpl 生成，勿手改
# 渲染占位符：EXPORTS / HOME / NODE_CMD / LOG_FILE（渲染时按字面量全局替换）
# ★ 本注释行**不得**出现 @TOKEN@ 形式的字面量：渲染是全局替换，注释里的 token 会被
#   展开成多行内容 —— 后果是 export 块重复一遍，并多出一行「把 HOME 路径当命令执行」
#   的垃圾（真机现象：dsh-web.sh line 11 报 "Is a directory"）。历史上就是这里踩的坑。
@EXPORTS@
# 应用进程默认 cwd=/（不可写）：显式 cd 到可写 HOME（dsh 状态目录 files/.dsh 也在这里）
cd "@HOME@" || exit 1
# 内置 Termux bash 必带 nohup，直接后台化
nohup @NODE_CMD@ > "@LOG_FILE@" 2>&1 &
echo DSH_WEB_PID=$!
