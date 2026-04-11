import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerKeepGoingPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "keep-going",
  name: "Keep Going",
  description: "Prototype plugin scaffold for continuation validation experiments",
  register(api) {
    registerKeepGoingPlugin(api);
  },
});
