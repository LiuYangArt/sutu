# macOS Release Secrets 配置说明（GitHub Actions）

本文用于记录 `release.yml` / `package-preview.yml` 在 macOS 打包时需要的 GitHub Secrets，方便后续一次性补齐。

## 1. 需要配置的 Secrets

在仓库 `Settings -> Secrets and variables -> Actions -> New repository secret` 中创建以下条目：

1. `APPLE_SIGNING_IDENTITY`
2. `APPLE_CERTIFICATE`
3. `APPLE_CERTIFICATE_PASSWORD`
4. `APPLE_ID`
5. `APPLE_PASSWORD`
6. `APPLE_TEAM_ID`

## 2. 每个 Secret 的来源

### `APPLE_SIGNING_IDENTITY`

用途：`codesign` 使用的签名身份名称。  
获取方式（在安装了证书的 macOS 上执行）：

```bash
security find-identity -v -p codesigning
```

从输出中复制完整名称，例如：

```text
Developer ID Application: Your Name (TEAMID)
```

---

### `APPLE_CERTIFICATE`

用途：CI 中导入签名证书。  
来源：`Developer ID Application` 证书导出的 `.p12` 文件（base64 单行字符串）。

导出 `.p12` 后执行：

```bash
base64 -i ./DeveloperID.p12 | tr -d '\n'
```

把输出整串填入 `APPLE_CERTIFICATE`。

---

### `APPLE_CERTIFICATE_PASSWORD`

用途：解密 `.p12`。  
来源：导出 `.p12` 时你设置的密码。

---

### `APPLE_ID`

用途：notarization 登录账号。  
来源：Apple Developer 账号邮箱。

---

### `APPLE_PASSWORD`

用途：notarization 登录凭据。  
来源：`appleid.apple.com` 生成的 App-Specific Password（不是 Apple ID 登录密码）。

---

### `APPLE_TEAM_ID`

用途：notarization 指定团队。  
来源：Apple Developer 后台团队信息中的 Team ID（通常是 10 位字符串）；也可从签名身份括号中看到。

## 3. 当前没有证书时怎么办

当你暂时没有 Apple Developer 证书时：

1. 先不配置上述 6 个 secrets（或仅留空）。
2. 直接跑 `package-preview` / `release`。
3. workflow 会自动回退到 ad-hoc 模式（`APPLE_SIGNING_IDENTITY=-`）进行签名。

说明：

1. 这能避免“损坏签名”类型的问题（已加入 CI 验签步骤）。
2. 但对外分发仍建议尽快补齐 `Developer ID + Notarization`，否则下载后可能被 Gatekeeper 拦截。

## 4. 验证清单（拿到新包后）

安装后在本机执行：

```bash
codesign --verify --deep --strict --verbose=2 /Applications/Sutu.app
```

预期至少应看到：

```text
valid on disk
```

若是从浏览器下载的包，仍可能带隔离属性，可检查：

```bash
xattr -p com.apple.quarantine /Applications/Sutu.app
```

有输出表示带 quarantine 标记。

## 5. 你之后需要做的一次性动作

1. Apple ID 资格可用后，加入 Apple Developer Program。
2. 申请 `Developer ID Application` 证书并导出 `.p12`。
3. 在 GitHub 一次性补齐 6 个 secrets。
4. 重新触发 release，验证签名与安装流程。
