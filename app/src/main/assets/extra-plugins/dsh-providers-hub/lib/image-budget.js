/**
 * 请求图片的像素预算（issue !IKITT9）。
 *
 * ## 为什么需要它
 *
 * 本插件九个适配器原先一律把附件的**原始字节**内联成 data URL 发出去，
 * 从不按预算缩放。于是一个长会话里积累的截图会把网关的
 * 「单次请求图片视觉 token 总量」顶穿，实测报文：
 *
 * ```
 * {"code":11115,"msg":"prompt is too long: 100001 tokens > 100000 maximum"}
 * ```
 *
 * ⚠️ **这个 100000 不是上下文窗口**（`src/product.ts` 给该模型声明的是
 * 1,000,000，而同一会话纯文本 prompt 到 345,687 仍被正常接受 —— 由报障者
 * 本机 11,351 次成功请求统计证实：图片 token 无一越过 10 万）。
 * 它约束的是**一次请求的图片总量**，所以唯一的出路是让每张图变小。
 *
 * ## ⚠️⚠️ 报文里的 `100001` 是**常量哨兵**，不能用来反推 token 数
 *
 * （issue IKKX0T 订正，2026-10-12，本仓库用纯算术独立复核）
 *
 * 上面那句报文里的 `100001` **恒等于 `limit + 1`** —— 它是「**已越界**」的
 * 固定写法，**与张数无关**。实测证据：同一次运行里 12 / 15 / 20 三档失败
 * 报的**都是 `100001`**；而张数涨了 67%，实算 token 必然同步变化，
 * 不可能三次恰好相同。
 *
 * ⇒ **任何「用 N 反推每张多少 token」的推导都是错的**，而且错得不明显。
 * 本仓库曾因此写出「buddy 15 张撞 100,000 时估算 99,579，差 0.4%」这种
 * **巧合式吻合**（把只在小图上成立的 617 px/token 线性外推到 4.1M px，
 * 恰好凑到 10 万附近）—— 该说法已删除，别再加回来。
 * 要测每张的真实成本，**只能读成功请求的 `usage`**
 * （见 `tests/e2e/image-probe-shared.ts` 的 `BurstResult.usage`）。
 *
 * ## 为什么做成「每张固定预算」而不是「按本次张数分摊」
 *
 * 附件服务的请求版本是**确定性且带缓存**的：缓存身份包含附件 id、变换版本、
 * 目标尺寸与字节目标（见 `@deepseek-ai/dsh-attachment` 的 `readImageRequest`）。
 * 若目标尺寸随「这条会话现在有几张图」浮动，同一个附件在不同请求里会派生出
 * 不同的 `variantId` → 缓存反复击穿、每次重编码，而且用户无法预测一张图
 * 到底会被缩成多大。固定预算换来的是确定性、可缓存、可单测。
 *
 * 本模块只提供**纯几何**，实际缩放交给附件服务（它负责 alpha 路由、
 * JPEG/WebP 质量阶梯与字节目标），避免在这里重复实现一遍编码器。
 */
/**
 * 内联图片的编码字节目标，取 **2 MiB**。
 *
 * 与 `dsh-llm-deepseek` 的 `DEFAULT_REQUEST_IMAGE_MAX_BYTES` 同值 —— 那是
 * harness 里唯一可参照的权威默认值。本插件的图片是 base64 内联（CodeBuddy
 * 只接受 `image_url` data URL，`{type:'image'}` 会被 400 拒绝），所以字节
 * 目标还额外决定了请求体大小；640K 像素的截图经 JPEG 后通常远小于此值，
 * 这个上限只对本就是小图高压缩率的极端情况起作用。
 */
export const REQUEST_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * raccoon 的单张编码字节目标：**512 KB**（issue !IKITT9 的 raccoon 变体）。
 *
 * 依据是实测的 `HTTP_413: request body exceeds 10MB` —— 那是一家按
 * **请求体字节**设限的网关，与腾讯的「图片视觉 token 总量」是两种约束。
 * 完整的算术与「为什么不做成按张数分摊」的权衡记在
 * `src/raccoon-product.ts` 的 `imageMaxBytes` 上（结论由用户 2026-09-28 定）。
 */
export const RACCOON_REQUEST_IMAGE_MAX_BYTES = 512 * 1024;
/**
 * 其余按**请求体体积**设限的网关用的字节目标：**1 MiB**。
 *
 * 依据是本轮实测的撞墙张数（fixture 每张 base64 后 ≈3.8 MiB）：
 *
 * | provider | 实测边界 | 原图请求体 |
 * |---|---|---|
 * | qoder | 8 张过 / 15 张 `TRANSPORT` | ≈57 MiB |
 * | lobsterai | 12 张过 / 13 张 `SERVER 500` | ≈50 MiB |
 * | cline | 24 张过 / 32 张 `TRANSPORT` | ≈122 MiB |
 *
 * 取 1 MiB 后每张 base64 后 ≈1.33 MiB：qoder 与 lobsterai 即使攒到 24 张
 * 也只有 ≈32 MiB，**远低于**它们各自的实测边界；而 1 MiB 对 1011×632 的
 * 缩放图来说相当宽松（附件服务只在超出目标时才降质量阶梯），
 * 所以"缩放的代价"几乎全落在像素上、不额外落在字节上。
 *
 * ⚠️ 与 raccoon 的 512 KB **不同值是有意的**：那家硬限 10 MB，
 * 1 MiB 目标下 10 张就到 13 MB 会照样 413。别合并成一个常量。
 *
 * ## ⚠️⚠️ 这个常量**必须被显式赋值到每个按体积设限的家**（2026-10-12 修）
 *
 * 它**不是** `requestImageTargetFor` 的默认参数 —— 那里的默认是
 * {@link REQUEST_IMAGE_MAX_BYTES}（**2 MiB**），因为默认值服务的是**腾讯系**
 * 那道「图片 token 预算」（字节不是它的约束）。
 *
 * **真实缺陷**：`qoder` / `qodercn` / `cline` / `lobsterai` 四家的 product 与
 * `index.ts` 里 zcode 的构造**都忘了赋这个字段**，于是生效的是 2 MiB ——
 * 而本常量除定义处外**零引用**（死代码），四家的接口注释却都写着「1 MiB」。
 * 后果不是「慢一点」而是**越过上游硬限**：qoder 在报错原文里写明
 * `maximum allowed 52428800 bytes`（50 MiB），而 24 张 × 2 MiB × 4/3 = **64 MiB**。
 *
 * ⇒ 取值方向是**显式赋值**（不是把默认参数改成 1 MiB —— 那会改变腾讯系的行为）。
 * 守卫见 `tests/unit/image-budget.spec.ts` 的「按体积设限的家必须显式给
 * imageMaxBytes」段（对**实际生效的字节目标**断言，而非源码文本）。
 */
export const DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES = 1024 * 1024;
/**
 * 单张请求图片的默认像素预算：**640,000 px**（约合 1050×610）。
 *
 * ## 取值依据（issue !IKITT9 的失败点反推）
 *
 * 网关按 ≈ **617 px / 视觉 token** 计价（1721×997 = 1,716,237 px ≈ 2,781 token），
 * 于是 640,000 px ≈ **1,037 token/张** → 10 万 token 的预算约能容纳 **96 张**
 * （原先 36 张就顶穿了）。留出这个余量是因为截图张数在 agent 会话里
 * 会不受控地增长，而顶穿的后果是**整个会话报废**。
 *
 * ## ⚠️⚠️ 「约 96 张」这个余量是按**最乐观**的比例算的（issue IKKX0T）
 *
 * 617 px/token **只在小图上成立**。把两组实测摆在一起（都按上限 10 万夹）：
 *
 * | 尺寸 | 像素 | 实测边界 | 反推每张 token | px/token |
 * |---|---|---|---|---|
 * | 1721×997 | 1,715,837 | 35 过 / 36 挂 | ≈2,778 ~ 2,857 | **601 ~ 618** |
 * | 2560×1600 | 4,096,000 | 10 过 / 12 挂 | ≈8,333 ~ 10,000 | **410 ~ 492** |
 *
 * 面积涨 **2.39×**，每张 token 成本涨了 **≈3.25×** ⇒ 每 px 单价在大图上
 * **劣化约 1.36×**（典型的分块/上采样计价）。
 *
 * ⇒ **对本预算的实际影响**：缩放后的图是 **1011×632**，尺寸介于上表两档之间，
 * 故真实比例落在 **410~618 px/token** 这个区间里 —— 「能容纳 96 张」是区间
 * 的**乐观端**；按悲观端（410）算只有约 **64 张**。
 * ⚠️ **这不是「预算定错了」，而是「余量没有原先写的那么宽裕」**：
 * 640,000 px 这个值本身有独立的正当性（1011×632 上 UI 小字仍可辨认，
 * 是作者明确要求的档位），且 64 张仍远高于踩坑时的 36 张。
 * 但引用余量时**必须带上这个区间**，不要再单说「约 96 张」。
 *
 * ⚠️ **要钉死它**：从**成功**请求里读 `usage.prompt_tokens`，测 1/5/10 三档
 * 拟合真实每张成本（缩放档再测一次）。探针已能采集该字段
 * （`tests/e2e/image-probe-shared.ts` 的 `BurstResult.usage`）。
 *
 * ⚠️ 不要把它调得过小：UI 小字、终端输出这类截图全靠像素辨认，
 * 作者明确要求「1050×610 上 UI 小字仍可辨认」的档位。
 */
export const DEFAULT_IMAGE_PIXEL_BUDGET = 640_000;
/**
 * 按「总像素预算」把尺寸缩小到预算内，保持宽高比、**绝不放大**。
 *
 * 与 `@deepseek-ai/dsh-attachment` 导出的纯函数 `requestImageDimensions`
 * 同语义（那边也是 `maxPixels` 总面积口径），因此换成 harness 的路由不会产生
 * 第二种几何。
 *
 * @returns 目标尺寸；输入非法（非有限正数）时返回 `undefined`，
 *          调用方据此**回退原图**而不是发一个坏请求。
 */
export function fitImageToPixelBudget(width, height, maxPixels) {
    if (!isPositiveFinite(width) || !isPositiveFinite(height))
        return undefined;
    if (!isPositiveFinite(maxPixels))
        return undefined;
    // 小图原样发送：缩放只会让文字更糊，且没有任何预算压力需要它让。
    if (width * height <= maxPixels)
        return { width: Math.floor(width), height: Math.floor(height) };
    // 面积按 scale² 变化 → 线性缩放因子取 sqrt，等比缩小到预算内。
    const scale = Math.sqrt(maxPixels / (width * height));
    const targetWidth = Math.max(1, Math.floor(width * scale));
    const targetHeight = Math.max(1, Math.floor(height * scale));
    return { width: targetWidth, height: targetHeight };
}
/**
 * 派生一张图片的请求目标。
 *
 * @param width / height 附件引用里的**固有尺寸**（`ImageAttachmentRef` 必有）。
 * @param maxPixels 像素预算；`undefined` 表示产品未配置（用默认档）。
 * @param maxBytes 编码字节目标；`undefined` 用 `REQUEST_IMAGE_MAX_BYTES`。
 *   ⚠️ 这条是给**按请求体字节**设限的网关准备的（raccoon 实测
 *   `HTTP_413 request body exceeds 10MB`）—— 那种约束下光缩像素不够，
 *   必须同时压字节目标，否则一张高分辨率但低压缩率的图就能吃掉大半配额。
 */
export function requestImageTargetFor(width, height, maxPixels, maxBytes = REQUEST_IMAGE_MAX_BYTES) {
    const fitted = fitImageToPixelBudget(width, height, maxPixels ?? DEFAULT_IMAGE_PIXEL_BUDGET);
    if (fitted === undefined)
        return undefined;
    return { width: fitted.width, height: fitted.height, maxBytes: maxBytes ?? REQUEST_IMAGE_MAX_BYTES };
}
/**
 * 适配器共用的「取请求版本」投影（buddy 与 raccoon 同一份，别各写一遍）。
 *
 * 返回 `undefined` 表示**本次发原图**，四种情形都属正常而非错误：
 *
 * 1. 调用方没桥接 `readImageRequest`（老宿主 / 其它入口构造的适配器）；
 * 2. 附件引用里没有可用的固有尺寸 —— 没尺寸就算不出目标，
 *    绝不能瞎猜一个把图缩坏；
 * 3. 桥接层按契约吞掉异常返回 `undefined`（服务没装、拒绝投影…）；
 * 4. 桥接层**没吞**异常 —— 由下面的 `try/catch` 兜住。缩放是优化，
 *    不能因为"想缩图"把一次本来能成功的请求打死。
 *    （记日志的责任在桥接层，本函数只保证回退方向正确。）
 */
export async function projectRequestImage(attachment, options) {
    const readImageRequest = options.readImageRequest;
    if (readImageRequest === undefined)
        return undefined;
    const { width, height } = attachment;
    if (typeof width !== 'number' || typeof height !== 'number')
        return undefined;
    const target = requestImageTargetFor(width, height, options.pixelBudget, options.maxBytes);
    if (target === undefined)
        return undefined;
    try {
        return await readImageRequest(attachment, target);
    }
    catch {
        return undefined;
    }
}
function isPositiveFinite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
//# sourceMappingURL=image-budget.js.map