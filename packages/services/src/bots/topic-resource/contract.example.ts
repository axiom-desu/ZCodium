import { BotsTopicArchive, readAuthorizedTopicResource } from "./contract.js";

/** 宿主只依赖接纳归档与读取契约；provider 下载由 bots 服务注入。 */
export function exampleTopicResourceRead(
  archive: BotsTopicArchive,
  readConfig: Parameters<typeof readAuthorizedTopicResource>[1]["readConfig"],
  download: Parameters<typeof readAuthorizedTopicResource>[1]["download"],
) {
  return readAuthorizedTopicResource(
    {
      taskId: "task-a",
      inputId: "bot-input-a",
      messageId: "om_archive",
      resourceIndex: 0,
      workspacePath: "/workspace",
    },
    { archive, readConfig, download },
  );
}
