/**
 * 智能随机设置面板：Profile 选择/另存/删除 + 五个听感滑杆。
 *
 * 内置 profile 只读；用户 profile 可直接调整并自动保存。
 */
"use client";

import type {
  SmartShuffleConfig,
  SmartShuffleProfile,
  SmartShuffleProfileSummary,
} from "@lull/media-sdk";
import { Lock, Trash2, X } from "lucide-react";
import { type ReactElement, useEffect, useId, useRef, useState } from "react";
import { BUILTIN_PROFILE_COPY, profileDescription } from "./smart-shuffle";
import styles from "./smart-shuffle-panel.module.css";

type SmartShufflePanelProps = {
  profiles: SmartShuffleProfileSummary[];
  profile: SmartShuffleProfile | null;
  config: SmartShuffleConfig;
  onActivate: (profileId: string) => void;
  onChange: (next: SmartShuffleConfig) => void;
  onSaveAs: (name: string) => void;
  onDelete: () => void;
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
  disabled: boolean;
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
  disabled,
  onChange,
}: SliderRowProps): ReactElement {
  return (
    <label className={styles.sliderRow} htmlFor={id} data-disabled={disabled}>
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
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className={styles.hints}>
        <span>{low}</span>
        <span>{high}</span>
      </span>
    </label>
  );
}

export function SmartShufflePanel({
  profiles,
  profile,
  config,
  onActivate,
  onChange,
  onSaveAs,
  onDelete,
  onClose,
  onNotice,
}: SmartShufflePanelProps): ReactElement {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const customProfiles = profiles.filter((item) => !item.builtin);
  const readOnly = profile?.builtin !== false;

  useEffect(() => {
    closeRef.current?.focus();
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

  const submitSaveAs = (): void => {
    const name = saveName.trim();
    if (!name) {
      onNotice("请输入配置名称");
      return;
    }
    onSaveAs(name);
    setSaveName("");
    setSaveOpen(false);
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

      <div className={styles.profileRow}>
        <select
          className={styles.profileSelect}
          aria-label="智能随机配置"
          value={profile?.id ?? ""}
          onChange={(event) => {
            setConfirmDelete(false);
            onActivate(event.target.value);
          }}
          disabled={!profile || profiles.length === 0}
        >
          {profiles.length === 0 ? <option value="">加载中…</option> : null}
          {profiles.map((item) => (
            <option key={item.id} value={item.id}>
              {item.builtin
                ? (BUILTIN_PROFILE_COPY[item.id]?.label ?? item.name)
                : item.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="另存为新配置"
          title="另存为新配置"
          onClick={() => setSaveOpen((open) => !open)}
        >
          另存
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={confirmDelete ? "确认删除配置" : "删除当前配置"}
          title={confirmDelete ? "再次点击确认删除" : "删除当前配置"}
          disabled={!profile || profile.builtin}
          data-danger={confirmDelete ? "true" : "false"}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true);
              return;
            }
            setConfirmDelete(false);
            onDelete();
          }}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </div>
      {saveOpen ? (
        <div className={styles.saveRow}>
          <input
            className={styles.saveInput}
            value={saveName}
            maxLength={40}
            placeholder="配置名称"
            aria-label="新配置名称"
            onChange={(event) => setSaveName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSaveAs();
              if (event.key === "Escape") {
                event.stopPropagation();
                setSaveOpen(false);
              }
            }}
          />
          <button
            type="button"
            className={styles.iconButton}
            onClick={submitSaveAs}
          >
            保存
          </button>
        </div>
      ) : null}

      <p className={styles.hint}>
        {readOnly
          ? "内置配置只读；调整参数前请先「另存」为自定义配置。"
          : profile
            ? profileDescription(profile.id)
            : "加载中…"}
        {customProfiles.length > 0
          ? ` · 自定义 ${customProfiles.length} 个`
          : ""}
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
          disabled={readOnly}
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
          disabled={readOnly}
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
          disabled={readOnly}
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
          disabled={readOnly}
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
          disabled={readOnly}
          onChange={(album) => changeSeparation({ album })}
        />
      </div>

      <footer className={styles.foot}>
        <span className={styles.note}>
          <Lock aria-hidden="true" />
          一轮内不重复 · 已固定开启
        </span>
      </footer>
    </section>
  );
}
