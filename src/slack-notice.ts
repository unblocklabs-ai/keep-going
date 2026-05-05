import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
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

  const adapter = await api.runtime.channel.outbound.loadAdapter("slack");
  if (!adapter) {
    throw new Error("missing outbound adapter for channel slack");
  }

  const payload = { text: params.text };
  const deliveryContext = {
    cfg: api.config,
    to: params.route.to,
    text: params.text,
    payload,
    threadId: params.route.threadId,
    accountId: params.route.accountId,
  };

  if (adapter.sendPayload) {
    await adapter.sendPayload(deliveryContext);
    return;
  }

  if (adapter.sendText || adapter.sendMedia) {
    await sendTextMediaPayload({
      channel: "slack",
      ctx: deliveryContext,
      adapter,
    });
    return;
  }

  throw new Error("channel slack cannot deliver continuation notice");
}
