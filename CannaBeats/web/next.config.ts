import type { NextConfig } from "next";

const configuredBasePath = process.env.NEXT_PUBLIC_CANNABEATS_BASE_PATH?.trim() ?? "";
const basePath = configuredBasePath
  ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
  : "";

const nextConfig: NextConfig = {
  basePath,
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/ready": ["./data/catalog.json", "./data/catalog-manifest.json"],
  },
  typescript: { tsconfigPath: "tsconfig.do.json" },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "script-src 'self' 'unsafe-inline' https://sdk.scdn.co",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https://i.scdn.co",
            "frame-src https://sdk.scdn.co",
            "connect-src 'self' https://accounts.spotify.com https://api.spotify.com wss://dealer.spotify.com https://cannaudio.cannabeats.social",
            "media-src 'self' blob: https://*.scdn.co https://cannaudio.cannabeats.social",
            "worker-src 'self' blob:",
          ].join("; "),
        },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self)" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
};

export default nextConfig;
