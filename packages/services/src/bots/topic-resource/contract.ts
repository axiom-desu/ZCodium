/**
 * 话题资源读取的公开契约：只有任务已接纳快照内的资源可读。
 * 授权与下载细节留在 `../topicResource.ts`，调用方不解析 provider 载荷。
 */
export {
  authorizeTopicResource,
  readAuthorizedTopicResource,
  topicResourceRequestOf,
  type TopicResourceDependencies,
  type TopicResourceReadResult,
  type TopicResourceRequest,
  type TopicResourceTarget,
} from "../topicResource.js";
export { BotsTopicArchive } from "../topicArchive.js";
