import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

import {
  customProvider,
  extractReasoningMiddleware,
  wrapLanguageModel,
  type LanguageModel,
} from "ai";
import type { LanguageModelV1CallOptions } from "@ai-sdk/provider";
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

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const moonshotBase = createOpenAICompatible({
  name: "moonshot",
  apiKey: process.env.MOONSHOT_API_KEY,
  baseURL: "https://api.moonshot.ai/v1",
});
// Wrapper to filter empty assistant messages for Moonshot reasoning models
// Kimi k2.5 and k2-thinking reject assistant messages with empty content
function wrapMoonshotModel(model: LanguageModel): LanguageModel {
  const filterEmptyAssistantMessages = (options: LanguageModelV1CallOptions) => {
    if (options.prompt) {
      options.prompt = options.prompt.filter((msg) => {
        if (msg.role === "assistant") {
          // Check if assistant message has actual content
          if (!msg.content || msg.content.length === 0) return false;
          // Check if all parts are empty
          const hasContent = msg.content.some((part: any) => {
            if (part.type === "text") return part.text?.trim();
            if (part.type === "tool-call") return true;
            return false;
          });
          return hasContent;
        }
        return true;
      });
    }
    return options;
  };
  return {
    ...model,
    async doGenerate(options) {
      return model.doGenerate(filterEmptyAssistantMessages(options));
    },
    async doStream(options) {
      return model.doStream(filterEmptyAssistantMessages(options));
    },
  };
}
// Moonshot provider with empty message filtering
const moonshot = (modelId: string) => wrapMoonshotModel(moonshotBase(modelId));

const THINKING_SUFFIX_REGEX = /-thinking$/;
const NO_REASONING_SUFFIX_REGEX = /-no-reasoning$/;

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
      return moonshot(model); // Already wrapped with empty message filter
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  // "Reasoning off" variant: no middleware, just strip suffix
  if (modelId.endsWith("-no-reasoning")) {
    const cleanModelId = modelId.replace(NO_REASONING_SUFFIX_REGEX, "");
    return getProviderModel(cleanModelId);
  }

  // Reasoning variant: extract <thinking>...</thinking> if the model outputs it
  // Skip for Moonshot - their "-thinking" suffix is the actual model name (kimi-k2-thinking)
  if (modelId.endsWith("-thinking") && !modelId.startsWith("moonshot/")) {
    const cleanModelId = modelId.replace(THINKING_SUFFIX_REGEX, "");

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
