import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerKeepGoingPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "keep-going",
  name: "Keep Going",
  description: "Continuation plugin that starts a follow-up run for unfinished Slack turns",
  register(api) {
    registerKeepGoingPlugin(api);
  },
});
