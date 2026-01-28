// Friends version - email-gated model access
export const DEFAULT_CHAT_MODEL = "moonshot/kimi-k2.5";

// Allowed emails for premium models
export const PREMIUM_EMAILS = [
  "danieldj@mail.ru",
  "getty.dan.14@gmail.com",
];

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

// Base models available to all users
export const baseModels: ChatModel[] = [
  // Google
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    description: "Fast and capable Google model",
  },
  {
    id: "google/gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    description: "Most capable Google model",
  },
  // Moonshot (Kimi) - free for all
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshot",
    description: "Latest Kimi model with reasoning (default)",
  },
  {
    id: "moonshot/kimi-k2-0905-preview",
    name: "Kimi K2 (Fast)",
    provider: "moonshot",
    description: "Kimi K2 without reasoning - faster responses",
  },
  {
    id: "moonshot/kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    provider: "moonshot",
    description: "Extended thinking for complex problems",
  },
];

// Premium models (only for allowed emails)
export const premiumModels: ChatModel[] = [
  // Anthropic - correct model IDs
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
  // OpenAI
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
  const isPremium = email && PREMIUM_EMAILS.includes(email);
  
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
    {} as Record<string, ChatModel[]>
  );
}
