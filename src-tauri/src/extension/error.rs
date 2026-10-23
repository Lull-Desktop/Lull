//! 扩展管理命令的统一错误：稳定 `code` + 可直接展示的 `message`。
//!
//! 前端按 `code` 映射文案；`message` 是兜底，`detail` 只给开发诊断看。
//! 旧的 `content_package_*` / `widget_package_*` 命令仍返回字符串，迁移期并存。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionError {
  pub code: String,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
}

impl ExtensionError {
  #[must_use]
  pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
    Self {
      code: code.into(),
      message: message.into(),
      detail: None,
    }
  }

  #[must_use]
  pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
    self.detail = Some(detail.into());
    self
  }
}

impl std::fmt::Display for ExtensionError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(formatter, "{}: {}", self.code, self.message)
  }
}

impl std::error::Error for ExtensionError {}
