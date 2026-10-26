const FREE_MODELS = Object.freeze([
  "z-ai/glm-4.6v-flash-free",
  "dots-studio/dots3-note-prev",
]);
const FREE_MODEL = FREE_MODELS[0];

function integerFromEnv(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

export function getConfig(env = process.env) {
  return {
    zenmuxApiKey: env.ZENMUX_API_KEY?.trim() ?? "",
    zenmuxBaseUrl: stripTrailingSlash(env.ZENMUX_API_BASE_URL || "https://zenmux.ai/api/v1"),
    // Liste blanche codée en dur : aucune requête publique ne peut sélectionner un modèle payant.
    model: FREE_MODEL,
    models: FREE_MODELS,
    reasoningEffort: ["low", "medium", "high"].includes(env.DEFAULT_REASONING_EFFORT)
      ? env.DEFAULT_REASONING_EFFORT
      : "low",
    maxCompletionTokens: integerFromEnv(env.MAX_COMPLETION_TOKENS, 2048, 64, 16384),
    upstreamTimeoutMs: integerFromEnv(env.UPSTREAM_TIMEOUT_MS, 50000, 1000, 55000),
    maxPromptChars: integerFromEnv(env.MAX_PROMPT_CHARS, 12000, 1, 100000),
    maxImages: integerFromEnv(env.MAX_IMAGES, 4, 0, 8),
    maxImageBytes: integerFromEnv(env.MAX_IMAGE_BYTES, 4 * 1024 * 1024, 1024, 10 * 1024 * 1024),
    imageTimeoutMs: integerFromEnv(env.IMAGE_TIMEOUT_MS, 12000, 1000, 30000),
    imageHostAllowlist: (env.IMAGE_HOST_ALLOWLIST ?? "")
      .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
    maxHistoryMessages: integerFromEnv(env.MAX_HISTORY_MESSAGES, 24, 2, 200),
    maxHistoryChars: integerFromEnv(env.MAX_HISTORY_CHARS, 60000, 1000, 1000000),
    conversationTtlSeconds: integerFromEnv(env.CONVERSATION_TTL_SECONDS, 604800, 60, 2592000),
    rateLimitPerMinute: integerFromEnv(env.RATE_LIMIT_PER_MINUTE, 20, 1, 1000),
    publicApiToken: env.ZEMUX_API_TOKEN?.trim() ?? "",
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "*")
      .split(",").map((origin) => origin.trim()).filter(Boolean),
    redisUrl: env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim() || "",
    redisToken: env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim() || "",
    systemPrompt: env.ZEMUX_SYSTEM_PROMPT?.trim() || [
      "Tu es Zemux, un assistant utile, précis et multilingue.",
      "Réponds dans la langue de l'utilisateur, sauf demande contraire.",
      "Tiens compte de l'historique fourni sans inventer de faits.",
      "Pour les mathématiques, utilise du LaTeX entre délimiteurs $...$ ou \\[...\\].",
    ].join(" "),
  };
}

export { FREE_MODEL, FREE_MODELS };
