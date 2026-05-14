import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolvePayloadMediaUrls,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";

export type ChannelPayloadDeliveryParams = {
  channel: string;
  operation: string;
  to: string;
  text: string;
  payload: ReplyPayload;
  threadId?: string;
  replyToId?: string;
  accountId?: string;
};

export async function deliverChannelPayload(
  api: OpenClawPluginApi,
  params: ChannelPayloadDeliveryParams,
): Promise<void> {
  const adapter = await api.runtime.channel.outbound.loadAdapter(params.channel);
  if (!adapter) {
    throw new Error(`missing outbound adapter for channel ${params.channel}`);
  }

  const deliveryContext = {
    cfg: api.config,
    to: params.to,
    text: params.text,
    payload: params.payload,
    threadId: params.threadId,
    replyToId: params.replyToId,
    accountId: params.accountId,
  };

  if (adapter.sendPayload) {
    await adapter.sendPayload(deliveryContext);
    return;
  }

  const mediaUrls = resolvePayloadMediaUrls(params.payload);
  const payloadText = typeof params.payload.text === "string" ? params.payload.text : "";
  const canSendWithFallback =
    mediaUrls.length > 0
      ? Boolean(adapter.sendMedia)
      : payloadText
        ? Boolean(adapter.sendText)
        : Boolean(adapter.sendText || adapter.sendMedia);

  if (canSendWithFallback) {
    await sendTextMediaPayload({
      channel: params.channel,
      ctx: deliveryContext,
      adapter,
    });
    return;
  }

  throw new Error(`channel ${params.channel} cannot deliver ${params.operation}`);
}
