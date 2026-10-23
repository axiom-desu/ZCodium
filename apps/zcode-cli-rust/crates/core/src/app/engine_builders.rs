//! Startup options of the engine.
use super::Engine;
use serde_json::Value;
use std::sync::Arc;

impl Engine {
    /// Config file `permission` section (mode fallback, allowed/disallowed tools),
    /// read once at startup like Node's app creation.
    pub fn with_permission_config(mut self, permission: &Value) -> Self {
        self.permissions.config = crate::domain::permission::Config::from_config(permission);
        self.permissions.config_mode = permission["mode"].as_str().map(str::to_owned);
        self
    }
    pub fn with_registry(
        mut self,
        registry: Option<Arc<dyn crate::contract::ModelRegistry>>,
        workspace_path: String,
    ) -> Self {
        self.registry = registry;
        self.workspace_path = workspace_path;
        if let Some(registry) = &self.registry {
            self.config = registry.default_selection();
        }
        self
    }
    /// Node protocol sessions generate their title after the first input
    /// (`titleGeneration: {}` of `createRecord`); `-p` and embedders do not.
    pub fn with_title_generation(mut self, enabled: bool) -> Self {
        self.titles = enabled;
        self
    }
    /// CLI prompt/TUI 的 `--toolsearch-mode`：只影响新建与冷恢复的 runtime，不写 session。
    pub fn with_tool_search_mode(mut self, mode: crate::domain::tool_search::Mode) -> Self {
        self.tool_search_mode = mode;
        self.tool_search_override = Some(mode);
        self
    }
    /// app-server 的显式 CLI 覆盖；`None` 表示允许 Host runtimeConfig 决定。
    pub fn with_tool_search_override(
        mut self,
        mode: Option<crate::domain::tool_search::Mode>,
    ) -> Self {
        self.tool_search_override = mode;
        self
    }
    /// 本次 create/resume 的实际模式：显式 CLI > Host runtimeConfig > 缺省 Off。
    pub(super) fn session_tool_search_mode(
        &self,
        params: &Value,
    ) -> crate::domain::tool_search::Mode {
        self.tool_search_override
            .or_else(|| {
                params
                    .get("runtimeConfig")
                    .and_then(|config| config["toolSearch"]["mode"].as_str())
                    .and_then(crate::domain::tool_search::Mode::parse)
            })
            .unwrap_or(self.tool_search_mode)
    }
}
