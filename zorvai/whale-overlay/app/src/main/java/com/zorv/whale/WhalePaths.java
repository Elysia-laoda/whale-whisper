package com.zorv.whale;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** 事件落点。三级回退：工作区直写 -> 公共交换区 -> 下载目录兜底。 */
public final class WhalePaths {

    /** ZorvAI 工作区事件队列（直写需要 MANAGE_EXTERNAL_STORAGE，可跳过搬运） */
    public static final String WORKSPACE_DIR =
            "/sdcard/Android/data/com.ai.assistance.quro/files/QuroWorkspace/whale-whisper/state";

    /** 公共交换区，proot 里的 whale-sync 把这里搬进工作区 */
    public static final String QSHARE_DIR = "/sdcard/qshare/whale";

    /** 公共兜底，任何文件管理器可见 */
    public static final String DOWNLOAD_DIR = "/sdcard/Download/whale";

    private WhalePaths() {}

    public static List<File> pendingCandidates() {
        List<File> out = new ArrayList<File>();
        out.add(new File(WORKSPACE_DIR, "pending.json"));
        out.add(new File(QSHARE_DIR, "pending.json"));
        out.add(new File(DOWNLOAD_DIR, "pending.json"));
        return out;
    }
}
