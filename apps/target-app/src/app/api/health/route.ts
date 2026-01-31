import { NextResponse } from "next/server";

/**
 * Traditional health check endpoint.
 * Always returns 200 OK — even when the z-index bug makes the site unusable.
 * This is the whole point: backend monitoring can't see visual regressions.
 */
export async function GET() {
  return NextResponse.json(
    {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    },
    { status: 200 }
  );
}
