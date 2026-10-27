/**
 * 页面级布局常量。
 *
 * 原样式表里的 `.container` / `.section` / `.section--tight` 在这里变成三段共享的
 * 工具类字符串：容器宽度、页面留白、版块节奏各自只有一个来源，
 * 页面和组件都从这里取，不在各处手写像素。
 */

/** 居中容器：1120px + 左右 24px（原 .container） */
export const container = "mx-auto w-full max-w-site px-6";

/** 常规版块上下留白（原 .section） */
export const section = "py-section";

/** 紧凑版块上下留白（原 .section--tight） */
export const sectionTight = "py-section-tight";
