package com.dsh.launcher.core

import java.io.File

/**
 * 解压期符号链接目标白名单（纵深防御，对齐参考实现坑 45 `isLinkTargetAllowed`）。
 *
 * 背景：Termux 运行时归档里有大量符号链接（`libcrypto.so -> libcrypto.so.3`），
 * 必须真实创建——写成 0 字节空文件会让动态库加载静默失败。但归档是**外部输入**，
 * 链接目标可以指向解压根之外（`../../`逃逸）或任意绝对路径；一旦跟随这些链接写入
 * 或执行，等于把 app 私有目录的写面/执行面暴露给归档内容。
 *
 * 参考实现踩过的具体形态（坑 45）：快照含 9 个**指向本应用运行时根**的绝对链接
 * （`files/usr/bin/{vi,view,vim,...}` → `libexec/...`），其严格版校验只在 `dest`
 * 内放行，导致暂存目录解压时**静默丢弃**这 9 条 → applet 缺失。教训是
 * 「校验既要拒绝逃逸，也不能误伤合法的绝对链接」。
 *
 * 本项目的边界：
 * - **相对目标**：以链接自身所在目录为基准规范化，必须仍在**解压根**内
 *   （`files/node`）——`../` 逃逸一律拒绝。
 * - **绝对目标**：必须落在**本应用数据目录**内（`/data/user/0/<pkg>` 及其
 *   `/data/data/<pkg>` 别名）。这样既放行指向自身运行时的合法链接
 *   （含短前缀 `/data/user/0/<pkg>/t/...`——注意 `t` 本身即 `usr` 的别名），
 *   也拒绝 Termux 残留（`/data/data/com.termux/...`）与任何系统路径。
 *
 * 纯函数设计：不碰文件系统，便于单测覆盖全部边界组合。
 */
object SymlinkPolicy {

    sealed interface Decision {
        /** 允许创建。 */
        object Allow : Decision

        /** 拒绝创建，原因用于日志与门禁。 */
        data class Reject(val reason: String) : Decision
    }

    /**
     * @param linkPath  链接自身的绝对路径
     * @param target    归档声明的链接目标（相对或绝对）
     * @param extractRoot 本次解压的根目录（相对目标不得逃出它）
     * @param appRoot   本应用数据目录（绝对目标必须落在其内）
     */
    fun classify(
        linkPath: String,
        target: String,
        extractRoot: String,
        appRoot: String,
    ): Decision {
        if (target.isBlank()) return Decision.Reject("空目标")

        val extract = normalize(extractRoot)
        val app = normalize(appRoot)

        return if (isAbsolute(target)) {
            val t = normalize(target)
            when {
                isWithin(t, extract) -> Decision.Allow
                isWithin(t, app) -> Decision.Allow
                else -> Decision.Reject("绝对目标越出应用数据目录：$t")
            }
        } else {
            // 相对目标：相对链接所在目录解析后再规范化（并处理 .. 逃逸）
            val parent = normalize(File(linkPath).parent ?: extract)
            val t = normalize("$parent/$target")
            if (isWithin(t, extract)) Decision.Allow
            else Decision.Reject("相对目标逃出解压根：$target -> $t")
        }
    }

    /** 是否为绝对路径（POSIX：以 / 开头即绝对）。 */
    internal fun isAbsolute(path: String): Boolean = path.startsWith("/")

    /**
     * 纯路径规范化（等价 `path.normalize()`）：折叠 `.`/`..` 与重复分隔符。
     * 刻意**不**做 realpath——链接目标尚不存在，且规范化不触碰文件系统。
     */
    internal fun normalize(path: String): String {
        val abs = isAbsolute(path)
        val out = ArrayList<String>()
        for (seg in path.split('/')) {
            when (seg) {
                "", "." -> {}
                ".." -> {
                    // 绝对路径上越过根即停在根（/.. == /）；相对路径保留前导 ..
                    if (out.isNotEmpty() && out.last() != "..") out.removeAt(out.size - 1)
                    else if (!abs) out.add("..")
                }
                else -> out.add(seg)
            }
        }
        val joined = out.joinToString("/")
        return when {
            abs -> "/$joined"
            joined.isEmpty() -> "."
            else -> joined
        }
    }

    /**
     * child 是否等于 base 或位于 base 之内。
     *
     * 必须按**路径段**比较而非字符串前缀——否则 `/files2/x` 会被误判为在
     * `/files` 之内（经典前缀混淆缺陷）。参考实现坑 1「realpath 前缀混用」
     * 属同族问题：路径归属判断一律按段。
     */
    internal fun isWithin(child: String, base: String): Boolean {
        if (child == base) return true
        // 根目录特殊：/a 位于 / 之内
        if (base == "/") return isAbsolute(child)
        return child.startsWith("$base/")
    }
}
