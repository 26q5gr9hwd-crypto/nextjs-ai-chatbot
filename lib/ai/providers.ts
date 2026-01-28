import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
} from "ai";
import { isTestEnvironment } from "../constants";

// Direct provider instances (bypasses Vercel AI Gateway)
const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Moonshot/Kimi uses OpenAI-compatible API (chat.completions only)
const moonshot = createOpenAI({
  apiKey: process.env.MOONSHOT_API_KEY,
  baseURL: "https://api.moonshot.ai/v1",
  // Force compatibility mode - use chat.completions, not responses API
  compatibility: "compatible",
});

const THINKING_SUFFIX_REGEX = /-thinking$/;
const REASONING_SUFFIX_REGEX = /-reasoning$/;

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        artifactModel,
        chatModel,
        reasoningModel,
        titleModel,
      } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "chat-model-reasoning": reasoningModel,
          "title-model": titleModel,
          "artifact-model": artifactModel,
        },
      });
    })()
  : null;

function getProviderModel(modelId: string) {
  const [provider, ...modelParts] = modelId.split("/");
  const model = modelParts.join("/");

  switch (provider) {
    case "google":
      return google(model);
    case "openai":
      return openai(model);
    case "anthropic":
      return anthropic(model);
    case "moonshot":
      return moonshot(model);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  // Check for reasoning models (both -thinking and -reasoning suffixes)
  const isReasoningModel =
    modelId.includes("reasoning") || 
    modelId.endsWith("-thinking") ||
    modelId.endsWith("-thinking-turbo");

  if (isReasoningModel) {
    // Extract the base model ID by removing reasoning suffixes
    const cleanModelId = modelId
      .replace(/-reasoning$/, "")
      .replace(/-thinking-turbo$/, "-thinking")  // keep -thinking for kimi-k2-thinking
      .replace(/-thinking$/, "");

    return wrapLanguageModel({
      model: getProviderModel(cleanModelId),
      middleware: extractReasoningMiddleware({ tagName: "thinking" }),
    });
  }

  return getProviderModel(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return google("gemini-2.5-flash");
}

export function getArtifactModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("artifact-model");
  }
  return openai("gpt-4o");
}
