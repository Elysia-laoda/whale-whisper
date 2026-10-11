package com.zorv.whale;

import android.content.Context;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

/**
 * 把一次点击变成队列里的一个事件。
 *
 * 队列格式与手机上现存的 pending.json 一致：
 *   {"events":[{id,ts,source,state,note}],"acked":[],"mute":false,"updatedAt":...}
 * 写入是「读-追加-原子改名」，所以不会冲掉别的进程刚写进去的事件。
 */
public final class WhaleEvent {

    private static final int MAX_EVENTS = 50;

    private WhaleEvent() {}

    /** 产生一个补充提示事件；返回真正写入的绝对路径，全通道失败返回 null。 */
    public static synchronized String fire(Context ctx, String note) {
        long now = System.currentTimeMillis();
        try {
            JSONObject ev = new JSONObject();
            ev.put("id", "w" + now);
            ev.put("ts", now);
            ev.put("source", "android-overlay");
            ev.put("state", "pending");
            ev.put("note", note == null ? "" : note);

            for (File target : WhalePaths.pendingCandidates()) {
                if (append(target, ev, now)) return target.getAbsolutePath();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private static boolean append(File target, JSONObject ev, long now) {
        try {
            File dir = target.getParentFile();
            if (dir == null) return false;
            if (!dir.exists() && !dir.mkdirs()) return false;

            JSONArray events = new JSONArray();
            JSONArray acked = new JSONArray();
            boolean mute = false;

            if (target.isFile()) {
                String body = read(target);
                if (body != null && body.trim().length() > 0) {
                    JSONObject old = new JSONObject(body);
                    JSONArray e = old.optJSONArray("events");
                    if (e != null) {
                        events = e;
                    } else if (old.has("id")) {
                        // 旧版单事件写法，搬进数组
                        events.put(old);
                    }
                    JSONArray a = old.optJSONArray("acked");
                    if (a != null) acked = a;
                    mute = old.optBoolean("mute", false);
                }
            }

            events.put(ev);
            while (events.length() > MAX_EVENTS) {
                events.remove(0);
            }

            JSONObject out = new JSONObject();
            out.put("events", events);
            out.put("acked", acked);
            out.put("mute", mute);
            out.put("updatedAt", now);
            return writeAtomic(target, out.toString(1));
        } catch (Exception e) {
            return false;
        }
    }

    private static String read(File f) {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(
                new FileInputStream(f), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        } catch (Exception e) {
            return null;
        }
        return sb.toString();
    }

    /** 临时文件 + rename，避免并发写坏 */
    private static boolean writeAtomic(File target, String body) {
        try {
            File dir = target.getParentFile();
            File tmp = new File(dir, target.getName() + ".tmp");
            try (OutputStreamWriter w = new OutputStreamWriter(
                    new FileOutputStream(tmp), StandardCharsets.UTF_8)) {
                w.write(body);
                w.flush();
            }
            if (tmp.renameTo(target)) return true;
            return target.delete() && tmp.renameTo(target);
        } catch (Exception e) {
            return false;
        }
    }
}
