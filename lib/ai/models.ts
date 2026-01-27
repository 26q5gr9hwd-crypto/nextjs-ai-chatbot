// Friends version - email-gated model access
export const DEFAULT_CHAT_MODEL = "google/gemini-2.5-flash";

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
  // Moonshot (Kimi)
  {
    id: "moonshot/kimi-k2-0905",
    name: "Kimi K2 (9205)",
    provider: "moonshot",
    description: "Kimi K2 model with strong reasoning",
  },
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshot",
    description: "Latest Kimi model with enhanced capabilities",
  },
  // Google
  {
    id: "google/gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    description: "Fast and capable Google model",
  },
  // OpenAI
  {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    description: "OpenAI's flagship multimodal model",
  },
];

// Premium models (only for allowed emails)
export const premiumModels: ChatModel[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    description: "Best balance of speed, intelligence, and cost",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    description: "Fast and affordable, great for everyday tasks",
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
