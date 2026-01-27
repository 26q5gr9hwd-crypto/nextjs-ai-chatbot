// Friends version - limited models
export const DEFAULT_CHAT_MODEL = "google/gemini-2.5-flash";

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
};

export const chatModels: ChatModel[] = [
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

// Group models by provider for UI
export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);
