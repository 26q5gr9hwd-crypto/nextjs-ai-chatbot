import { NextResponse, type NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow external webhooks (no cookies) to hit the function directly
  if (pathname === "/api/kimi-webhook") {
    return NextResponse.next();
  }

  // Let NextAuth + guest auth routes work normally
  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  // Run middleware for API routes (so the allowlist above can take effect)
  matcher: ["/api/:path*"],
};
