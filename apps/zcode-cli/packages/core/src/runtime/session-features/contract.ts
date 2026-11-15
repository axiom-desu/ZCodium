/**
 * 会话能力标签的公开入口（上游 3.18.2 F12，`x-zcode-session-features`）。
 * 打点只调 recordSessionFeature / recordSessionFeaturesFromToolResults /
 * recordSessionFeatureFromToolSearchExposure；出站请求只读 readSessionFeatures。
 */
export {
  parseSessionFeaturesEntryData,
  readSessionFeatures,
  recordSessionFeature,
  recordSessionFeatureFromToolSearchExposure,
  recordSessionFeaturesFromToolResults,
  restoreSessionFeaturesOnResume,
  sessionFeatureFromToolSearchExposure,
  sessionFeaturesFromPersistedMessages,
  sessionFeaturesFromToolResult,
  writeSessionFeaturesEntryAfterFirstPersist,
} from "./session-features.js";
