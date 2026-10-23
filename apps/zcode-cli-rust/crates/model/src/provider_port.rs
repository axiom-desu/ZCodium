//! `ModelPort` 实现：身份/能力/预算投影与带选项的 `complete`。
//! 作为 [`super`]（provider）的子模块，可直接使用 `HttpModel` 的私有字段。
use super::*;

#[async_trait::async_trait]
impl ModelPort for HttpModel {
    fn identity(&self) -> Option<crate::contract::ModelIdentity> {
        Some(crate::contract::ModelIdentity {
            provider_id: self.config.provider_id.clone(),
            model_id: self.config.model_id.clone(),
            reasoning_level: self.config.reasoning_level.clone(),
        })
    }
    fn format_properties(&self) -> Value {
        self.config.format_properties.clone().unwrap_or_else(|| serde_json::json!({"inputFormat":{"supportsText":true,"supportsImage":false,"supportsVideo":false,"supportsAudio":false,"supportsPdf":false},"outputFormat":{"supportsText":true},"supportsToolCall":true}))
    }
    fn auxiliary(&self) -> Option<Arc<dyn ModelPort>> {
        self.with_max_output_tokens(4096).ok().flatten()
    }
    fn supports_native_web_search(&self) -> bool {
        self.config.supports_native_web_search
    }
    fn account_auth(&self) -> bool {
        self.config.account_access.is_some()
    }
    fn with_max_output_tokens(
        &self,
        max: usize,
    ) -> anyhow::Result<Option<std::sync::Arc<dyn ModelPort>>> {
        anyhow::ensure!(max > 0, "Invalid output token limit");
        let mut config = self.config.clone();
        config.max_output_tokens = max.min(config.max_output_tokens);
        if let Some(map) = &config.max_output_map {
            let patch = crate::domain::option_map::evaluate(
                map,
                "maxOutputTokens",
                &serde_json::json!(config.max_output_tokens),
            )?;
            config.option_patches[1] = patch;
            crate::domain::option_map::validate_patches(&config.option_patches)?;
        }
        Ok(Some(Arc::new(Self::new(config, self.egress.clone()))))
    }
    fn context_policy(&self) -> crate::domain::context::ContextPolicy {
        crate::domain::context::ContextPolicy {
            window: self.config.context_window,
            max_output: self.config.max_output_tokens,
            buffer: self.config.context_buffer_tokens,
            automatic: self.config.auto_compact,
        }
    }
    fn tool_search_capability(&self) -> Option<crate::contract::ToolSearchCapability> {
        // 能力来自实际非秘密配置；默认关闭，不在未声明时伪造 protocol 支持。
        Some(crate::tool_search::capability(&self.config))
    }
    async fn complete(
        &self,
        messages: Vec<Value>,
        tools: &[Value],
        sink: &EventSink,
        cancel: &CancellationToken,
    ) -> Result<ModelOutput> {
        // 既有调用方保持不变：缺省选项与旧行为完全一致。
        self.complete_with_options(
            messages,
            tools,
            &ModelRequestOptions::default(),
            sink,
            cancel,
        )
        .await
    }
    async fn complete_with_options(
        &self,
        messages: Vec<Value>,
        tools: &[Value],
        options: &ModelRequestOptions,
        sink: &EventSink,
        cancel: &CancellationToken,
    ) -> Result<ModelOutput> {
        // 非 Anthropic 协议的 native 请求在发送前拒绝（Node 同样在编码前报错）。
        if options.tool_search_enabled {
            crate::tool_search::ensure_native(&self.config)?;
        }
        let current = std::sync::Mutex::new(None);
        // Node 每次模型调用（含其重试）共用一个 logicalCallId。
        let logical_call = uuid::Uuid::new_v4().to_string();
        let result = tokio::select! {biased;
            _=cancel.cancelled()=>Err(ModelFailure::cancelled()),
            result=self.complete_inner(messages,tools,options,sink,(&current,&logical_call))=>return result,
        };
        let attempt = current.lock().unwrap().take();
        if let Some(attempt) = attempt {
            let reporter = Reporter {
                config: &self.config,
                origin: &sink.origin,
                max_attempts: self.retry.max_attempts,
                logical_call: &logical_call,
            };
            let failure = ModelFailure::cancelled();
            let status = reporter.failed(&attempt, &failure, false, self.idle_ms(attempt.budget()));
            let _ = sink.send(Event::ModelStatus(status)).await;
        }
        result
    }
}
