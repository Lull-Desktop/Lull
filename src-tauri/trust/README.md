# 发布者信任根

`publisher-keys.json` 是宿主内置的社区发布者公钥清单，**随二进制编译**，运行时不会从网络读取。

## 来源

由社区仓库生成：

```bash
cd ../Lull-Community
node scripts/export-host-trust.mjs --out ../lull-app/src-tauri/trust/publisher-keys.json
```

信任包字段：

- `keyId`：Ed25519 SPKI DER 的 SHA-256 前 16 位 hex；
- `publicKey`：raw 32 字节公钥的 base64；
- `fingerprint`：SPKI DER 的 SHA-256 全量 hex；
- `notBefore` / `retiredAt` / `revoked`：密钥生命周期。

`src-tauri/src/content_trust/keys.rs` 会在启动/test 时重新推导 keyId 与 fingerprint，
不一致直接拒绝。`content_trust::keys::tests` 还钉住了当前社区密钥：

- keyId `279aff591d2627ed`
- fingerprint `279aff591d2627ed6c5f78fafcdffaae1dc5362c97c9fc1d2efb71035fe22eb8`

## 轮换

新增公钥后需要发一次宿主版本；旧公钥保留用于验证历史包。撤销密钥同样要发版：
本轮不做远端信任更新/撤销列表。
