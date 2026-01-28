// Default model (change if you want Moonshot default)
export const DEFAULT_CHAT_MODEL = "moonshot/kimi-k2-turbo-preview";

// Allowed emails for premium models
export const PREMIUM_EMAILS = ["danieldj@mail.ru", "getty.dan.14@gmail.com"];

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

// Only keep the Kimi models you requested
export const baseModels: ChatModel[] = [
  {
    id: "moonshot/kimi-k2-turbo-preview",
    name: "Kimi K2 Turbo Preview",
    provider: "moonshot",
    description: "Turbo preview (fast K2)",
  },
  {
    // NOTE: suffix "-thinking" is for your middleware toggle; actual model is kimi-k2-thinking-turbo
    id: "moonshot/kimi-k2-thinking-turbo-thinking",
    name: "Kimi K2 Thinking Turbo",
    provider: "moonshot",
    description: "Thinking turbo (extracts <thinking> if present)",
  },
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshot",
    description: "K2.5 standard",
  },
  {
    // UI variant to disable reasoning middleware (not a real Moonshot parameter)
    id: "moonshot/kimi-k2.5-no-reasoning",
    name: "Kimi K2.5 (Reasoning Off)",
    provider: "moonshot",
    description: "No reasoning middleware; best-effort 'reasoning off'",
  },
];

// Premium models (unchanged; keep if you still want gating)
export const premiumModels: ChatModel[] = [
  {
    id: "anthropic/claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    description: "Best balance of speed, intelligence, and cost",
  },
  {
    id: "anthropic/claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    description: "Fast and affordable, great for everyday tasks",
  },
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    description: "OpenAI's flagship multimodal model",
  },
];

// Get models based on user email
export function getChatModels(userEmail?: string): ChatModel[] {
  const email = userEmail?.toLowerCase();
  const isPremium = !!email && PREMIUM_EMAILS.includes(email);

  return isPremium ? [...baseModels, ...premiumModels] : baseModels;
}

// Legacy export for backwards compatibility
export const chatModels = baseModels;

// Group models by provider for UI
export function getModelsByProvider(userEmail?: string) {
  return getChatModels(userEmail).reduce(
    (acc, model) => {
      if (!acc[model.provider]) {
        acc[model.provider] = [];
      }
      acc[model.provider].push(model);
      return acc;
    },
    {} as Record<string, ChatModel[]>,
  );
}
