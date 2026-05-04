export function resolveLlmApiKey(config) {
    const inlineApiKey = config.apiKey?.trim();
    if (inlineApiKey) {
        return inlineApiKey;
    }
    const envKeyName = config.apiKeyEnv?.trim();
    if (!envKeyName) {
        return undefined;
    }
    const envValue = process.env[envKeyName];
    return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
}
