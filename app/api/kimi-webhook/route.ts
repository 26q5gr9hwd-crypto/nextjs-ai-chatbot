import { Client } from "@notionhq/client";
import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    
    // Notion webhook sends page data
    // The structure depends on how Notion formats the webhook payload
    const pageId = payload.data?.id || payload.id;
    
    // Extract Description from webhook payload
    // Note: Notion webhook payloads include property values
    const description = 
      payload.data?.properties?.["Description "]?.rich_text?.[0]?.plain_text ||
      payload.properties?.["Description "]?.rich_text?.[0]?.plain_text ||
      "";

    if (!pageId) {
      return Response.json({ error: "No page ID in payload" }, { status: 400 });
    }

    if (!description) {
      return Response.json({ error: "No description provided" }, { status: 400 });
    }

    // Call Kimi
    const result = await generateText({
      model: getLanguageModel("moonshot/kimi-k2.5"),
      prompt: description,
      temperature: 1, // Required for Kimi reasoning models
    });

    // Write response back to the same Notion page
    await notion.pages.update({
      page_id: pageId,
      properties: {
        "Response": {
          rich_text: [
            {
              type: "text",
              text: { content: result.text.slice(0, 2000) } // Notion rich_text limit
            }
          ]
        },
        "Checkbox": { checkbox: false } // Uncheck to reset for next query
      }
    });

    return Response.json({ success: true, responseLength: result.text.length });
  } catch (error) {
    console.error("kimi-webhook error:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Webhook failed" },
      { status: 500 }
    );
  }
}
