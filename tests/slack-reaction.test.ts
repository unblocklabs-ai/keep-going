import test from "node:test";
import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { addSlackReaction } from "../src/slack-reaction.js";

type FetchCall = {
  url: string | URL | Request;
  init?: RequestInit;
};

function createApi(config: Record<string, unknown>): OpenClawPluginApi {
  return {
    config,
  } as OpenClawPluginApi;
}

function createFetch(response: Response, calls: FetchCall[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as typeof fetch;
}

function readFormBody(init?: RequestInit): URLSearchParams {
  assert.ok(init?.body instanceof URLSearchParams);
  return init.body;
}

test("addSlackReaction posts reactions.add with root Slack bot token and normalized emoji", async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = createFetch(Response.json({ ok: true }), calls);

  await addSlackReaction(
    createApi({
      channels: {
        slack: {
          botToken: "xoxb-root",
        },
      },
    }),
    {
      channelId: "C123",
      messageId: "1776309280.777379",
      emoji: ":eyes:",
    },
    { fetchImpl },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://slack.com/api/reactions.add");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer xoxb-root");
  assert.equal(
    (calls[0]?.init?.headers as Record<string, string>)["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  const body = readFormBody(calls[0]?.init);
  assert.equal(body.get("channel"), "C123");
  assert.equal(body.get("timestamp"), "1776309280.777379");
  assert.equal(body.get("name"), "eyes");
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
});

test("addSlackReaction prefers account-specific Slack bot token", async () => {
  const calls: FetchCall[] = [];
  const fetchImpl = createFetch(Response.json({ ok: true }), calls);

  await addSlackReaction(
    createApi({
      channels: {
        slack: {
          botToken: "xoxb-root",
          accounts: {
            team2: {
              botToken: "xoxb-team2",
            },
          },
        },
      },
    }),
    {
      channelId: "C234",
      messageId: "1776309280.888000",
      emoji: "eyes",
      accountId: "team2",
    },
    { fetchImpl },
  );

  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer xoxb-team2");
});

test("addSlackReaction falls back to SLACK_BOT_TOKEN for default account", async () => {
  const original = process.env.SLACK_BOT_TOKEN;
  const calls: FetchCall[] = [];
  const fetchImpl = createFetch(Response.json({ ok: true }), calls);
  process.env.SLACK_BOT_TOKEN = "xoxb-env";
  try {
    await addSlackReaction(
      createApi({
        channels: {
          slack: {},
        },
      }),
      {
        channelId: "C123",
        messageId: "1776309280.777379",
        emoji: "eyes",
      },
      { fetchImpl },
    );
  } finally {
    if (original === undefined) {
      delete process.env.SLACK_BOT_TOKEN;
    } else {
      process.env.SLACK_BOT_TOKEN = original;
    }
  }

  assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer xoxb-env");
});

test("addSlackReaction treats already_reacted as success", async () => {
  await addSlackReaction(
    createApi({
      channels: {
        slack: {
          botToken: "xoxb-root",
        },
      },
    }),
    {
      channelId: "C123",
      messageId: "1776309280.777379",
      emoji: "eyes",
    },
    {
      fetchImpl: createFetch(Response.json({ ok: false, error: "already_reacted" })),
    },
  );
});

test("addSlackReaction throws for Slack API errors", async () => {
  await assert.rejects(
    addSlackReaction(
      createApi({
        channels: {
          slack: {
            botToken: "xoxb-root",
          },
        },
      }),
      {
        channelId: "C123",
        messageId: "1776309280.777379",
        emoji: "eyes",
      },
      {
        fetchImpl: createFetch(Response.json({ ok: false, error: "missing_scope" })),
      },
    ),
    /Slack reaction request failed: missing_scope/,
  );
});

test("addSlackReaction throws for non-2xx HTTP responses", async () => {
  await assert.rejects(
    addSlackReaction(
      createApi({
        channels: {
          slack: {
            botToken: "xoxb-root",
          },
        },
      }),
      {
        channelId: "C123",
        messageId: "1776309280.777379",
        emoji: "eyes",
      },
      {
        fetchImpl: createFetch(new Response("gateway unavailable", { status: 503 })),
      },
    ),
    /Slack reaction request failed with HTTP 503/,
  );
});

test("addSlackReaction times out pending Slack requests", async () => {
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    })) as typeof fetch;

  await assert.rejects(
    addSlackReaction(
      createApi({
        channels: {
          slack: {
            botToken: "xoxb-root",
          },
        },
      }),
      {
        channelId: "C123",
        messageId: "1776309280.777379",
        emoji: "eyes",
      },
      {
        fetchImpl,
        timeoutMs: 1,
      },
    ),
    /Slack reaction request timed out after 1ms/,
  );
});
