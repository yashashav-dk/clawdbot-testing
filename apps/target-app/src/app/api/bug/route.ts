import { NextResponse } from "next/server";

/**
 * Bug toggle API — for demo automation.
 *
 * POST /api/bug { "enabled": true }  → Injects the ghost overlay via a response header
 * GET  /api/bug                       → Returns current bug status
 *
 * Note: The actual bug toggle in the client relies on NEXT_PUBLIC_ENABLE_BUG env var
 * at build time. This API endpoint is provided for demo tooling to check state
 * and for future runtime toggle support.
 */

// In-memory state for runtime toggling (development only)
let bugEnabled = process.env.NEXT_PUBLIC_ENABLE_BUG === "true";

export async function GET() {
  return NextResponse.json({
    bugEnabled,
    envValue: process.env.NEXT_PUBLIC_ENABLE_BUG ?? "unset",
    note: "Runtime toggle available in development mode. Production uses build-time env var.",
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.enabled === "boolean") {
      bugEnabled = body.enabled;
      return NextResponse.json({
        bugEnabled,
        message: `Bug ${bugEnabled ? "enabled" : "disabled"} at runtime`,
      });
    }
    return NextResponse.json(
      { error: 'Expected { "enabled": true | false }' },
      { status: 400 }
    );
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }
}
