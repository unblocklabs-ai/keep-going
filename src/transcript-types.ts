export type TranscriptMessageRole = "user" | "assistant" | "tool" | "toolResult";

export type TranscriptMessage = {
  role: TranscriptMessageRole;
  text: string;
};

export type SlackThreadHistoryMessage = {
  type: "user" | "assistant";
  msg: string;
};
