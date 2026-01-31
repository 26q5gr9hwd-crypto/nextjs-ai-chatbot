import { Client } from "@notionhq/client";
import { generateText } from "ai";
import { NotionToMarkdown } from "notion-to-md";
import { markdownToBlocks } from "@tryfabric/martian";
import { getLanguageModel } from "@/lib/ai/providers";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

const WEBHOOK_SECRET = process.env.KIMI_WEBHOOK_SECRET || "Hjdnjajndjsnanjn893dafdafwe";

function getHeader(req: Request, name: string) {
  return req.headers.get(name) ?? req.headers.get(name.toLowerCase());
}

// Extract page ID from various formats (URL, UUID, hyphenated UUID)
function extractPageId(input: string): string | null {
  if (!input) return null;
  const match = input.match(
    /([a-f0-9]{32})|([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i
  );
  if (!match) return null;
  const id = match[0].replace(/-/g, "");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// Extract page IDs from Notion rich_text (handles mention objects)
function extractPageIdsFromRichText(richTextArray: any[]): string[] {
  const pageIds: string[] = [];
  if (!Array.isArray(richTextArray)) return pageIds;

  for (const block of richTextArray) {
    if (block.type === "mention" && block.mention?.page?.id) {
      pageIds.push(block.mention.page.id);
    }
    if (block.plain_text) {
      const urlMatch = block.plain_text.match(
        /https:\/\/(?:www\.)?notion\.so\/[^\s)"'<>]+/gi
      );
      if (urlMatch) {
        for (const url of urlMatch) {
          const id = extractPageId(url);
          if (id && !pageIds.includes(id)) pageIds.push(id);
        }
      }
    }
  }
  return pageIds;
}

// Fetch page content as markdown
async function fetchNotionPage(
  pageId: string
): Promise<{ title: string; content: string } | null> {
  try {
    const page = (await notion.pages.retrieve({ page_id: pageId })) as any;
    const title =
      page.properties?.title?.title?.[0]?.plain_text ||
      page.properties?.Name?.title?.[0]?.plain_text ||
      "Untitled";

    const mdBlocks = await n2m.pageToMarkdown(pageId);
    const content = n2m.toMarkdownString(mdBlocks).parent;

    return { title, content };
  } catch (error) {
    console.warn(`Failed to fetch page ${pageId}:`, error);
    return null;
  }
}

// Truncate to ~200k tokens (roughly 800k chars) — Kimi has 256k window
function truncateContent(content: string, maxChars = 800000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n[Content truncated due to length...]";
}

// Safely convert markdown to Notion blocks with fallback
function safeMarkdownToBlocks(markdown: string): any[] {
  try {
    const blocks = markdownToBlocks(markdown);
    if (!blocks || blocks.length === 0) {
      return markdown.split("\n\n").filter(Boolean).map((chunk) => ({
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: chunk.slice(0, 2000) } }],
        },
      }));
    }
    return blocks;
  } catch (e) {
    console.error("martian conversion failed:", e);
    return markdown.split("\n\n").filter(Boolean).map((chunk) => ({
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: chunk.slice(0, 2000) } }],
      },
    }));
  }
}

// Append response as a callout with properly rendered markdown children
async function appendResponseAsCallout(
  pageId: string,
  responseText: string,
  icon: string = "🦋",
  color: "purple_background" | "blue_background" | "gray_background" = "purple_background"
) {
  const calloutResponse = await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        object: "block" as const,
        type: "callout" as const,
        callout: {
          icon: { type: "emoji" as const, emoji: icon as any },
          color: color as any,
          rich_text: [],
        },
      },
    ],
  });

  const calloutBlockId = calloutResponse.results[0]?.id;
  if (!calloutBlockId) {
    console.error("Failed to create callout block");
    return;
  }

  const blocks = safeMarkdownToBlocks(responseText);
  const BATCH_SIZE = 100;

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    await notion.blocks.children.append({
      block_id: calloutBlockId,
      children: batch,
    });
  }
}

// Update Agent Task status and trigger Supervisor
async function updateTaskStatus(
  taskId: string,
  status: "Working" | "Done" | "Error",
  options: {
    kimiResponse?: string;
    errorLog?: string;
    triggerSupervisor?: boolean;
  } = {}
) {
  const properties: any = {
    Status: { status: { name: status } },
  };

  if (status === "Working") {
    properties["Started At"] = {
      date: { start: new Date().toISOString() },
    };
  }

  if (status === "Done") {
    properties["Completed At"] = {
      date: { start: new Date().toISOString() },
    };
  }

  if (options.kimiResponse) {
    properties["Kimi Response"] = {
      rich_text: [{ type: "text", text: { content: options.kimiResponse.slice(0, 2000) } }],
    };
  }

  if (options.errorLog) {
    properties["Error Log"] = {
      rich_text: [{ type: "text", text: { content: options.errorLog.slice(0, 2000) } }],
    };
  }

  if (options.triggerSupervisor) {
    properties["Supervisor Trigger"] = { checkbox: true };
  }

  try {
    await notion.pages.update({ page_id: taskId, properties });
    console.log(`Task ${taskId} updated: Status=${status}, SupervisorTrigger=${options.triggerSupervisor}`);
  } catch (e) {
    console.warn("Failed to update task status:", e);
  }
}

// Check if task has a parent (subtask pattern)
async function getParentTaskId(taskId: string): Promise<string | null> {
  try {
    const page = (await notion.pages.retrieve({ page_id: taskId })) as any;
    const parentRelation = page.properties?.["Parent Task"]?.relation || [];
    return parentRelation[0]?.id || null;
  } catch (e) {
    console.warn("Failed to get parent task:", e);
    return null;
  }
}

export async function POST(request: Request) {
  let taskId: string | null = null;

  try {
    // Auth check
    const incomingSecret = getHeader(request, "x-webhook-secret");
    if (!incomingSecret || incomingSecret !== WEBHOOK_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await request.json();
    console.log("Full payload:", JSON.stringify(payload, null, 2));

    // Get task ID from Agent Tasks
    taskId = payload.data?.id || payload.id || payload.page_id;
    console.log("Extracted taskId:", taskId);

    if (!taskId) {
      return Response.json({ error: "No task ID", payload }, { status: 400 });
    }

    // Mark as Working
    await updateTaskStatus(taskId, "Working");

    // Fetch the Agent Task page
    const task = (await notion.pages.retrieve({ page_id: taskId })) as any;

    // Verify this is a Kimi task
    const agent = task.properties?.["Agent"]?.select?.name;
    if (agent !== "Kimi") {
      console.log(`Task is not for Kimi (Agent=${agent}), skipping`);
      return Response.json({ skipped: true, reason: "Not a Kimi task" });
    }

    // Extract task properties
    const taskName = task.properties?.["Name"]?.title?.[0]?.plain_text || "Untitled Task";
    const callKimi = task.properties?.["Call Kimi"]?.rich_text?.map((rt: any) => rt.plain_text).join("") || "";
    const context = task.properties?.["Context"]?.rich_text?.map((rt: any) => rt.plain_text).join("") || "";
    const outputLocation = task.properties?.["Output Location"]?.select?.name || "Task Page";

    // Extract linked pages from Context (mentions)
    const contextRichText = task.properties?.["Context"]?.rich_text || [];
    const linkedPageIds = extractPageIdsFromRichText(contextRichText);

    console.log("Task Name:", taskName);
    console.log("Call Kimi:", callKimi.slice(0, 200));
    console.log("Context:", context.slice(0, 200));
    console.log("Output Location:", outputLocation);
    console.log("Linked page IDs:", linkedPageIds);

    if (!callKimi && !context) {
      await updateTaskStatus(taskId, "Error", { errorLog: "No Call Kimi or Context provided" });
      return Response.json({ error: "No Call Kimi or Context provided" }, { status: 400 });
    }

    // Build context from linked pages (up to 10)
    const fetchedPages: { title: string; content: string }[] = [];
    for (const pid of linkedPageIds.slice(0, 10)) {
      const pageData = await fetchNotionPage(pid);
      if (pageData) {
        fetchedPages.push(pageData);
      }
    }
    console.log(`Fetched ${fetchedPages.length} linked pages`);

    // Build the prompt
    let prompt = callKimi || context;
    
    if (fetchedPages.length > 0) {
      prompt += "\n\n---\n\n## Context Pages\n\n";
      for (const p of fetchedPages) {
        prompt += `### ${p.title}\n\n${p.content}\n\n`;
      }
    }

    const fullContext = truncateContent(prompt);
    console.log(`Full context length: ${fullContext.length} chars`);

    // System prompt
    const systemPrompt = `You are Kimi, an AI assistant working as part of an agent team.
You have web search capability. When asked about current events, prices, documentation, or information that may have changed since your training, use web search to get up-to-date information.
Your response will be converted to Notion blocks via markdown, so:
- Use ## and ### headers to organize sections (not #)
- Use bullet lists (-) and numbered lists (1.)
- Use \`\`\`language code blocks with syntax highlighting
- Use **bold** for emphasis, tables where helpful
- Keep paragraphs concise — they render as individual blocks
The user's question and instructions are provided below. Follow any specific output format or focus areas they request.
Be direct, thorough, and actionable. Do not hedge or claim lack of access — all relevant context is provided.`;

    // Call Kimi with web search enabled
    let result;
    try {
      result = await generateText({
        model: getLanguageModel("moonshot/kimi-k2.5"),
        system: systemPrompt,
        prompt: fullContext,
        providerOptions: {
          moonshot: { search: true },
        },
      });
    } catch (error) {
      console.warn("kimi-k2.5 failed, falling back to kimi-k2-thinking:", error);
      result = await generateText({
        model: getLanguageModel("moonshot/kimi-k2-thinking"),
        system: systemPrompt,
        prompt: fullContext,
        providerOptions: {
          moonshot: { search: true },
        },
      });
    }

    console.log("Kimi response length:", result.text.length);

    // Write response based on Output Location
    if (outputLocation === "Task Page" || outputLocation === "Both") {
      await appendResponseAsCallout(taskId, result.text, "🦋", "purple_background");
      console.log("Response written to Task Page");
    }

    // Check if parent task exists (for Supervisor trigger)
    const parentTaskId = await getParentTaskId(taskId);
    const shouldTriggerSupervisor = !!parentTaskId;

    // Update task: Status = Done, Kimi Response, Supervisor Trigger if has parent
    await updateTaskStatus(taskId, "Done", {
      kimiResponse: result.text,
      triggerSupervisor: shouldTriggerSupervisor,
    });

    // If parent exists, also set Supervisor Trigger on parent (same pattern as Claude)
    if (parentTaskId) {
      try {
        await notion.pages.update({
          page_id: parentTaskId,
          properties: {
            "Supervisor Trigger": { checkbox: true },
          },
        });
        console.log(`Supervisor Trigger set on parent task ${parentTaskId}`);
      } catch (e) {
        console.warn("Failed to trigger supervisor on parent:", e);
      }
    }

    return Response.json({
      success: true,
      taskId,
      taskName,
      linkedPagesCount: fetchedPages.length,
      contextLength: fullContext.length,
      responseLength: result.text.length,
      outputLocation,
      supervisorTriggered: shouldTriggerSupervisor,
      parentTaskId,
    });
  } catch (error) {
    console.error("kimi-webhook error:", error);

    if (taskId) {
      await updateTaskStatus(taskId, "Error", { errorLog: String(error) });
    }

    return Response.json({ error: String(error) }, { status: 500 });
  }
}
