import { isSecretRef, resolveConfiguredSecretInputString, } from "openclaw/plugin-sdk/secret-input-runtime";
const DEFAULT_OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
const API_KEY_REF_CONFIG_PATH = "plugins.entries.keep-going.config.validator.llm.apiKeyRef";
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
export async function resolveLlmApiKey(config, runtimeConfig, options = {}) {
    const secretRefApiKey = await resolveLlmApiKeyRef(config.apiKeyRef, runtimeConfig, options);
    if (secretRefApiKey) {
        return secretRefApiKey;
    }
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
async function resolveLlmApiKeyRef(value, runtimeConfig, options) {
    if (value === undefined) {
        return undefined;
    }
    if (!isSecretRef(value)) {
        return undefined;
    }
    const resolved = await resolveConfiguredSecretInputString({
        config: (runtimeConfig ?? {}),
        env: process.env,
        value,
        path: API_KEY_REF_CONFIG_PATH,
        unresolvedReasonStyle: "detailed",
    });
    if (resolved.value) {
        return resolved.value;
    }
    options.logger?.warn("validator API key SecretRef could not be resolved", {
        path: API_KEY_REF_CONFIG_PATH,
        source: value.source,
        provider: value.provider,
        id: value.id,
        reason: resolved.unresolvedRefReason ?? "SecretRef is not available",
    });
    return undefined;
}
