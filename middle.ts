import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow Notion -> Vercel webhook with no session cookies
  if (pathname === "/api/kimi-webhook") {
    return NextResponse.next();
  }

  return NextResponse.next();
}

// IMPORTANT: limit where middleware runs.
// If your project already has auth middleware somewhere else, this will ensure
// /api/kimi-webhook is explicitly included and can be exempted above.
export const config = {
  matcher: ["/api/:path*"],
};
