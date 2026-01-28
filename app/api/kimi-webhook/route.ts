import { Client } from "@notionhq/client";
import { generateText } from "ai";
import { NotionToMarkdown } from "notion-to-md";
import { getLanguageModel } from "@/lib/ai/providers";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

// Webhook secret for auth
const WEBHOOK_SECRET = "Hjdnjajndjsnanjn893dafdafwe";

function getHeader(req: Request, name: string) {
  return req.headers.get(name) ?? req.headers.get(name.toLowerCase());
}

// Extract page ID from Notion URL
function extractPageId(url: string): string | null {
  const match = url.match(
    /([a-f0-9]{32})|([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i
  );
  if (!match) return null;
  const id = match[0].replace(/-/g, "");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// Extract all Notion URLs from text
function extractNotionUrls(text: string): string[] {
  const urlRegex = /https:\/\/(?:www\.)?notion\.so\/[^\s)"'<>]+/gi;
  const matches = text.match(urlRegex) || [];
  return matches;
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

// Truncate to ~120k tokens (roughly 480k chars)
function truncateContent(content: string, maxChars = 480000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n[Content truncated due to length...]";
}

export async function POST(request: Request) {
  try {
    // Auth check
    const incomingSecret = getHeader(request, "x-webhook-secret");
    if (!incomingSecret || incomingSecret !== WEBHOOK_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await request.json();
    console.log("Full payload:", JSON.stringify(payload, null, 2));

    // Get page ID
    const pageId = payload.data?.id || payload.id || payload.page_id;
    console.log("Extracted pageId:", pageId);

    if (!pageId) {
      return Response.json({ error: "No page ID", payload }, { status: 400 });
    }

    // Fetch the Kimi DB page
    const page = (await notion.pages.retrieve({ page_id: pageId })) as any;
    const description =
      page.properties?.["Description "]?.rich_text?.[0]?.plain_text || "";
    const linksText =
      page.properties?.["Links"]?.rich_text?.[0]?.plain_text || "";

    console.log("Description:", description);
    console.log("Links:", linksText);

    if (!description) {
      return Response.json({ error: "No description found" }, { status: 400 });
    }

    // Build context from linked pages
    let linkedPagesContent = "";
    if (linksText) {
      const notionUrls = extractNotionUrls(linksText);
      console.log("Found Notion URLs:", notionUrls);

      const fetchedPages: { title: string; content: string }[] = [];

      // Fetch up to 5 linked pages
      for (const url of notionUrls.slice(0, 5)) {
        const pageIdFromUrl = extractPageId(url);
        if (pageIdFromUrl) {
          const pageData = await fetchNotionPage(pageIdFromUrl);
          if (pageData) {
            fetchedPages.push(pageData);
          }
        }
      }

      if (fetchedPages.length > 0) {
        linkedPagesContent = "\n\n---\n\n## Linked Notion Pages\n\n";
        for (const p of fetchedPages) {
          linkedPagesContent += `### ${p.title}\n\n${p.content}\n\n`;
        }
      }
    }

    // Build the full prompt
    const fullContext = truncateContent(description + linkedPagesContent);

    // Neutral system prompt (prevents CFO/role auto-detection)
    const systemPrompt = `You are a helpful assistant.
Do not make assumptions about lacking API access — you have all the context you need in the prompt.
If Notion page content is provided below, use it to answer the question.`;

    // Call Kimi with thinking disabled, fallback to k2-0905-preview
    let result;
    try {
      result = await generateText({
        model: getLanguageModel("moonshot/kimi-k2.5"),
        system: systemPrompt,
        prompt: fullContext,
        providerOptions: {
          moonshot: {
            thinking: { type: "disabled" },
          },
        },
      });
    } catch (error) {
      console.warn("kimi-k2.5 failed, falling back to k2-0905-preview:", error);
      result = await generateText({
        model: getLanguageModel("moonshot/kimi-k2-0905-preview"),
        system: systemPrompt,
        prompt: fullContext,
      });
    }

    console.log("Kimi response length:", result.text.length);

    // Write response back to Notion
    await notion.pages.update({
      page_id: pageId,
      properties: {
        Response: {
          rich_text: [
            {
              type: "text",
              text: { content: result.text.slice(0, 2000) },
            },
          ],
        },
        Checkbox: { checkbox: false },
      },
    });

    return Response.json({
      success: true,
      linkedPagesCount: linksText ? extractNotionUrls(linksText).length : 0,
    });
  } catch (error) {
    console.error("kimi-webhook error:", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
