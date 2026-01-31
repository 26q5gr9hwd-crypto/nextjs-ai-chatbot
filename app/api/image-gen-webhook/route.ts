import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const WEBHOOK_SECRET = process.env.IMAGE_GEN_WEBHOOK_SECRET || "ImageGen_Secret_Key_Change_Me";
const KIE_API_KEY = process.env.KIE_API_KEY; // Your Kie.ai API key

const KIE_API_BASE = "https://api.kie.ai/api/v1/jobs";

function getHeader(req: Request, name: string) {
  return req.headers.get(name) ?? req.headers.get(name.toLowerCase());
}

// Update Agent Task status and properties
async function updateTaskStatus(
  pageId: string,
  status: "Working" | "Done" | "Error",
  updates: Record<string, any> = {}
) {
  const properties: any = {
    Status: { status: { name: status } },
    ...updates,
  };

  if (status === "Working") {
    properties["date:Started At:start"] = new Date().toISOString();
    properties["date:Started At:is_datetime"] = 1;
  }

  if (status === "Done" || status === "Error") {
    properties["date:Completed At:start"] = new Date().toISOString();
    properties["date:Completed At:is_datetime"] = 1;
  }

  try {
    await notion.pages.update({ page_id: pageId, properties });
    console.log(`Task status updated to: ${status}`);
  } catch (e) {
    console.warn("Failed to update task status:", e);
  }
}

// Create Kie.ai generation task
async function createImageTask(
  prompt: string,
  imageInputs: string[] = [],
  aspectRatio: string = "1:1",
  resolution: string = "1K"
): Promise<string> {
  const response = await fetch(`${KIE_API_BASE}/createTask`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${KIE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "nano-banana-pro",
      input: {
        prompt,
        image_input: imageInputs,
        aspect_ratio: aspectRatio,
        resolution,
        output_format: "png",
      },
    }),
  });

  const data = await response.json();

  if (data.code !== 200 || !data.data?.taskId) {
    throw new Error(`Failed to create task: ${data.msg || JSON.stringify(data)}`);
  }

  return data.data.taskId;
}

// Poll for task completion
async function pollTaskStatus(
  taskId: string,
  maxAttempts: number = 60,
  intervalMs: number = 5000
): Promise<{ success: boolean; resultUrl?: string; error?: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(
      `${KIE_API_BASE}/recordInfo?taskId=${taskId}`,
      {
        headers: { Authorization: `Bearer ${KIE_API_KEY}` },
      }
    );

    const data = await response.json();

    if (data.code !== 200) {
      throw new Error(`Failed to check status: ${data.msg}`);
    }

    const state = data.data?.state;
    console.log(`Poll attempt ${attempt + 1}: state = ${state}`);

    if (state === "success") {
      const resultJson = JSON.parse(data.data.resultJson || "{}");
      const resultUrl = resultJson.resultUrls?.[0];
      return { success: true, resultUrl };
    }

    if (state === "fail") {
      return {
        success: false,
        error: data.data.failMsg || "Generation failed",
      };
    }

    // Still waiting - continue polling
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { success: false, error: "Timeout waiting for image generation" };
}

// Append image to page as an embed
async function appendImageToPage(pageId: string, imageUrl: string, prompt: string) {
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        type: "callout",
        callout: {
          icon: { type: "emoji", emoji: "🖼️" },
          color: "purple_background",
          rich_text: [
            {
              type: "text",
              text: { content: `Generated: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}` },
            },
          ],
        },
      },
      {
        type: "image",
        image: {
          type: "external",
          external: { url: imageUrl },
        },
      },
    ],
  });
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
    console.log("ImageGen webhook payload:", JSON.stringify(payload, null, 2));

    // Get page ID
    pageId = payload.data?.id || payload.id || payload.page_id;
    if (!pageId) {
      return Response.json({ error: "No page ID" }, { status: 400 });
    }

    // Mark as Working
    await updateTaskStatus(pageId, "Working");

    // Fetch the Agent Task page
    const page = (await notion.pages.retrieve({ page_id: pageId })) as any;

    // Extract image generation parameters
    const imagePrompt =
      page.properties?.["Image Prompt"]?.rich_text
        ?.map((rt: any) => rt.plain_text)
        .join("") || "";

    const imageInputUrlsRaw =
      page.properties?.["Image Input URLs"]?.rich_text
        ?.map((rt: any) => rt.plain_text)
        .join("") || "";

    const imageInputs = imageInputUrlsRaw
      .split(",")
      .map((url: string) => url.trim())
      .filter(Boolean);

    const aspectRatio =
      page.properties?.["Image Aspect Ratio"]?.select?.name || "1:1";

    const resolution =
      page.properties?.["Image Resolution"]?.select?.name || "1K";

    // Fallback to Context if no Image Prompt
    const prompt =
      imagePrompt ||
      page.properties?.["Context"]?.rich_text
        ?.map((rt: any) => rt.plain_text)
        .join("") ||
      "";

    if (!prompt) {
      throw new Error("No Image Prompt or Context provided");
    }

    console.log("Generating image with:", {
      prompt: prompt.slice(0, 200),
      imageInputs,
      aspectRatio,
      resolution,
    });

    // Create the generation task
    const taskId = await createImageTask(prompt, imageInputs, aspectRatio, resolution);
    console.log("Kie.ai task created:", taskId);

    // Poll for completion (up to 5 minutes)
    const result = await pollTaskStatus(taskId, 60, 5000);

    if (!result.success || !result.resultUrl) {
      throw new Error(result.error || "No result URL returned");
    }

    console.log("Image generated:", result.resultUrl);

    // Update task with result URL
    await updateTaskStatus(pageId, "Done", {
      "Image Result URL": { url: result.resultUrl },
      "Decisions Made": {
        rich_text: [
          {
            type: "text",
            text: {
              content: `Generated image via Nano Banana Pro. Aspect: ${aspectRatio}, Resolution: ${resolution}. Task ID: ${taskId}`,
            },
          },
        ],
      },
    });

    // Also append to the task page itself as visual confirmation
    await appendImageToPage(pageId, result.resultUrl, prompt);

    // Trigger Supervisor callback if needed
    const parentTask = page.properties?.["Parent Task"]?.relation?.[0]?.id;
    if (parentTask) {
      await notion.pages.update({
        page_id: pageId,
        properties: {
          "Supervisor Trigger": { checkbox: true },
        },
      });
      console.log("Supervisor callback triggered");
    }

    return Response.json({
      success: true,
      taskId,
      resultUrl: result.resultUrl,
      aspectRatio,
      resolution,
    });
  } catch (error) {
    console.error("image-gen-webhook error:", error);

    if (pageId) {
      await updateTaskStatus(pageId, "Error", {
        "Error Log": {
          rich_text: [
            { type: "text", text: { content: String(error).slice(0, 2000) } },
          ],
        },
      });
    }

    return Response.json({ error: String(error) }, { status: 500 });
  }
}
