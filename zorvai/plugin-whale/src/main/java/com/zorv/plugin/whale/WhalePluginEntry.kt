package com.zorv.plugin.whale

import com.ai.assistance.quro.plugin.contract.ParamType
import com.ai.assistance.quro.plugin.contract.PluginContext
import com.ai.assistance.quro.plugin.contract.PluginEntry
import com.ai.assistance.quro.plugin.contract.ToolResult
import com.ai.assistance.quro.plugin.dsl.plugin
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 小鲸鱼桥接插件。
 *
 * 职责只有一个：把挂件写在公共区的事件，搬进宿主自己监听的 quro_inbox/，
 * 由 v1.1.10 的 QuroInboxWatcher 当作「系统提醒」注入对话。
 *
 * 它不弹窗、不抢焦点、不碰私有 API，只做搬运，所以换宿主版本也不容易坏。
 */
class WhalePluginEntry : PluginEntry {

    private val running = AtomicBoolean(false)
    private var worker: Thread? = null

    override fun onCreate(ctx: PluginContext) {
        ctx.log("whale", "小鲸鱼桥接启动 v" + ctx.pluginVersion)

        // 注意：v1.1.10 的 DSL 是 plugin(ctx) { ... }，注册发生在 commit() 内部，
        // 不要再套一层 ctx.register(...)。
        plugin(ctx) {
            aiTool(
                name = "whale_bridge_status",
                description = "查看小鲸鱼桥接插件状态：公共区事件文件是否存在、已搬运条数、inbox 目录与文件数、最近错误"
            ) {
                param("verbose", ParamType.BOOLEAN, "是否返回 inbox 明细", required = false)
                execute { args ->
                    ToolResult.text(InboxBridge.snapshot(ctx, args.boolean("verbose")))
                }
            }
        }

        running.set(true)
        worker = Thread { InboxBridge.loop(ctx, running) }.also {
            it.isDaemon = true
            it.name = "whale-inbox-bridge"
            it.start()
        }
    }

    override fun onDestroy(ctx: PluginContext) {
        running.set(false)
        worker = null
        ctx.unregisterAll()
    }
}
