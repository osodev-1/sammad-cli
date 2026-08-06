import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Protect browser pages; CLI API routes use bearer tokens (not Clerk sessions)
const isProtectedPage = createRouteMatcher([
  "/device(.*)",
  "/dashboard(.*)",
  "/terminal(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (isProtectedPage(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files unless in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
