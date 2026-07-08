import type { NextConfig } from "next";

/**
 * Static export → Cloudflare Pages.
 * App je 100% client-side (localStorage token + TanStack Query), nema SSR-a,
 * pa `output: "export"` daje čist statički `out/` (bez Workers runtime-a/adaptera).
 * API URL se bake-uje u build iz NEXT_PUBLIC_API_URL (vidi .env.production).
 */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: false,
};

export default nextConfig;
