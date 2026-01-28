import { generateText } from "ai";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { getLanguageModel } from "@/lib/ai/providers";
import { auth } from "@/app/(auth)/auth";

export const maxDuration = 120;

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

// Role-specific prompts based on content type
function detectRolePrompt(content: string): string {
  const lower = content.toLowerCase();
  
  if (lower.includes("revenue") || lower.includes("финанс") || lower.includes("бюджет") || lower.includes("p&l")) {
    return "You are a CFO-level financial analyst. Focus on financial metrics, trends, risks, and actionable recommendations.";
  }
  if (lower.includes("competitor") || lower.includes("конкурент") || lower.includes("market share")) {
    return "You are a competitive intelligence analyst. Focus on competitive positioning, market dynamics, and strategic implications.";
  }
  if (lower.includes("product") || lower.includes("feature") || lower.includes("roadmap") || lower.includes("продукт")) {
    return "You are a CPO-level product strategist. Focus on product opportunities, user needs, and prioritization.";
  }
  if (lower.includes("sales") || lower.includes("deal") || lower.includes("pipeline") || lower.includes("продажи")) {
    return "You are a VP Sales analyst. Focus on deal analysis, win/loss patterns, and sales strategy.";
  }
  if (lower.includes("ops") || lower.includes("process") || lower.includes("efficiency") || lower.includes("процесс")) {
    return "You are a COO-level operations analyst. Focus on operational efficiency, bottlenecks, and process improvements.";
  }
  
  return "You are an expert business analyst. Provide clear, actionable insights based on the content.";
}

// Truncate to ~120k tokens (roughly 480k chars)
function truncateContent(content: string, maxChars = 480000): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n\n[Content truncated due to length...]";
}

// Extract page ID from Notion URL
function extractPageId(url: string): string {
  const match = url.match(/([a-f0-9]{32})|([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (!match) throw new Error("Invalid Notion URL");
  const id = match[0].replace(/-/g, "");
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

// Fetch page content as markdown
async function fetchNotionPage(pageId: string): Promise<{ title: string; content: string }> {
  const page = await notion.pages.retrieve({ page_id: pageId }) as any;
  const title = page.properties?.title?.title?.[0]?.plain_text 
    || page.properties?.Name?.title?.[0]?.plain_text 
    || "Untitled";
  
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const content = n2m.toMarkdownString(mdBlocks).parent;
  
  return { title, content };
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { pageUrl, question, relatedPageUrls = [] } = await request.json();
    
    if (!pageUrl) {
      return Response.json({ error: "pageUrl is required" }, { status: 400 });
    }

    // Fetch main page
    const mainPageId = extractPageId(pageUrl);
    const mainPage = await fetchNotionPage(mainPageId);
    
    // Fetch related pages (up to 5)
    const relatedPages: { title: string; content: string }[] = [];
    for (const url of relatedPageUrls.slice(0, 5)) {
      try {
        const pageId = extractPageId(url);
        const page = await fetchNotionPage(pageId);
        relatedPages.push(page);
      } catch (e) {
        console.warn(`Failed to fetch related page: ${url}`);
      }
    }

    // Build context
    let context = `# ${mainPage.title}\n\n${mainPage.content}`;
    
    if (relatedPages.length > 0) {
      context += "\n\n---\n\n## Related Documents\n\n";
      for (const page of relatedPages) {
        context += `### ${page.title}\n\n${page.content}\n\n`;
      }
    }

    context = truncateContent(context);
    const rolePrompt = detectRolePrompt(context);

    const systemPrompt = `${rolePrompt}

You are analyzing Notion documents. Preserve all markdown formatting in your response.
Provide structured, actionable insights. Use headers, bullet points, and tables where appropriate.
Be concise but thorough. Highlight key findings, risks, and recommendations.`;

    const userPrompt = question 
      ? `${question}\n\n---\n\nDocument content:\n\n${context}`
      : `Analyze this document and provide key insights:\n\n${context}`;

    // Try kimi-k2.5 first, fallback to kimi-k2-0905-preview
    let result;
    try {
      result = await generateText({
        model: getLanguageModel("moonshot/kimi-k2.5"),
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 1, // Required for Kimi reasoning models
      });
    } catch (e) {
      console.warn("kimi-k2.5 failed, falling back to kimi-k2-0905-preview");
      result = await generateText({
        model: getLanguageModel("moonshot/kimi-k2-0905-preview"),
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0.7, // Non-reasoning model can use lower temp
      });
    }

    return Response.json({
      analysis: result.text,
      pageTitle: mainPage.title,
      relatedPagesCount: relatedPages.length,
    });

  } catch (error) {
    console.error("ask-kimi error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Analysis failed" },
      { status: 500 }
    );
  }
}
