/**
 * 智能随机设置面板：预设 + 五个听感滑杆 + 复制配置 JSON。
 *
 * 不展示 BPM / 能量 / 偏好学习等尚未生效的参数；一轮内不重复等约束
 * 固定在 Rust 侧，这里只做说明。
 */
"use client";

import type { SmartShuffleConfig } from "@lull/media-sdk";
import { Lock, X } from "lucide-react";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import {
  applySmartShufflePreset,
  SMART_SHUFFLE_PRESETS,
  smartShufflePresetId,
  smartShuffleUserJson,
} from "./smart-shuffle";
import styles from "./smart-shuffle-panel.module.css";

type SmartShufflePanelProps = {
  config: SmartShuffleConfig;
  onChange: (next: SmartShuffleConfig) => void;
  onClose: () => void;
  onNotice: (message: string) => void;
};

type SliderRowProps = {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  low: string;
  high: string;
  onChange: (value: number) => void;
};

function SliderRow({
  id,
  label,
  value,
  min,
  max,
  suffix = "",
  low,
  high,
  onChange,
}: SliderRowProps): ReactElement {
  return (
    <label className={styles.sliderRow} htmlFor={id}>
      <span className={styles.sliderHead}>
        <span className={styles.sliderLabel}>{label}</span>
        <strong className={styles.sliderValue}>
          {value}
          {suffix}
        </strong>
      </span>
      <input
        id={id}
        className={styles.range}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className={styles.hints}>
        <span>{low}</span>
        <span>{high}</span>
      </span>
    </label>
  );
}

function copyWithFallback(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function SmartShufflePanel({
  config,
  onChange,
  onClose,
  onNotice,
}: SmartShufflePanelProps): ReactElement {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const copyTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const presetId = smartShufflePresetId(config);
  const activePreset = SMART_SHUFFLE_PRESETS.find(
    (preset) => preset.id === presetId,
  );

  useEffect(() => {
    closeRef.current?.focus();
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  const changeExperience = (
    patch: Partial<SmartShuffleConfig["experience"]>,
  ): void => {
    onChange({
      ...config,
      experience: { ...config.experience, ...patch },
    });
  };

  const changeSeparation = (
    patch: Partial<SmartShuffleConfig["separation"]>,
  ): void => {
    onChange({
      ...config,
      separation: { ...config.separation, ...patch },
    });
  };

  const copyConfig = (): void => {
    const text = smartShuffleUserJson(config);
    const finish = (ok: boolean): void => {
      setCopyState(ok ? "copied" : "failed");
      onNotice(ok ? "已复制配置" : "复制失败");
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopyState("idle");
      }, 1600);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => finish(true),
        () => finish(copyWithFallback(text)),
      );
      return;
    }
    finish(copyWithFallback(text));
  };

  return (
    <section className={styles.panel} role="dialog" aria-labelledby={titleId}>
      <header className={styles.head}>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>SMART SHUFFLE</p>
          <h2 className={styles.title} id={titleId}>
            智能随机设置
          </h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          className={styles.close}
          aria-label="关闭智能随机设置"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <fieldset className={styles.presets} aria-label="智能随机预设">
        <legend className={styles.legend}>智能随机预设</legend>
        {SMART_SHUFFLE_PRESETS.map((preset) => {
          const active = presetId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              className={styles.preset}
              data-active={active ? "true" : "false"}
              aria-pressed={active}
              onClick={() => onChange(applySmartShufflePreset(config, preset))}
            >
              {preset.label}
            </button>
          );
        })}
      </fieldset>
      <p className={styles.hint}>
        {activePreset?.description ?? "自定义：当前参数与预设不同。"}
      </p>

      <div className={styles.body}>
        <SliderRow
          id={`${titleId}-randomness`}
          label="随机程度"
          value={config.experience.randomness}
          min={0}
          max={100}
          low="偏向高分"
          high="更均匀"
          onChange={(randomness) => changeExperience({ randomness })}
        />
        <SliderRow
          id={`${titleId}-diversity`}
          label="曲风多样性"
          value={config.experience.diversity}
          min={0}
          max={100}
          low="允许相似"
          high="尽量切换"
          onChange={(diversity) => changeExperience({ diversity })}
        />
        <SliderRow
          id={`${titleId}-repeat`}
          label="重复规避"
          value={config.experience.repeatAvoidance}
          min={0}
          max={100}
          low="少回避"
          high="强回避"
          onChange={(repeatAvoidance) => changeExperience({ repeatAvoidance })}
        />
        <SliderRow
          id={`${titleId}-artist`}
          label="歌手间隔"
          value={config.separation.artist}
          min={0}
          max={10}
          suffix=" 首"
          low="不限制"
          high="间隔越大越分散"
          onChange={(artist) => changeSeparation({ artist })}
        />
        <SliderRow
          id={`${titleId}-album`}
          label="专辑间隔"
          value={config.separation.album}
          min={0}
          max={10}
          suffix=" 首"
          low="不限制"
          high="间隔越大越分散"
          onChange={(album) => changeSeparation({ album })}
        />
      </div>

      <footer className={styles.foot}>
        <span className={styles.note}>
          <Lock aria-hidden="true" />
          一轮内不重复 · 已固定开启
        </span>
        <button type="button" className={styles.copy} onClick={copyConfig}>
          {copyState === "copied"
            ? "已复制"
            : copyState === "failed"
              ? "复制失败"
              : "复制配置 JSON"}
        </button>
      </footer>
    </section>
  );
}
