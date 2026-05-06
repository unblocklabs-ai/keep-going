import test from "node:test";
import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { KEEP_GOING_SYNTHETIC_WAKE_PREFIX } from "../src/constants.js";
import { launchContinuation } from "../src/launcher.js";
import type { LaunchContinuationParams } from "../src/types.js";

function createLaunchParams(): LaunchContinuationParams {
  return {
    candidate: {
      runId: "run-1",
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:slack:channel:c123:thread:1712345678.000100",
      workspaceDir: "/workspace",
      modelProviderId: "openai-codex",
      modelId: "gpt-5.4",
      messageProvider: "slack",
      channelId: "slack",
      trigger: "user",
      success: true,
      messages: [],
    },
    decision: {
      continue: true,
      reason: "unfinished work remains",
      followUpInstruction: "Keep going until the task is complete.",
    },
    sessionRoute: {
      lookupStatus: "ok",
      isSlack: true,
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.000100",
      currentChannelId: "C123",
      replyToMode: "all",
    },
    wakeContext: {
      currentMessageId: "1776309280.777379",
      currentChannelId: "C123",
      currentThreadTs: "1712345678.000100",
      replyToMode: "all",
    },
    sessionFile: "/virtual/session.jsonl",
    timeoutMs: 60_000,
  };
}

test("plugin-started continuation replies route to the stored Slack thread with the synthetic wake prompt", async () => {
  const params = createLaunchParams();
  const deliveredPayloads: Array<Record<string, unknown>> = [];
  let embeddedParams: Record<string, unknown> | undefined;

  const api = {
    config: {
      channels: {
        slack: {
          replyToMode: "all",
        },
      },
    },
    runtime: {
      channel: {
        reply: {
          resolveEffectiveMessagesConfig: () => ({ messagePrefix: "", responsePrefix: undefined }),
          resolveHumanDelayConfig: () => undefined,
        },
        outbound: {
          loadAdapter: async (channelId: string) => {
            assert.equal(channelId, "slack");
            return {
              sendPayload: async (ctx: Record<string, unknown>) => {
                deliveredPayloads.push(ctx);
                return { ok: true };
              },
            };
          },
        },
      },
      agent: {
        runEmbeddedPiAgent: async (runParams: Record<string, unknown>) => {
          embeddedParams = runParams;
          assert.equal(typeof runParams.prompt, "string");
          assert.match(String(runParams.prompt), new RegExp(`^\\${KEEP_GOING_SYNTHETIC_WAKE_PREFIX}`));
          assert.match(
            String(runParams.prompt),
            /A validator thinks your previous turn may have ended before the task was fully handled\./,
          );
          assert.match(
            String(runParams.prompt),
            /Reassess the latest conversation state\./,
          );
          assert.match(
            String(runParams.prompt),
            /do not invent work\./,
          );
          assert.match(
            String(runParams.prompt),
            /Use a normal assistant reply only when you intend to end your turn\./,
          );
          assert.match(
            String(runParams.prompt),
            /If blocked, state the exact blocker briefly\. If there is nothing useful to do, reply `NO_REPLY`\./,
          );
          assert.match(
            String(runParams.prompt),
            /Validator-suggested next step: Keep going until the task is complete\./,
          );
          assert.equal(runParams.transcriptPrompt, runParams.prompt);
          assert.equal(typeof runParams.onBlockReply, "function");
          assert.equal(typeof runParams.onToolResult, "function");

          await (runParams.onBlockReply as (payload: { text: string }) => Promise<void>)({
            text: "It woke cleanly on 0.1.8...",
          });

          return {} as never;
        },
      },
    },
  } as unknown as OpenClawPluginApi;

  await launchContinuation(api, params);

  assert.ok(embeddedParams);
  assert.equal(deliveredPayloads.length, 1);
  assert.equal(deliveredPayloads[0]?.to, "channel:C123");
  assert.equal(deliveredPayloads[0]?.threadId, "1712345678.000100");
  assert.equal(deliveredPayloads[0]?.replyToId, undefined);
  assert.equal(deliveredPayloads[0]?.accountId, "default");
  assert.deepEqual(deliveredPayloads[0]?.payload, {
    text: "It woke cleanly on 0.1.8...",
  });
});

test("continuation launch fails when reply dispatch fails", async () => {
  const params = createLaunchParams();

  const api = {
    config: {
      channels: {
        slack: {
          replyToMode: "all",
        },
      },
    },
    runtime: {
      channel: {
        reply: {
          resolveEffectiveMessagesConfig: () => ({ messagePrefix: "", responsePrefix: "[bot]" }),
          resolveHumanDelayConfig: () => undefined,
        },
        outbound: {
          loadAdapter: async () => ({
            sendPayload: async () => {
              throw new Error("slack transport offline");
            },
          }),
        },
      },
      agent: {
        runEmbeddedPiAgent: async (runParams: Record<string, unknown>) => {
          await (runParams.onBlockReply as (payload: { text: string }) => Promise<void>)({
            text: "Internal reply that never lands",
          });

          return {} as never;
        },
      },
    },
  } as unknown as OpenClawPluginApi;

  await assert.rejects(
    () => launchContinuation(api, params),
    /continuation reply dispatch failed \(tool=0, block=1, final=0\)/,
  );
});
