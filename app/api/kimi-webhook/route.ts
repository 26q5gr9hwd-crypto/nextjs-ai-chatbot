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

// Update Call Kimi page status
async function updateKimiStatus(
  pageId: string,
  status: "Processing" | "Responded" | "Error",
  error?: string
) {
  const properties: any = {
    Status: { select: { name: status } },
  };
  if (status === "Responded" || status === "Error") {
    properties.Checkbox = { checkbox: false };
  }
  if (error) {
    properties.Error = {
      rich_text: [{ type: "text", text: { content: error.slice(0, 2000) } }],
    };
  }
  if (status === "Responded") {
    properties.Error = { rich_text: [] };
  }
  try {
    await notion.pages.update({ page_id: pageId, properties });
    console.log(`Call Kimi status updated to: ${status}`);
  } catch (e) {
    console.warn("Failed to update Kimi status:", e);
  }
}

// Update linked Agent Task for Supervisor callback
async function updateAgentTask(
  agentTaskId: string,
  kimiResponse: string
) {
  try {
    await notion.pages.update({
      page_id: agentTaskId,
      properties: {
        "Kimi Response": {
          rich_text: [{ type: "text", text: { content: kimiResponse.slice(0, 2000) } }],
        },
        "Status": { status: { name: "Done" } },
        "Supervisor Trigger": { checkbox: true },
        "Completed At": { date: { start: new Date().toISOString() } },
      },
    });
    console.log(`Agent Task ${agentTaskId} updated: Status=Done, Supervisor Trigger=✓`);
  } catch (e) {
    console.warn("Failed to update Agent Task:", e);
  }
}

export async function POST(request: Request) {
  let pageId: string | null = null;

  try {
    // Auth check
    const incomingSecret = getHeader(request, "x-webhook-secret");
    if (!incomingSecret || incomingSecret !== WEBHOOK_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await request.json();
    console.log("Full payload:", JSON.stringify(payload, null, 2));

    // Get page ID from Call Kimi DB
    pageId = payload.data?.id || payload.id || payload.page_id;
    console.log("Extracted pageId:", pageId);

    if (!pageId) {
      return Response.json({ error: "No page ID", payload }, { status: 400 });
    }

    // Mark as Processing
    await updateKimiStatus(pageId, "Processing");

    // Fetch the Call Kimi page with full properties
    const page = (await notion.pages.retrieve({ page_id: pageId })) as any;

    // Extract Description
    const descriptionRichText = page.properties?.["Description"]?.rich_text || [];
    const description = descriptionRichText.map((rt: any) => rt.plain_text).join("");

    // Extract Links — parse mentions from rich_text
    const linksRichText = page.properties?.["Links"]?.rich_text || [];
    const linkedPageIds = extractPageIdsFromRichText(linksRichText);

    // Extract Source — parse mention from rich_text
    const sourceRichText = page.properties?.["Source"]?.rich_text || [];
    const sourcePageIds = extractPageIdsFromRichText(sourceRichText);
    const sourcePageId = sourcePageIds[0] || null;

    // Extract Agent Task relation (for Supervisor callback)
    const agentTaskRelation = page.properties?.["Agent Task"]?.relation || [];
    const agentTaskId = agentTaskRelation[0]?.id || null;

    console.log("Description:", description.slice(0, 200));
    console.log("Linked page IDs:", linkedPageIds);
    console.log("Source page ID:", sourcePageId);
    console.log("Agent Task ID:", agentTaskId);

    if (!description && linkedPageIds.length === 0) {
      await updateKimiStatus(pageId, "Error", "No description or links found");
      return Response.json({ error: "No description or links found" }, { status: 400 });
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

    // First linked page = PROMPT PAGE (primary instructions)
    // Remaining pages = supporting context
    let primaryPrompt = description;
    let contextSection = "";

    if (fetchedPages.length > 0) {
      primaryPrompt = fetchedPages[0].content;

      const contextPages = fetchedPages.slice(1);
      if (contextPages.length > 0) {
        contextSection = "\n\n---\n\n## Supporting Context\n\n";
        for (const p of contextPages) {
          contextSection += `### ${p.title}\n\n${p.content}\n\n`;
        }
      }
    }

    const fullContext = truncateContent(primaryPrompt + contextSection);
    console.log(`Full context length: ${fullContext.length} chars`);

    // System prompt
    const systemPrompt = `You are Kimi, an AI assistant answering questions for a Notion workspace.
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

    // Determine where to write the response
    const targetPageId = sourcePageId || pageId;
    await appendResponseAsCallout(targetPageId, result.text, "🦋", "purple_background");
    console.log(`Response written to: ${sourcePageId ? "Source page" : "Call Kimi entry"} (${targetPageId})`);

    // Update Call Kimi status to Responded
    await updateKimiStatus(pageId, "Responded");

    // Store response in Response property as backup
    try {
      await notion.pages.update({
        page_id: pageId,
        properties: {
          Response: {
            rich_text: [{ type: "text", text: { content: result.text.slice(0, 2000) } }],
          },
          Delivered: { checkbox: true },
        },
      });
    } catch (e) {
      console.warn("Failed to update Response property:", e);
    }

    // If Agent Task linked, update it for Supervisor callback
    if (agentTaskId) {
      await updateAgentTask(agentTaskId, result.text);
    }

    return Response.json({
      success: true,
      linkedPagesCount: fetchedPages.length,
      contextLength: fullContext.length,
      responseLength: result.text.length,
      deliveredTo: sourcePageId ? "source" : "call-kimi",
      targetPageId,
      agentTaskTriggered: !!agentTaskId,
      agentTaskId,
    });
  } catch (error) {
    console.error("kimi-webhook error:", error);

    if (pageId) {
      await updateKimiStatus(pageId, "Error", String(error));
    }

    return Response.json({ error: String(error) }, { status: 500 });
  }
}
