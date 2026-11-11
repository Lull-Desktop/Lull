import { describe, expect, test } from "vitest";
import {
  DIAGNOSTIC_DETAIL_MAX_CHARS,
  diagnostic,
  formatDiagnostic,
  toLogMessage,
  truncateText,
} from "./diagnostics";

describe("truncateText", () => {
  test("keeps short text and marks truncation", () => {
    expect(truncateText("abc", 10)).toBe("abc");
    const truncated = truncateText("x".repeat(20), 10);
    expect(truncated.startsWith("x".repeat(10))).toBe(true);
    expect(truncated).toContain("已截断 10 字符");
  });
});

describe("diagnostic", () => {
  test("caps the raw detail length", () => {
    const value = diagnostic("compile-failed", "failed", "y".repeat(10_000), 9);
    expect(value.detail).toBeDefined();
    expect(value.detail?.length).toBeLessThanOrEqual(
      DIAGNOSTIC_DETAIL_MAX_CHARS + 32,
    );
    expect(value.lineOffset).toBe(9);
  });
});

describe("formatDiagnostic", () => {
  test("includes the original log and the line offset hint", () => {
    const text = formatDiagnostic(
      diagnostic(
        "compile-failed",
        "着色器编译失败",
        "ERROR: 0:12: 'unknownFunction' : no matching overloaded function found",
        24,
      ),
    );
    expect(text).toContain("着色器编译失败");
    expect(text).toContain("unknownFunction");
    expect(text).toContain("24 行");
  });

  test("does not add the line hint for non-compile errors", () => {
    const text = formatDiagnostic(
      diagnostic("link-failed", "链接失败", "log", 4),
    );
    expect(text).not.toContain("行号相对");
  });
});

describe("toLogMessage", () => {
  test("collapses whitespace into one line", () => {
    const line = toLogMessage(
      diagnostic("compile-failed", "failed", "ERROR: 0:1\nERROR: 0:2"),
    );
    expect(line).not.toContain("\n");
    expect(line).toContain("compile-failed");
    expect(line).toContain("ERROR: 0:1 ERROR: 0:2");
  });
});
