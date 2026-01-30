import { Client } from "@notionhq/client";
import { generateText } from "ai";
import { NotionToMarkdown } from "notion-to-md";
import { markdownToBlocks } from "@tryfabric/martian";
import { getLanguageModel } from "@/lib/ai/providers";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

// Webhook secret — move to env var in production
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
    // Handle mention type (page mentions)
    if (block.type === "mention" && block.mention?.page?.id) {
      pageIds.push(block.mention.page.id);
    }
    // Fallback: check plain_text for raw URLs
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
      // Fallback: split into paragraphs
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
    // Fallback: split into paragraphs
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
  color: string = "purple_background"
) {
  // Step 1: Create the callout block with header
  const calloutResponse = await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        object: "block" as const,
        type: "callout" as const,
        callout: {
          icon: { type: "emoji", emoji: icon },
          color: color,
          rich_text: [{ type: "text", text: { content: "Kimi:" } }],
        },
      },
    ],
  });

  const calloutBlockId = calloutResponse.results[0]?.id;
  if (!calloutBlockId) {
    console.error("Failed to create callout block");
    return;
  }

  // Step 2: Convert markdown to Notion blocks and append as children
  const blocks = safeMarkdownToBlocks(responseText);
  const BATCH_SIZE = 100; // Notion API limit

  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    await notion.blocks.children.append({
      block_id: calloutBlockId,
      children: batch,
    });
  }
}

// Update Kimi DB page with status and optional error
async function updateKimiStatus(
  pageId: string,
  status: "Processing" | "Responded" | "Error",
  error?: string
) {
  const properties: any = {
    Checkbox: { checkbox: false },
  };

  // Note: Add Status and Error properties to Call Kimi DB for these to work
  // Status: select (Queued, Processing, Responded, Error)
  // Error: text
  // For now, these will silently fail if properties don't exist

  try {
    await notion.pages.update({ page_id: pageId, properties });
  } catch (e) {
    console.warn("Failed to update Kimi status:", e);
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

    // Get page ID
    pageId = payload.data?.id || payload.id || payload.page_id;
    console.log("Extracted pageId:", pageId);

    if (!pageId) {
      return Response.json({ error: "No page ID", payload }, { status: 400 });
    }

    // Fetch the Kimi DB page with full properties
    const page = (await notion.pages.retrieve({ page_id: pageId })) as any;

    // Extract Description (note: has trailing space in property name)
    const descriptionRichText = page.properties?.["Description "]?.rich_text || [];
    const description = descriptionRichText.map((rt: any) => rt.plain_text).join("");

    // Extract Links — parse mentions from rich_text
    const linksRichText = page.properties?.["Links"]?.rich_text || [];
    const linkedPageIds = extractPageIdsFromRichText(linksRichText);

    // Extract Source — parse mention from rich_text
    const sourceRichText = page.properties?.["Source"]?.rich_text || [];
    const sourcePageIds = extractPageIdsFromRichText(sourceRichText);
    const sourcePageId = sourcePageIds[0] || null;

    console.log("Description:", description.slice(0, 200));
    console.log("Linked page IDs:", linkedPageIds);
    console.log("Source page ID:", sourcePageId);

    if (!description && linkedPageIds.length === 0) {
      return Response.json({ error: "No description or links found" }, { status: 400 });
    }

    // Build context from linked pages (increased to 10)
    let linkedPagesContent = "";
    const fetchedPages: { title: string; content: string }[] = [];

    for (const pid of linkedPageIds.slice(0, 10)) {
      const pageData = await fetchNotionPage(pid);
      if (pageData) {
        fetchedPages.push(pageData);
      }
    }

    if (fetchedPages.length > 0) {
      linkedPagesContent = "\n\n---\n\n## Linked Notion Pages\n\n";
      for (const p of fetchedPages) {
        linkedPagesContent += `### ${p.title}\n\n${p.content}\n\n`;
      }
    }

    console.log(`Fetched ${fetchedPages.length} linked pages`);

    // Build the full prompt
    const fullContext = truncateContent(description + linkedPagesContent);
    console.log(`Full context length: ${fullContext.length} chars`);

    // Neutral system prompt
    const systemPrompt = `You are Kimi, a helpful AI assistant with a large context window. 
Answer the user's question based on the provided context.
Do not claim you lack access to information — the full context is provided below.
Be direct, thorough, and actionable.
Use markdown formatting for clarity (headings, lists, code blocks, tables).`;

    // Call Kimi — no thinking:disabled, let it reason
    let result;
    try {
      result = await generateText({
        model: getLanguageModel("moonshot/kimi-k2.5"),
        system: systemPrompt,
        prompt: fullContext,
        // No providerOptions — let Kimi think
      });
    } catch (error) {
      console.warn("kimi-k2.5 failed, falling back to kimi-k2-thinking:", error);
      result = await generateText({
        model: getLanguageModel("moonshot/kimi-k2-thinking"),
        system: systemPrompt,
        prompt: fullContext,
      });
    }

    console.log("Kimi response length:", result.text.length);

    // Determine where to write the response
    const targetPageId = sourcePageId || pageId;
    await appendResponseAsCallout(targetPageId, result.text, "🦋", "purple_background");
    console.log(`Response written to: ${sourcePageId ? "Source page" : "Kimi DB entry"} (${targetPageId})`);

    // Also store in Response property as backup
    try {
      await notion.pages.update({
        page_id: pageId,
        properties: {
          Response: {
            rich_text: [{ type: "text", text: { content: result.text.slice(0, 2000) } }],
          },
          Checkbox: { checkbox: false },
          Delivered: { checkbox: true },
        },
      });
    } catch (e) {
      console.warn("Failed to update Response property:", e);
    }

    return Response.json({
      success: true,
      linkedPagesCount: fetchedPages.length,
      contextLength: fullContext.length,
      responseLength: result.text.length,
      deliveredTo: sourcePageId ? "source" : "kimi-db",
      targetPageId,
    });
  } catch (error) {
    console.error("kimi-webhook error:", error);

    // Try to mark as error if we have pageId
    if (pageId) {
      try {
        await notion.pages.update({
          page_id: pageId,
          properties: {
            Checkbox: { checkbox: false },
            Response: {
              rich_text: [{ type: "text", text: { content: `Error: ${String(error).slice(0, 1900)}` } }],
            },
          },
        });
      } catch (e) {
        console.warn("Failed to write error to Kimi DB:", e);
      }
    }

    return Response.json({ error: String(error) }, { status: 500 });
  }
}
