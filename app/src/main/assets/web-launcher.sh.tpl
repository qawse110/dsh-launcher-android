#!/data/user/0/com.dsh.launcher/t/usr/bin/bash
# dsh web 启动脚本 —— 由 DshLauncher 渲染 assets/web-launcher.sh.tpl 生成，勿手改
# 可用占位符：@EXPORTS@ @HOME@ @NODE_CMD@ @LOG_FILE@
@EXPORTS@
# 应用进程默认 cwd=/（不可写）：显式 cd 到可写 HOME（dsh 状态目录 files/.dsh 也在这里）
cd "@HOME@" || exit 1
# 内置 Termux bash 必带 nohup，直接后台化
nohup @NODE_CMD@ > "@LOG_FILE@" 2>&1 &
echo DSH_WEB_PID=$!
