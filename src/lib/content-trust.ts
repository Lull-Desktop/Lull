/**
 * 发布签名策略的前端客户端。
 *
 * 策略在 Rust 侧持久化并参与安装/启用门禁；这里只负责读写，
 * 不在前端重复实现 `allow / warn / block` 的判断。
 */
import { invoke } from "@tauri-apps/api/core";

export type TrustPolicy = {
  requireSignature: boolean;
};

const DEFAULT_POLICY: TrustPolicy = { requireSignature: false };

export async function getTrustPolicy(): Promise<TrustPolicy> {
  const policy = await invoke<TrustPolicy>("content_trust_policy_get");
  return policy ?? DEFAULT_POLICY;
}

export async function setTrustPolicy(
  requireSignature: boolean,
): Promise<TrustPolicy> {
  const policy = await invoke<TrustPolicy>("content_trust_policy_set", {
    requireSignature,
  });
  return policy ?? { requireSignature };
}
