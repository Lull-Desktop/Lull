//! 稳定的媒体 API 错误。
//!
//! 前端只按 `code` 分支，不匹配 message；message 允许随文案调整。
//! 公开错误不包含绝对路径，文件路径只允许出现在内部日志。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaErrorBody {
  pub code: String,
  pub message: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct MediaError {
  pub code: &'static str,
  pub message: String,
  pub details: Option<serde_json::Value>,
}

impl MediaError {
  #[must_use]
  pub fn new(code: &'static str, message: impl Into<String>) -> Self {
    Self {
      code,
      message: message.into(),
      details: None,
    }
  }

  #[must_use]
  pub fn invalid(message: impl Into<String>) -> Self {
    Self::new("argument.invalid", message)
  }

  #[must_use]
  pub fn unavailable(message: impl Into<String>) -> Self {
    Self::new("library.unavailable", message)
  }

  #[must_use]
  pub fn internal(message: impl Into<String>) -> Self {
    Self::new("internal", message)
  }

  #[must_use]
  pub fn body(&self) -> MediaErrorBody {
    MediaErrorBody {
      code: self.code.to_string(),
      message: self.message.clone(),
      details: self.details.clone(),
    }
  }
}

impl std::fmt::Display for MediaError {
  fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(formatter, "{}: {}", self.code, self.message)
  }
}

impl std::error::Error for MediaError {}
