const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
function readEnvValue(name) {
    const envKeyName = name?.trim();
    if (!envKeyName) {
        return undefined;
    }
    const envValue = process.env[envKeyName];
    return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
}
export function resolveLlmApiKey(config) {
    const inlineApiKey = config.apiKey?.trim();
    if (inlineApiKey) {
        return inlineApiKey;
    }
    return readEnvValue(config.apiKeyEnv) ?? readEnvValue(DEFAULT_OPENAI_API_KEY_ENV);
}
