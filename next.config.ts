import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Never trace the local database into the build output.
  outputFileTracingExcludes: { "*": ["data/**", "scripts/**", "tests/**"] },
  serverExternalPackages: [],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
