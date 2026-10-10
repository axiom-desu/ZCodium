# ZCodium 搜图插件

[English](./README.md)

连接你自己的网络搜图 MCP 服务。本插件不含搜图后端、不含本地图库、不要求 ZCode 账号，
也没有默认服务器。

## 为什么不指向官方服务

上游那份插件注册的是官方搜图 MCP 服务，使用 ZCode 官方 JWT 鉴权——意味着每次搜图都会把你
的登录凭据发往该服务。本仓库改为**只连你自己配置的端点**：后端由你部署或选择，请求与凭据只
发给你指定的服务。这个决定与实现记录在
[`.agents/specs/image-search-local-backend.md`](../../../../.agents/specs/image-search-local-backend.md)。

## 配置

插件默认关闭。打开 **Image Search** 插件的设置：

1. 在 **MCP URL** 里填服务的完整 HTTP MCP 端点（含路径）。ZCodium 不会替你补路径。
2. 服务需要令牌时，在 **Authorization** 里填完整的请求头，例如 `Bearer YOUR_TOKEN`。该字段
   会打码显示。公开端点或使用标准 MCP OAuth 的服务留空即可；留空时不发送 Authorization 头。
3. 保存后启用插件，并新建一个会话以加载配置好的工具。

自建端点形如 `https://images.example.com/mcp`。请填服务方给出的地址，不要填它的主页。需要
其它请求头或自定义 OAuth 的服务，请改用应用里的通用 MCP 配置。

未填 URL 之前插件不会发起任何连接；缺少必填项由插件配置界面提示。连接失败时先核对端点与
凭据，再从 MCP 设置重试。

## 使用

用自然语言提出配图需求即可。可用工具与搜索结果都来自你选择的服务——插件把它们注册在
`image_search` 这个 MCP 服务器名下。请求 90 秒超时。

搜索词与你配置的凭据会发往该服务；不会有自动的官方鉴权、订阅查询或回退搜图源。
