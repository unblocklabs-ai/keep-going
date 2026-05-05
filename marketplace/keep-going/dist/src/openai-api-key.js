const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
function readProcessEnvValue(name) {
    const envKeyName = name?.trim();
    if (!envKeyName) {
        return undefined;
    }
    const envValue = process.env[envKeyName];
    return typeof envValue === "string" && envValue.trim() ? envValue.trim() : undefined;
}
function readConfigEnvValue(config, name) {
    const envKeyName = name?.trim();
    if (!envKeyName) {
        return undefined;
    }
    const env = config?.env;
    if (!env) {
        return undefined;
    }
    const vars = env.vars;
    const value = vars && typeof vars === "object" && !Array.isArray(vars)
        ? vars[envKeyName]
        : undefined;
    const directValue = value ?? env[envKeyName];
    return typeof directValue === "string" && directValue.trim()
        ? directValue.trim()
        : undefined;
}
function readResolvedProviderApiKey(config) {
    const apiKey = config?.models?.providers?.openai?.apiKey;
    if (typeof apiKey !== "string") {
        return undefined;
    }
    const normalized = apiKey.trim();
    if (!normalized || /^\$\{[^}]+\}$/.test(normalized)) {
        return undefined;
    }
    if (/^[A-Z][A-Z0-9_]+$/.test(normalized)) {
        return readConfigEnvValue(config, normalized) ?? readProcessEnvValue(normalized);
    }
    return normalized;
}
export function resolveLlmApiKey(config, runtimeConfig) {
    const inlineApiKey = config.apiKey?.trim();
    if (inlineApiKey) {
        return inlineApiKey;
    }
    return (readConfigEnvValue(runtimeConfig, config.apiKeyEnv) ??
        readProcessEnvValue(config.apiKeyEnv) ??
        readConfigEnvValue(runtimeConfig, DEFAULT_OPENAI_API_KEY_ENV) ??
        readResolvedProviderApiKey(runtimeConfig) ??
        readProcessEnvValue(DEFAULT_OPENAI_API_KEY_ENV));
}
