# extension-slots

UI 扩展槽位：只消费 `services/extensions` 的投影（`ExtensionsSnapshot`）。没有扩展服务的环境
（手机远控、Web、旧 Host）一律 `available=false`，不渲染扩展 UI、不显示启动入口。

- 槽位投影必须同时匹配 `slot` 与当前 `generation`；旧代际槽位即使仍在缓存里也不渲染。
- 待授权（needs-consent）插件只在状态区显示，用户必须显式启用；授权请求提交的是当前声明档位，
  服务端按声明是否变化判定过期。
- 组件不推断授权或进程状态：`phase`、`slots`、`pending` 全部来自服务快照。
- 图标只来自固定枚举，未知值回退 `puzzle`；标题按纯文本渲染，不注入 HTML。
- 真实的槽位组件测试渲染 `ExtensionStatusSlotView`，不复制选择/隐藏逻辑。
