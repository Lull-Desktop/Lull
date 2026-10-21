/**
 * 原生区段耗时工具：使用 QPC 统计 Win32 调用开销，并以低干扰方式保留慢事件。
 */

#ifndef LULL_TIMING_H
#define LULL_TIMING_H

#include <cstdint>
#include <cstdio>
#include <cstring>

#include <windows.h>

#include "log_file.h"

namespace lull {
namespace timing {

// 测点清单。tag 顺序即 dump 顺序；名字表在 TagName()。
enum Tag : uint16_t {
	kTagPollSlots = 0,      // Desktop::poll_slots() 整段（含全部槽位 + 字典构造）
	kTagHostGate,           // 看门狗 5：宿主门一段
	kTagEnsureStyles,       // 看门狗 1：样式（整段，含只读比对）
	kTagEnsureStylesSetLong,// 看门狗 1 里**实际执行**的 SetWindowLongW（style/exstyle 两处共用）
	kTagEnsureStylesLayered,// 看门狗 1 里**实际执行**的 SetLayeredWindowAttributes
	kTagEnsureZOrder,       // 看门狗 2：层序（整段，含 z 序扫描）
	kTagEnsureZOrderSetPos, // 看门狗 2 里**实际执行**的修正 SetWindowPos
	kTagEnsureRect,         // 看门狗 3：矩形（整段，含读回比对）
	kTagEnsureRectMove,     // 看门狗 3 里**实际执行**的修正 MoveWindow
	kTagReattach,           // 看门狗 4：断链重挂整段（内含 Attach 的全部分步）
	kTagHostStatus,        // HostStatus 采集一段
	kTagAttachTotal,        // wallpaper::Attach() 整段
	kTagAttachResolve,      // Attach.1 ResolvePlacement（FindWindow/EnumWindows）
	kTagAttachApplyStyles,  // Attach.2 ApplyWallpaperStyles（SetWindowLong×2 + SetWindowPos）
	kTagAttachSetParent,    // Attach.4 SetParent（跨进程！重点观察对象）
	kTagAttachParentCheck,  // Attach.4 之后的 GetParent 回读校验（复审补漏）
	kTagAttachRollback,     // Attach.4 失败回滚：ShowWindow(HIDE)+SetWindowLong 还原
	kTagAttachLayered,      // Attach.5 SetLayeredWindowAttributes
	kTagAttachZPos,         // Attach.6 SetWindowPos 插层序（跨进程宿主参与）
	kTagAttachHide,         // Attach.7 ShowWindow(SW_HIDE)
	kTagAttachMove1,        // Attach.7 MoveWindow(中间尺寸, TRUE)
	kTagAttachMove2,        // Attach.7 MoveWindow(最终尺寸, TRUE)
	kTagAttachShow,         // Attach.7 ShowWindow(SW_SHOW)
	kTagAttachProbe,        // Attach.8 HostStatus
	kTagDetachTotal,        // wallpaper::Detach() 整段
	kTagDetachHide,         // Detach 里**实际执行**的 ShowWindow(SW_HIDE)（复审补漏）
	kTagDetachSetParent,    // Detach 里的 SetParent(saved.parent)（同样跨进程）
	kTagDetachSetPos,       // Detach 里的还原 SetWindowPos（复审补漏）
	kTagCount
};

inline const char *TagName(Tag p_tag) {
	static const char *const kNames[kTagCount] = {
			"poll_slots 总耗时",
			"看门狗5 宿主门",
			"看门狗1 样式整段",
			"看门狗1 SetWindowLong(执行)",
			"看门狗1 SetLayeredWindow(执行)",
			"看门狗2 层序整段",
			"看门狗2 SetWindowPos(执行)",
			"看门狗3 矩形整段",
			"看门狗3 MoveWindow(执行)",
			"看门狗4 重挂整段",
			"HostStatus",
			"Attach 总计",
			"Attach.ResolvePlacement",
			"Attach.ApplyWallpaperStyles",
			"Attach.SetParent",
			"Attach.GetParent 校验",
			"Attach.失败回滚窗口操作",
			"Attach.SetLayeredWindowAttributes",
			"Attach.SetWindowPos(层序)",
			"Attach.ShowWindow(HIDE)",
			"Attach.MoveWindow(中间)",
			"Attach.MoveWindow(最终)",
			"Attach.ShowWindow(SHOW)",
			"Attach.HostStatus",
			"Detach 总计",
			"Detach.ShowWindow(HIDE)",
			"Detach.SetParent",
			"Detach.SetWindowPos(还原)",
	};
	return p_tag < kTagCount ? kNames[p_tag] : "?";
}

// 慢事件判级阈值（微秒）。**只用于给事件分级，不再触发同步落盘。**
const uint64_t kWarnUs = 50000; // ≥50ms：预警
const uint64_t kBadUs = 100000; // ≥100ms：重点
const int kRingSize = 64;       // 慢事件环形缓冲区容量

struct TagStat {
	uint64_t count = 0;
	uint64_t total_us = 0;
	uint32_t max_us = 0;
};

struct SlowRec {
	uint32_t sec_of_day = 0; // 本地时间秒（事件**发生**时刻；dump 延迟写出时以此为准）
	uint16_t ms = 0;
	uint16_t tag = 0;
	uint32_t us = 0;
};

inline TagStat &StatsAt(int p_i) {
	static TagStat s_stats[kTagCount];
	return s_stats[p_i];
}
inline SlowRec &RingAt(int p_i) {
	static SlowRec s_ring[kRingSize];
	return s_ring[p_i];
}
inline uint64_t &RingNext() { static uint64_t v = 0; return v; }     // 已写入总数
inline uint64_t &SlowFlushed() { static uint64_t v = 0; return v; }  // 已落盘水位（下标锚）
inline uint64_t &DroppedSlow() { static uint64_t v = 0; return v; }  // 被覆盖且从未落盘的条数

inline uint64_t QpcToUs(LARGE_INTEGER p_delta) {
	static LARGE_INTEGER s_freq = [] {
		LARGE_INTEGER f;
		QueryPerformanceFrequency(&f);
		return f;
	}();
	// freq 典型 10MHz：delta*1e6 在 int64 范围内安全（测量窗口远小于溢出阈值）。
	return static_cast<uint64_t>((p_delta.QuadPart * 1000000ULL) / static_cast<uint64_t>(s_freq.QuadPart));
}

// 记录一次区段耗时：统计与环形缓冲**全内存**，不碰文件（复审第一轮第 1 条）。
inline void Record(Tag p_tag, uint64_t p_us) {
	TagStat &st = StatsAt(p_tag);
	st.count++;
	st.total_us += p_us;
	if (p_us > st.max_us) {
		st.max_us = static_cast<uint32_t>(p_us);
	}
	if (p_us < kWarnUs) {
		return; // 快路径：一次 QPC + 三次内存写，没有任何系统调用
	}
	const uint64_t seq = RingNext();
	// 覆盖保护：环形缓冲满且最老一条还没刷出 → 记一条"永久丢失"，摘要如实报告。
	if (seq - SlowFlushed() >= static_cast<uint64_t>(kRingSize)) {
		DroppedSlow()++;
		SlowFlushed()++;
	}
	SlowRec &r = RingAt(static_cast<int>(seq % static_cast<uint64_t>(kRingSize)));
	r.us = static_cast<uint32_t>(p_us);
	r.tag = p_tag;
	SYSTEMTIME now;
	GetLocalTime(&now);
	r.sec_of_day = static_cast<uint32_t>(now.wHour * 3600 + now.wMinute * 60 + now.wSecond);
	r.ms = now.wMilliseconds;
	RingNext() = seq + 1;
}

// RAII 测点。析构时记录；提前结束可用 StopNow()。
class ScopedTimer {
public:
	explicit ScopedTimer(Tag p_tag) : m_tag(p_tag) { QueryPerformanceCounter(&m_t0); }
	~ScopedTimer() { StopNow(); }
	ScopedTimer(const ScopedTimer &) = delete;
	ScopedTimer &operator=(const ScopedTimer &) = delete;

	void StopNow() {
		if (m_done) {
			return;
		}
		m_done = true;
		LARGE_INTEGER t1;
		QueryPerformanceCounter(&t1);
		LARGE_INTEGER d;
		d.QuadPart = t1.QuadPart - m_t0.QuadPart;
		Record(m_tag, QpcToUs(d));
	}

private:
	Tag m_tag;
	LARGE_INTEGER m_t0 = {0, 0};
	bool m_done = false;
};

// 把环形缓冲里**尚未落盘**的慢事件批量写出（显式刷新——通常在 dump_timing 里调用）。
// 每行正文自带事件发生时刻（FileLine 的前缀时间戳是写出时刻，可能晚于事件本身）。
// 返回本次写出的条数。
inline int FlushNewSlowEventsToLog() {
	int written = 0;
	const uint64_t total = RingNext();
	while (SlowFlushed() < total) {
		const uint64_t k = SlowFlushed();
		const SlowRec &r = RingAt(static_cast<int>(k % static_cast<uint64_t>(kRingSize)));
		log::FileFmt("[timing] 事件时刻 %02d:%02d:%02d.%03d %s 耗时 %.1f ms —— %s"
				"（环形缓冲批量刷新，非实时写出）",
				r.sec_of_day / 3600, (r.sec_of_day / 60) % 60, r.sec_of_day % 60, r.ms,
				TagName(static_cast<Tag>(r.tag)), static_cast<double>(r.us) / 1000.0,
				r.us >= kBadUs ? "≥100ms，重点调查对象" : "≥50ms 预警");
		SlowFlushed()++;
		written++;
	}
	return written;
}

// 把"统计摘要 + 慢事件清单（内存里的全量，含尚未刷出的）"写成多行文本（\n 分隔）。
// 返回长度；buf 不够时截断（不会越界）。
inline size_t FormatSummary(char *p_buf, size_t p_cap) {
	if (!p_buf || p_cap == 0) {
		return 0;
	}
	p_buf[0] = '\0';
	size_t len = 0;
	char line[256];
	const uint64_t total = RingNext();
	const uint64_t in_ring = total < static_cast<uint64_t>(kRingSize)
			? total : static_cast<uint64_t>(kRingSize);
	int written = snprintf(p_buf, static_cast<int>(p_cap),
			"== 原生区段定点计时（QPC；慢事件判级：预警 %llu us / 重点 %llu us）==\n"
			"   慢事件累计 %llu 条；环形缓冲在存 %llu 条；已批量落盘 %llu 条；被覆盖丢失 %llu 条\n",
			static_cast<unsigned long long>(kWarnUs), static_cast<unsigned long long>(kBadUs),
			static_cast<unsigned long long>(total),
			static_cast<unsigned long long>(in_ring),
			static_cast<unsigned long long>(SlowFlushed()),
			static_cast<unsigned long long>(DroppedSlow()));
	if (written > 0) {
		len = static_cast<size_t>(written) < p_cap ? static_cast<size_t>(written) : p_cap - 1;
	}
	for (int i = 0; i < kTagCount; ++i) {
		const TagStat &st = StatsAt(i);
		if (st.count == 0) {
			continue; // 没跑过的测点不占版面（写路径 tag 的 n= 即实际执行次数）
		}
		snprintf(line, sizeof(line),
				"  %-34s n=%-8llu avg=%7.2f ms  max=%8.1f ms\n", TagName(static_cast<Tag>(i)),
				static_cast<unsigned long long>(st.count),
				static_cast<double>(st.total_us) / 1000.0 / static_cast<double>(st.count),
				static_cast<double>(st.max_us) / 1000.0);
		line[sizeof(line) - 1] = '\0';
		const size_t need = strlen(line);
		if (len + need + 1 >= p_cap) {
			break;
		}
		memcpy(p_buf + len, line, need);
		len += need;
		p_buf[len] = '\0';
	}
	if (in_ring > 0) {
		snprintf(line, sizeof(line),
				"  —— 环形缓冲里的慢事件（从旧到新；未 dump 的只在这份输出里可见）——\n");
		const size_t need0 = strlen(line);
		if (len + need0 + 1 < p_cap) {
			memcpy(p_buf + len, line, need0);
			len += need0;
			p_buf[len] = '\0';
		}
		const uint64_t start = total < static_cast<uint64_t>(kRingSize)
				? 0 : total - static_cast<uint64_t>(kRingSize);
		for (uint64_t k = 0; k < in_ring; ++k) {
			const SlowRec &r = RingAt(static_cast<int>((start + k) % static_cast<uint64_t>(kRingSize)));
			snprintf(line, sizeof(line), "  [%02d:%02d:%02d.%03d] %-34s %8.1f ms %s\n",
					r.sec_of_day / 3600, (r.sec_of_day / 60) % 60, r.sec_of_day % 60, r.ms,
					TagName(static_cast<Tag>(r.tag)), static_cast<double>(r.us) / 1000.0,
					r.us >= kBadUs ? "[重点]" : "[预警]");
			line[sizeof(line) - 1] = '\0';
			const size_t need = strlen(line);
			if (len + need + 1 >= p_cap) {
				break;
			}
			memcpy(p_buf + len, line, need);
			len += need;
			p_buf[len] = '\0';
		}
	}
	return len;
}

// dump 的落盘侧：先批量刷出慢事件，再把摘要逐行写进日志文件
// （与黑匣子 tail 的 %TEMP%\lull_wallpaper.log 同一份，现场不丢）。
inline void DumpToFile() {
	FlushNewSlowEventsToLog();
	static char buf[8192];
	const size_t len = FormatSummary(buf, sizeof(buf));
	char *save = nullptr;
	char copy[8192];
	if (len + 1 <= sizeof(copy)) {
		memcpy(copy, buf, len + 1);
		for (char *line = strtok_s(copy, "\n", &save); line; line = strtok_s(nullptr, "\n", &save)) {
			log::FileLine(line);
		}
	}
}

} // namespace timing
} // namespace lull

#endif // LULL_TIMING_H
