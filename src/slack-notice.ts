import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { deliverChannelPayload } from "./channel-delivery.js";
import type { SessionRoute } from "./types.js";

type SlackNoticeParams = {
  route: SessionRoute;
  text: string;
};

export async function sendSlackContinuationNotice(
  api: OpenClawPluginApi,
  params: SlackNoticeParams,
): Promise<void> {
  if (params.route.channel !== "slack" || !params.route.to) {
    throw new Error("missing Slack route for continuation notice");
  }

  const payload = { text: params.text };
  await deliverChannelPayload(api, {
    channel: "slack",
    operation: "continuation notice",
    to: params.route.to,
    text: params.text,
    payload,
    threadId: params.route.threadId,
    accountId: params.route.accountId,
  });
}
