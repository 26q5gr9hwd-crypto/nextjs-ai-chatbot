import { Client } from "@notionhq/client";
import { generateText } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// Option 1: shared secret header (simple + effective)
// Notion webhook must send:
//   X-WEBHOOK-SECRET: Hjdnjajndjsnanjn893dafdafwe
const WEBHOOK_SECRET = "Hjdnjajndjsnanjn893dafdafwe";

function getHeader(req: Request, name: string) {
  // Headers are case-insensitive, but this makes access explicit
  return req.headers.get(name) ?? req.headers.get(name.toLowerCase());
}

export async function POST(request: Request) {
  try {
    const incomingSecret = getHeader(request, "x-webhook-secret");

    if (!incomingSecret || incomingSecret !== WEBHOOK_SECRET) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await request.json();

    // Log everything to debug
    console.log("Full payload:", JSON.stringify(payload, null, 2));

    // Try multiple ways to get page ID
    const pageId = payload.data?.id || payload.id || payload.page_id;
    console.log("Extracted pageId:", pageId);

    if (!pageId) {
      return Response.json({ error: "No page ID", payload }, { status: 400 });
    }

    // Fetch the page directly from Notion
    const page = (await notion.pages.retrieve({ page_id: pageId })) as any;
    const description = page.properties?.["Description "]?.rich_text?.[0]?.plain_text || "";

    console.log("Description:", description);

    if (!description) {
      return Response.json({ error: "No description found" }, { status: 400 });
    }

    // Call Kimi
    const result = await generateText({
      model: getLanguageModel("moonshot/kimi-k2.5"),
      prompt: description,
      temperature: 1,
    });

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

    return Response.json({ success: true });
  } catch (error) {
    console.error("kimi-webhook error:", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
