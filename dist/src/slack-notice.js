import { deliverChannelPayload } from "./channel-delivery.js";
export async function sendSlackContinuationNotice(api, params) {
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
