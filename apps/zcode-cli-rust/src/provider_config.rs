//! Standalone CLI provider discovery. Host-managed app-server keeps its existing env contract.
use anyhow::{Result, bail, ensure};
use std::path::{Path, PathBuf};
use zcode_cli_domain::path_names::ZCODE_USER_DATA_DIR_NAME;
use zcode_cli_net::RuntimeEnv;

pub struct ProviderPaths {
    pub builtin: PathBuf,
    pub personal: PathBuf,
}

fn explicit<'a>(env: &'a RuntimeEnv, key: &str) -> Option<&'a str> {
    env.get(key)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub async fn discover(
    home: &Path,
    env: &RuntimeEnv,
    executable: &Path,
    checkout: &Path,
) -> Result<ProviderPaths> {
    let base = explicit(env, "ZCODE_DATA_BASE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.to_owned());
    let config = base.join(ZCODE_USER_DATA_DIR_NAME).join("v2");
    let personal = explicit(env, "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| config.join("provider_config.json"));
    if let Some(path) = explicit(env, "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE") {
        // 显式路径由原 Registry 校验；不能把坏配置静默替换成另一份。
        return Ok(ProviderPaths {
            builtin: path.into(),
            personal,
        });
    }
    let mut candidates = vec![config.join("runtime/provider/bundled/zcode-builtin.json")];
    if let Some(resources) = executable.parent().and_then(Path::parent) {
        candidates.push(resources.join("config/provider/zcode-builtin.json"));
        candidates.push(resources.join("glm/provider/zcode-builtin.json"));
    }
    // 安装包缺资源时不能借本机源码树掩盖问题；Cargo 仅允许自己的 target 锚点。
    if executable.starts_with(checkout.join("target"))
        && let Some(root) = checkout.parent().and_then(Path::parent)
    {
        candidates.push(root.join("config/provider/zcode-builtin.json"));
    }
    for path in candidates {
        match tokio::fs::metadata(&path).await {
            Ok(meta) => {
                ensure!(
                    meta.is_file(),
                    "Provider configuration must be a regular file"
                );
                return Ok(ProviderPaths {
                    builtin: path,
                    personal,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => bail!("Cannot inspect ZCodium provider configuration"),
        }
    }
    bail!(
        "Cannot locate ZCodium built-in provider configuration; reinstall the package or set ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"
    )
}

#[cfg(test)]
#[path = "provider_config_tests.rs"]
mod tests;
