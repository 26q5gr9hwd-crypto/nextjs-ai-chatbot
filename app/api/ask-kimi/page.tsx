"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

export default function AskKimiPage() {
  const [pageUrl, setPageUrl] = useState("");
  const [question, setQuestion] = useState("");
  const [relatedUrls, setRelatedUrls] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const relatedPageUrls = relatedUrls
        .split("\n")
        .map((url) => url.trim())
        .filter(Boolean);

      const response = await fetch("/api/ask-kimi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageUrl, question, relatedPageUrls }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Request failed");
      }

      setResult(data.analysis);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col max-w-4xl mx-auto p-6 gap-6">
      <div>
        <h1 className="text-2xl font-bold">Ask Kimi — Notion Analyzer</h1>
        <p className="text-muted-foreground mt-1">
          Analyze Notion pages with Kimi K2.5 reasoning
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="text-sm font-medium">Notion Page URL *</label>
          <Input
            value={pageUrl}
            onChange={(e) => setPageUrl(e.target.value)}
            placeholder="https://notion.so/your-page-id"
            required
          />
        </div>

        <div>
          <label className="text-sm font-medium">Question (optional)</label>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What would you like to know about this page?"
            rows={3}
          />
        </div>

        <div>
          <label className="text-sm font-medium">Related Page URLs (optional, one per line)</label>
          <Textarea
            value={relatedUrls}
            onChange={(e) => setRelatedUrls(e.target.value)}
            placeholder="https://notion.so/related-page-1&#10;https://notion.so/related-page-2"
            rows={3}
          />
        </div>

        <Button type="submit" disabled={loading || !pageUrl}>
          {loading ? "Analyzing..." : "Analyze with Kimi"}
        </Button>
      </form>

      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {result && (
        <div className="p-6 bg-muted/50 rounded-lg">
          <h2 className="text-lg font-semibold mb-4">Analysis Result</h2>
          <div className="prose dark:prose-invert max-w-none whitespace-pre-wrap">
            {result}
          </div>
        </div>
      )}
    </div>
  );
}
