package com.zorv.plugin.whale

import android.os.Handler
import android.os.Looper
import com.ai.assistance.quro.plugin.contract.PluginContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.LinkedHashSet
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * 公共区事件 → 宿主对话。
 *
 * 三段式（每段都可独立失效、且都会在状态里留下痕迹）：
 *   1. 直调 injectExternalReminder()：消息进 store（role=system, 进 LLM）。
 *   2. 回读探针：确认它真的在 store 里、也在 toLlmMessages() 生成的报文里。
 *   3. 唤醒：仅在【空闲】时调 send() 的隐藏消息通道触发一轮 —— 否则报文里的话没人读。
 *
 * 直调失败（或探针不认账）才落 quro_inbox/ 交给官方 Watcher 兜底；
 * 两条都成功会重复注入，所以只在前者没被证实时才写文件。
 */
object InboxBridge {

    private const val PREFS_KEY_SEEN = "whale_seen_ids"
    private const val POLL_MS = 1200L
    private const val KEEP_MS = 120_000L
    private const val MAX_SEEN = 200
    private const val INJECT_TIMEOUT_MS = 1500L
    private const val KICK_TIMEOUT_MS = 2000L

    private const val MARKER = "小鲸鱼补充提示"

    private val SOURCES = listOf(
        "/sdcard/qshare/whale/pending.json",
        "/sdcard/Android/data/com.ai.assistance.quro/files/QuroWorkspace/whale-whisper/state/pending.json"
    )

    private val seen = LinkedHashSet<String>()
    @Volatile private var lastMovedAt = 0L
    @Volatile private var movedTotal = 0
    @Volatile private var directOk = 0
    @Volatile private var directFail = 0
    @Volatile private var kickOk = 0
    @Volatile private var kickSkip = 0
    @Volatile private var lastError = ""
    @Volatile private var lastInject = "（尚未调用）"
    @Volatile private var lastProbe = "（尚无）"
    @Volatile private var lastKick = "（尚无）"
    @Volatile private var lastChannel = ""
    @Volatile private var lastVm: Any? = null
    @Volatile private var pendingKick = false
    @Volatile private var bufNow = "（尚未采样）"
    @Volatile private var ackState = "（尚无）"
    @Volatile private var recheck = "（尚无）"
    @Volatile private var recheckAtSize = -1
    private val pendingAcks = java.util.Collections.synchronizedMap(mutableMapOf<String, String>())
    @Volatile private var loaded = false

    fun loop(ctx: PluginContext, running: AtomicBoolean) {
        val inbox = inboxDir(ctx)
        loadSeen(ctx)
        ctx.log("whale", "桥接轮询启动，inbox=" + inbox.absolutePath)
        while (running.get()) {
            try {
                tick(ctx, inbox)
            } catch (t: Throwable) {
                lastError = t.javaClass.simpleName + ": " + (t.message ?: "")
            }
            try {
                Thread.sleep(POLL_MS)
            } catch (_: InterruptedException) {
                return
            }
        }
    }

    private fun inboxDir(ctx: PluginContext): File =
        File(ctx.appContext.filesDir, "quro_inbox").apply { runCatching { mkdirs() } }

    private fun tick(ctx: PluginContext, inbox: File) {
        cleanup(inbox)
        val events = readEvents() ?: return
        var changed = false
        for (i in 0 until events.length()) {
            val e = events.optJSONObject(i) ?: continue
            val id = e.optString("id").trim()
            if (id.isEmpty() || seen.contains(id)) continue

            val note = e.optString("note").trim().ifEmpty { "用户点击了小鲸鱼" }
            val src = e.optString("source").trim().ifEmpty { "overlay" }
            val ack = "WHALE-ACK-" + id.takeLast(6)
            pendingAcks[ack] = id
            val text = buildString {
                append("【外部事件提醒 · 系统代发，非用户输入】\n")
                append("🐋 ").append(MARKER).append('\n')
                append("事件：").append(id).append('\n')
                append("来源：").append(src).append('\n')
                append(note).append("\n\n")
                append("请立刻调用 visual_question 工具，问用户「有什么要补充的吗？」\n")
                append("（收到本提醒后，请在你的回复里原样输出回执：" + ack + "）")
            }

            val inject = injectDirect(text)
            lastInject = inject
            if (inject.startsWith("wait:")) {
                // 工具调用组未闭合：此刻插入会被宿主 normalizeToolCallMessages 静默丢弃
                lastError = "等待安全窗口（工具组未闭合），下个 tick 重试"
                continue
            }

            // 只有「探针确认进了 store 且进了报文」才算真的送达
            val liveOk = inject == "ok(live)"
            val storeOk = inject == "ok(store)" &&
                lastProbe.contains("事件在store=是") &&
                lastProbe.contains("在LLM报文=是")
            val landed = liveOk || storeOk

            if (landed) {
                directOk++
                lastChannel = if (liveOk) "live-buffer" else "shared-store"
                if (storeOk) {
                    // 只进了共享 store：当前轮读不到，挂起到轮末再踢
                    pendingKick = true
                    lastKick = "pending（等本轮结束）"
                } else {
                    lastKick = "不需要（已进本轮）"
                }
            } else {
                directFail++
                lastChannel = "file"
                val out = File(inbox, "whale-" + id + ".txt")
                if (!runCatching { out.writeText(text) }.isSuccess) {
                    lastError = "两通道均失败：inject=" + inject + " probe=" + lastProbe
                    continue
                }
            }

            seen.add(id)
            movedTotal++
            lastMovedAt = System.currentTimeMillis()
            changed = true
            ctx.log("whale", "事件 " + id + " -> " + lastChannel + " (" + inject + " | " + lastKick + ")")
        }
        // 采样：本轮 buffer 有没有继续长（长 = 这一轮确实在往它写）
        runCatching {
            val vm = lastVm ?: return@runCatching
            val buffers = vm.javaClass.getDeclaredField("liveBuffers").apply { isAccessible = true }
                .get(vm) as? Map<*, *> ?: return@runCatching
            val anyBuf = buffers.values.firstOrNull() ?: return@runCatching
            val list = anyBuf.javaClass.getMethod("all").invoke(anyBuf) as? List<*> ?: return@runCatching
            val last = list.lastOrNull()
            bufNow = "size=" + list.size + " 末条=" + readStr(last, "getRole") + "/" +
                readStr(last, "getContent").replace("\n", " ").take(12) +
                " buffers=" + buffers.size

            // 复核 B：buf 尺寸一变就复算一次「报文里还有没有这条提醒」
            if (list.size != recheckAtSize) {
                recheckAtSize = list.size
                runCatching {
                    val msgCls2 = Class.forName("com.ai.assistance.quro.core.QuroMessage")
                    val m2 = anyBuf.javaClass.getMethod(
                        "toLlmMessages", msgCls2, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType
                    )
                    val llm = m2.invoke(anyBuf, null, 0, 0) as? List<*>
                    if (llm != null) {
                        val inLlm = llm.any { readStr(it, "getContent").contains(MARKER) }
                        val clientCls2 = Class.forName("com.ai.assistance.quro.core.network.QuroLlmClient")
                        val ctor2 = clientCls2.declaredConstructors.firstOrNull {
                            it.parameterCount == 3 && it.parameterTypes[1] == Int::class.javaPrimitiveType
                        }
                        val inst2 = if (ctor2 != null) { ctor2.isAccessible = true; ctor2.newInstance(null, 1, null) } else null
                        val nm2 = clientCls2.getDeclaredMethod("normalizeToolCallMessages", List::class.java)
                        nm2.isAccessible = true
                        val out = nm2.invoke(inst2, llm) as? List<*>
                        val inNorm = out != null && out.any { readStr(it, "getContent").contains(MARKER) }
                        recheck = "size=" + list.size + " 报文=" + (if (inLlm) "是" else "否") +
                            " 归一化后=" + (if (inNorm) "是" else "否") + "(" + llm.size + "→" + (out?.size ?: -1) + ")"
                    }
                }.onFailure { recheck = "err:" + (it.cause ?: it).javaClass.simpleName }
            }

            // 模型有没有回执：扫 assistant 输出里是否出现 WHALE-ACK-xxxxxx
            if (pendingAcks.isNotEmpty()) {
                for (m in list) {
                    if (readStr(m, "getRole") != "assistant") continue
                    val c = readStr(m, "getContent")
                    val hit = pendingAcks.keys.firstOrNull { c.contains(it) }
                    if (hit != null) {
                        ackState = "是（" + hit + "）"
                        pendingAcks.remove(hit)
                    }
                }
            }
        }

        // 边沿触发：忙时挂起，转空闲立刻踢一轮
        if (pendingKick) {
            val vm = lastVm
            if (vm != null) {
                val b = busyOf(vm)
                if (b == false) {
                    val r = tryKick(vm)
                    lastKick = r
                    pendingKick = false
                    if (r == "ok") kickOk++ else kickSkip++
                    ctx.log("whale", "空闲，唤醒 -> " + r)
                } else if (b == null) {
                    lastKick = "skip: busy 读取失败"
                    pendingKick = false
                }
                // b == true：继续等（本轮仍在进行）
            }
        }

        if (changed) saveSeen(ctx)
    }

    /** 反射直调宿主注入；切主线程执行，最多等 1.5s 拿结果。任何异常都不外抛。 */
    private fun injectDirect(text: String): String {
        val verdict = AtomicReference("timeout")
        val latch = CountDownLatch(1)
        try {
            val cls = Class.forName("com.ai.assistance.quro.ui.QuroChatViewModel")
            val companion = cls.getField("Companion").get(null)
            val inst = companion.javaClass.getMethod("getInstance").invoke(companion)
                ?: return "fail: instance=null"
            lastVm = inst
            val method = cls.getMethod("injectExternalReminder", String::class.java)
            Handler(Looper.getMainLooper()).post {
                try {
                    val live = injectIntoLiveBuffer(inst, text)
                    if (live.startsWith("ok")) {
                        lastProbe = probeStore(inst) + " | 本轮buffer=" + live
                        verdict.set("ok(live)")
                    } else if (live.startsWith("wait:")) {
                        lastProbe = "等安全窗口：" + live
                        verdict.set(live)
                    } else {
                        method.invoke(inst, text)
                        lastProbe = probeStore(inst) + " | 本轮buffer=" + live
                        verdict.set("ok(store)")
                    }
                } catch (t: Throwable) {
                    val c = t.cause ?: t
                    verdict.set("fail: invoke " + c.javaClass.simpleName + " " + (c.message ?: "").take(120))
                } finally {
                    latch.countDown()
                }
            }
            latch.await(INJECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            return verdict.get()
        } catch (t: Throwable) {
            val c = t.cause ?: t
            return "fail: reflect " + c.javaClass.simpleName + " " + (c.message ?: "").take(120)
        }
    }

    /**
     * 注入后回读三个事实：消息在不在 store、在不在 toLlmMessages() 造出的报文里、
     * assistant 用的是不是同一份 store。
     */
    private fun probeStore(vm: Any): String {
        return try {
            val vmCls = vm.javaClass
            val storeField = vmCls.getDeclaredField("store").apply { isAccessible = true }
            val store = storeField.get(vm) ?: return "store=null"
            val all = store.javaClass.getMethod("all").invoke(store) as? List<*> ?: return "all()=null"

            fun read(m: Any?, getter: String): String =
                if (m == null) "" else (runCatching {
                    m.javaClass.getMethod(getter).invoke(m) as? String
                }.getOrNull() ?: "")

            val last = all.lastOrNull()
            val role = read(last, "getRole")
            val content = read(last, "getContent").replace("\n", " ").take(16)
            val marker = all.any { read(it, "getContent").contains(MARKER) }

            var inLlm = "unknown"
            runCatching {
                val msgCls = Class.forName("com.ai.assistance.quro.core.QuroMessage")
                val m = store.javaClass.getMethod(
                    "toLlmMessages", msgCls, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType
                )
                val llm = m.invoke(store, null, 0, 0) as? List<*>
                inLlm = if (llm == null) "null"
                else if (llm.any { read(it, "getContent").contains(MARKER) }) "是" else "否"
            }

            var same = "unknown"
            runCatching {
                val aField = vmCls.getDeclaredField("assistant").apply { isAccessible = true }
                val assistant = aField.get(vm) ?: return@runCatching
                val sField = assistant.javaClass.getDeclaredField("store").apply { isAccessible = true }
                same = if (sField.get(assistant) === store) "是" else "否"
            }

            "store=" + all.size + " 末条=" + role + "/" + content +
                " 事件在store=" + (if (marker) "是" else "否") +
                " 在LLM报文=" + inLlm +
                " 与assistant同实例=" + same
        } catch (t: Throwable) {
            "probe fail: " + t.javaClass.simpleName + " " + (t.message ?: "").take(80)
        }
    }

    /**
     * 补丁②：报文里已有提醒，但没有请求去读它。
     * 空闲时调 send() 的隐藏消息通道（repairFeedback → hidden=true，用户看不见、LLM 看得见）触发一轮。
     * 生成中绝不进入 —— send() 会 barge-in 打断当前轮。
     */
    /**
     * 把提醒写进【本轮正在使用的工作副本】。
     *
     * 关键事实：send() 里每一轮都在用 turn-local 的 buf（QuroChatViewModel.kt:928-931），
     * 共享 store 只负责展示与下一轮种子。所以生成期间注入共享 store 本轮永远读不到，
     * 必须写 liveBuffers[当前会话]。
     */
    private fun readListSize(m: Any?, getter: String): Int =
        if (m == null) 0 else (runCatching {
            (m.javaClass.getMethod(getter).invoke(m) as? List<*>)?.size ?: 0
        }.getOrNull() ?: 0)

    /**
     * 安全窗口判定：模拟 QuroLlmClient.normalizeToolCallMessages 的扫描，
     * open 非空时插入的非 tool 消息会被静默丢弃，必须等到 tool 结果回填完再插。
     */
    private fun safeWindow(list: List<*>): Boolean {
        var open = 0
        for (m in list) {
            val tc = readListSize(m, "getToolCalls")
            val role = readStr(m, "getRole")
            if (tc > 0) {
                open = tc
            } else if (role == "tool") {
                if (open > 0) open--
            }
        }
        return open == 0
    }

    private fun readStr(m: Any?, getter: String): String =
        if (m == null) "" else (runCatching {
            m.javaClass.getMethod(getter).invoke(m) as? String
        }.getOrNull() ?: "")

    private fun injectIntoLiveBuffer(vm: Any, text: String): String {
        return try {
            val vmCls = vm.javaClass
            val buffersField = vmCls.getDeclaredField("liveBuffers").apply { isAccessible = true }
            val buffers = buffersField.get(vm) as? Map<*, *> ?: return "buffers=null"
            if (buffers.isEmpty()) return "无活动轮"

            val keys = buffers.keys.joinToString(",")
            val convId = runCatching {
                vmCls.getMethod("getActiveConversationId").invoke(vm) as? String
            }.getOrNull().orEmpty()
            if (convId.isBlank()) return "no-conv keys=[" + keys + "]"
            if (!buffers.containsKey(convId)) {
                // 键不匹配时绝不猜别的 buffer —— 写错会话比不写更糟
                return "no-hit conv=" + convId.take(8) + " keys=[" + keys + "]"
            }
            val buf = buffers[convId] ?: return "no-hit keys=[" + keys + "]"

            val msgCls = Class.forName("com.ai.assistance.quro.core.QuroMessage")
            val ctor = msgCls.declaredConstructors
                .filter { it.parameterCount == 15 }
                .maxByOrNull { it.parameterTypes.count { p -> p == String::class.java } }
                ?: return "QuroMessage 构造器不匹配(" +
                    msgCls.declaredConstructors.joinToString(",") { c -> c.parameterCount.toString() } + ")"
            ctor.isAccessible = true
            // role=user：留在对话末尾，模型当作「最新输入」处理；
            // system 会被 toLlmMessages 提到最前（QuroConversation.kt:298），混进系统提示里容易被忽略。
            // hidden=true：UI 不显示气泡，但 LLM 上下文仍包含（QuroConversation.kt:64-65）。
            val msg = ctor.newInstance(
                "whale-" + System.nanoTime(), "user", text,
                null, null, null, null, null,
                emptyList<Any>(), emptyList<Any>(),
                "外部事件", false, null, true, System.currentTimeMillis()
            )

            @Suppress("UNCHECKED_CAST")
            fun bufAll(): List<*>? = runCatching {
                buf.javaClass.getMethod("all").invoke(buf) as? List<*>
            }.getOrNull()

            val before = bufAll()?.size ?: -1
            val add = buf.javaClass.getMethod("add", msgCls)
            add.invoke(buf, msg)
            val afterList = bufAll()
            val after = afterList?.size ?: -1
            val lastM = afterList?.lastOrNull()
            val lr = readStr(lastM, "getRole")
            val lc = readStr(lastM, "getContent").replace("\n", " ").take(14)

            // ★ 在 buf 自己身上造一遍报文，确认它真的会被下发
            var inBufLlm = "?"
            var norm = "?"
            runCatching {
                val m2 = buf.javaClass.getMethod(
                    "toLlmMessages", msgCls, Int::class.javaPrimitiveType, Int::class.javaPrimitiveType
                )
                val llm = m2.invoke(buf, null, 0, 0) as? List<*>
                inBufLlm = if (llm != null && llm.any { readStr(it, "getContent").contains(MARKER) }) "是" else "否"

                // ★ 模拟宿主发请求前的最后一步：normalizeToolCallMessages（纯函数，无需真实网络）
                if (llm != null) {
                    val clientCls = Class.forName("com.ai.assistance.quro.core.network.QuroLlmClient")
                    val ctor = clientCls.declaredConstructors.firstOrNull {
                        it.parameterCount == 3 && it.parameterTypes[1] == Int::class.javaPrimitiveType
                    }
                    val clientInst = if (ctor != null) {
                        ctor.isAccessible = true
                        ctor.newInstance(null, 1, null)
                    } else null
                    val nm = clientCls.getDeclaredMethod("normalizeToolCallMessages", List::class.java)
                    nm.isAccessible = true
                    val outList = nm.invoke(clientInst, llm) as? List<*>
                    norm = if (outList == null) "null" else {
                        val has = outList.any { readStr(it, "getContent").contains(MARKER) }
                        (if (has) "是" else "否") + "(" + llm.size + "→" + outList.size + ")"
                    }
                }
            }.onFailure { t ->
                val c = t.cause ?: t
                if (norm == "?") norm = "err:" + c.javaClass.simpleName + " " + (c.message ?: "").take(48)
            }

            "ok[命中=是 key=" + convId.take(8) + " 前=" + before + " 后=" + after +
                " 末条=" + lr + "/" + lc + " buf报文=" + inBufLlm + " 归一化后=" + norm + "]"
        } catch (t: Throwable) {
            val c = t.cause ?: t
            "fail:" + c.javaClass.simpleName + " " + (c.message ?: "").take(60)
        }
    }

    private fun busyOf(vm: Any): Boolean? = runCatching {
        val sf = vm.javaClass.getMethod("getBusy").invoke(vm)
        sf.javaClass.getMethod("getValue").invoke(sf) as? Boolean
    }.getOrNull()

    private fun tryKick(vm: Any): String {
        return try {
            val cls = vm.javaClass
            val m = cls.declaredMethods.firstOrNull { it.name == "send\$default" }
                ?: return "skip: no send"
            m.isAccessible = true

            val kick = "（小鲸鱼桥接）上下文里有一条「" + MARKER + "」。请立刻调用 visual_question 问用户" +
                "「有什么要补充的吗？」，问完再继续原任务。"
            // 形参：receiver, text, attachments, cfg, skill, contextMessage, repairFeedback, repairConvId, mask, marker
            // mask=94 → 只给 text 与 repairFeedback 传值，其余走 Kotlin 默认参数
            val args = arrayOf<Any?>(vm, "", null, null, null, null, kick, null, 94, null)

            val verdict = AtomicReference("timeout")
            val latch = CountDownLatch(1)
            Handler(Looper.getMainLooper()).post {
                try {
                    m.invoke(null, *args)
                    verdict.set("ok")
                } catch (t: Throwable) {
                    val c = t.cause ?: t
                    verdict.set("fail: send " + c.javaClass.simpleName + " " + (c.message ?: "").take(100))
                } finally {
                    latch.countDown()
                }
            }
            latch.await(KICK_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            verdict.get()
        } catch (t: Throwable) {
            val c = t.cause ?: t
            "fail: kick " + c.javaClass.simpleName + " " + (c.message ?: "").take(100)
        }
    }

    private fun readEvents(): JSONArray? {
        for (p in SOURCES) {
            val f = File(p)
            if (!f.isFile) continue
            val raw = runCatching { f.readText() }.getOrNull() ?: continue
            val obj = runCatching { JSONObject(raw) }.getOrNull() ?: continue
            val arr = obj.optJSONArray("events")
            if (arr != null) return arr
            if (obj.has("id")) return JSONArray().put(obj)
        }
        return null
    }

    private fun cleanup(inbox: File) {
        val now = System.currentTimeMillis()
        runCatching {
            inbox.listFiles()?.forEach { f ->
                if (f.isFile && f.name.startsWith("whale-") && now - f.lastModified() > KEEP_MS) {
                    f.delete()
                }
            }
        }
    }

    private fun loadSeen(ctx: PluginContext) {
        if (loaded) return
        loaded = true
        val raw = ctx.getString(PREFS_KEY_SEEN, "")
        if (raw.isNotBlank()) raw.split(',').forEach { if (it.isNotBlank()) seen.add(it.trim()) }
    }

    private fun saveSeen(ctx: PluginContext) {
        while (seen.size > MAX_SEEN) {
            val it = seen.iterator()
            if (it.hasNext()) {
                it.next()
                it.remove()
            } else {
                break
            }
        }
        ctx.putString(PREFS_KEY_SEEN, seen.joinToString(","))
    }

    fun snapshot(ctx: PluginContext, verbose: Boolean): String {
        val inbox = inboxDir(ctx)
        val files = inbox.listFiles()?.filter { it.isFile && it.name.startsWith("whale-") } ?: emptyList()
        loadSeen(ctx)
        val sb = StringBuilder()
        val found = SOURCES.filter { File(it).isFile }
        sb.append("事件源：").append(if (found.isEmpty()) "都不存在" else found.joinToString(", ")).append('\n')
        sb.append("已搬运：").append(movedTotal).append(" 条（去重集合 ").append(seen.size).append("）").append('\n')
        sb.append("直调成功：").append(directOk).append(" 条；直调失败：").append(directFail).append(" 条").append('\n')
        sb.append("唤醒成功：").append(kickOk).append(" 次；跳过：").append(kickSkip).append(" 次").append('\n')
        sb.append("最近通道：").append(if (lastChannel.isBlank()) "无" else lastChannel).append('\n')
        sb.append("最近直调结果：").append(lastInject).append('\n')
        sb.append("注入后回读：").append(lastProbe).append('\n')
        sb.append("唤醒结果：").append(lastKick).append('\n')
        sb.append("待唤醒：").append(if (pendingKick) "是（等本轮结束）" else "否").append('\n')
        sb.append("buf现况：").append(bufNow).append('\n')
        sb.append("复核报文：").append(recheck).append('\n')
        sb.append("模型回执：").append(ackState)
            .append(if (pendingAcks.isEmpty()) "" else "（待确认 " + pendingAcks.size + " 条）").append('\n')
        sb.append("inbox：").append(inbox.absolutePath).append("（桥接文件 ").append(files.size).append(" 个）").append('\n')
        sb.append("最近搬运：")
        sb.append(
            if (lastMovedAt == 0L) "无"
            else SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(lastMovedAt))
        ).append('\n')
        if (lastError.isNotBlank()) sb.append("最近错误：").append(lastError).append('\n')
        if (verbose && files.isNotEmpty()) {
            sb.append("明细：")
            files.take(10).forEach { sb.append("\n · ").append(it.name).append(" (").append(it.length()).append("B)") }
        }
        return sb.toString()
    }
}