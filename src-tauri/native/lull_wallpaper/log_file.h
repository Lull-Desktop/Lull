/**
 * 纯 Win32 日志工具：为探针线程提供共享的临时文件落盘能力。
 */

#ifndef LULL_LOG_FILE_H
#define LULL_LOG_FILE_H

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <windows.h>

namespace lull {
namespace log {

// 注意：这里刻意**不**定义 `const wchar_t *kLogFileName = L"..."` 这样的头文件级变量。
// 名字是 const 但指针本身不是 const 对象 → 外部链接 → 每个 .cpp 都定义一份 → LNK2005。
// 直接用字面量，零风险。
inline const wchar_t *LogFileName() {
	return L"lull_wallpaper.log";
}

// 追加一行（自动带 [hh:mm:ss.mmm] 时间戳）。任何失败都静默 —— 日志不该影响主流程。
inline void FileLine(const char *p_utf8) {
	wchar_t path[MAX_PATH] = {0};
	const DWORD n = GetTempPathW(MAX_PATH, path);
	if (n == 0 || n >= MAX_PATH - 32) {
		return;
	}
	wcscat_s(path, MAX_PATH, LogFileName());

	FILE *f = nullptr;
	if (_wfopen_s(&f, path, L"ab") == 0 && f != nullptr) {
		SYSTEMTIME st;
		GetLocalTime(&st);
		char head[64];
		const int hn = snprintf(head, sizeof(head), "[%02d:%02d:%02d.%03d] ", st.wHour,
				st.wMinute, st.wSecond, st.wMilliseconds);
		if (hn > 0) {
			fwrite(head, 1, static_cast<size_t>(hn), f);
		}
		fwrite(p_utf8, 1, strlen(p_utf8), f);
		fputc('\n', f);
		fclose(f);
	}
}

inline void FileFmt(const char *p_fmt, ...) {
	char buf[2048];
	va_list ap;
	va_start(ap, p_fmt);
	vsnprintf(buf, sizeof(buf), p_fmt, ap);
	va_end(ap);
	FileLine(buf);
}

} // namespace log
} // namespace lull

#endif // LULL_LOG_FILE_H
