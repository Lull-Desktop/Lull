//! 视频壁纸的显示配置。
//!
//! 该配置挂在 `display.json` 的 `display.media` 下；字段全部可选，旧配置不需要迁移。
//! 字符串枚举在这里做宽松归一化：单个坏值只回退该字段，不让整个 `display.json`
//! 失效（与 `DisplayMode` 的处理一致）。

use serde::{Deserialize, Serialize};

pub const DEFAULT_ASSET_ID: Option<String> = None;
pub const DEFAULT_FIT: &str = "cover";
pub const DEFAULT_POSITION: &str = "center";
pub const DEFAULT_PREFERRED_FPS: u16 = 30;
pub const DEFAULT_HARDWARE_DECODE: &str = "auto";
pub const DEFAULT_SHARE: &str = "auto";
pub const DEFAULT_RATE: f32 = 1.0;

pub const FIT_VALUES: &[&str] = &["cover", "contain", "fill"];
pub const POSITION_VALUES: &[&str] = &["center", "top", "bottom", "left", "right"];
pub const FPS_VALUES: &[u16] = &[24, 30, 60];
pub const HARDWARE_VALUES: &[&str] = &["auto", "required", "disabled"];
pub const SHARE_VALUES: &[&str] = &["auto", "shared", "independent"];

/// `display.media`：视频壁纸的持久化配置。
///
/// 首版只允许一个全局视频源；`assetId` 指向本地媒体库（`media.json`）中的条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaConfig {
  /// 本地媒体库条目 id；None = 尚未选择视频。
  #[serde(skip_serializing_if = "Option::is_none")]
  pub asset_id: Option<String>,
  /// 是否循环播放。
  #[serde(rename = "loop")]
  pub loop_playback: bool,
  /// 是否静音；首版视频壁纸始终静音，保留字段供后续音频能力使用。
  pub muted: bool,
  /// 播放速度（0.25–4.0）。
  pub rate: f32,
  /// `cover` / `contain` / `fill`。
  pub fit: String,
  /// `center` / `top` / `bottom` / `left` / `right`。
  pub position: String,
  /// 目标呈现帧率：24 / 30 / 60。
  pub preferred_fps: u16,
  /// `auto` / `required` / `disabled`。
  pub hardware_decode: String,
  /// `auto` / `shared` / `independent`；只影响 independent 显示模式。
  pub share: String,
}

impl Default for MediaConfig {
  fn default() -> Self {
    Self {
      asset_id: DEFAULT_ASSET_ID,
      loop_playback: true,
      muted: true,
      rate: DEFAULT_RATE,
      fit: DEFAULT_FIT.to_string(),
      position: DEFAULT_POSITION.to_string(),
      preferred_fps: DEFAULT_PREFERRED_FPS,
      hardware_decode: DEFAULT_HARDWARE_DECODE.to_string(),
      share: DEFAULT_SHARE.to_string(),
    }
  }
}

impl MediaConfig {
  /// 归一化：坏值只回退自身，不丢弃其它字段。
  #[must_use]
  pub fn normalized(mut self) -> Self {
    self.asset_id = self
      .asset_id
      .map(|id| id.trim().to_string())
      .filter(|id| !id.is_empty());
    // 首版没有音频输出，配置层保持“静音”是唯一可兑现的状态。
    self.muted = true;

    if self.fit.is_empty() || !FIT_VALUES.contains(&self.fit.as_str()) {
      self.fit = DEFAULT_FIT.to_string();
    }
    if self.position.is_empty() || !POSITION_VALUES.contains(&self.position.as_str()) {
      self.position = DEFAULT_POSITION.to_string();
    }
    if !FPS_VALUES.contains(&self.preferred_fps) {
      self.preferred_fps = DEFAULT_PREFERRED_FPS;
    }
    if !HARDWARE_VALUES.contains(&self.hardware_decode.as_str()) {
      self.hardware_decode = DEFAULT_HARDWARE_DECODE.to_string();
    }
    if !SHARE_VALUES.contains(&self.share.as_str()) {
      self.share = DEFAULT_SHARE.to_string();
    }
    if !self.rate.is_finite() {
      self.rate = DEFAULT_RATE;
    }
    self.rate = self.rate.clamp(0.25, 4.0);
    self
  }

  #[must_use]
  pub fn is_default(&self) -> bool {
    self == &Self::default()
  }

  /// 播放相关字段是否相同；用于判断配置变化是否需要重建媒体会话。
  #[must_use]
  pub fn playback_eq(&self, other: &Self) -> bool {
    self.asset_id == other.asset_id
      && self.loop_playback == other.loop_playback
      && self.rate == other.rate
      && self.hardware_decode == other.hardware_decode
      && self.share == other.share
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn default_config_is_serialized_without_media_section() {
    let display = crate::config::DisplayConfig::default();
    let json = serde_json::to_string(&display).unwrap();
    assert!(!json.contains("media"), "默认配置不应写 media 字段: {json}");
  }

  #[test]
  fn media_roundtrips_and_normalizes() {
    let config = MediaConfig {
      asset_id: Some(" m_123 ".into()),
      loop_playback: false,
      muted: false,
      rate: 9.0,
      fit: "bogus".into(),
      position: "bogus".into(),
      preferred_fps: 12,
      hardware_decode: "bogus".into(),
      share: "bogus".into(),
    }
    .normalized();
    assert_eq!(config.asset_id.as_deref(), Some("m_123"));
    assert!(!config.loop_playback);
    assert!(config.muted);
    assert_eq!(config.rate, 4.0);
    assert_eq!(config.fit, DEFAULT_FIT);
    assert_eq!(config.position, DEFAULT_POSITION);
    assert_eq!(config.preferred_fps, DEFAULT_PREFERRED_FPS);
    assert_eq!(config.hardware_decode, DEFAULT_HARDWARE_DECODE);
    assert_eq!(config.share, DEFAULT_SHARE);

    let json = serde_json::to_string(&config).unwrap();
    let back: MediaConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(back, config);
  }

  #[test]
  fn playback_eq_ignores_rendering_fields() {
    let a = MediaConfig::default();
    let mut b = a.clone();
    b.fit = "contain".into();
    b.position = "top".into();
    b.preferred_fps = 60;
    assert!(a.playback_eq(&b));

    b.asset_id = Some("m_2".into());
    assert!(!a.playback_eq(&b));
  }
}
