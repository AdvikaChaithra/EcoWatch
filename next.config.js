/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["leaflet", "react-leaflet"],
  // Build traces are only needed for standalone/serverless deploys; this app runs with
  // `next start`, and tracing a nested repo folder can stall the build for many minutes.
  outputFileTracing: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "qxfpuvpmykedrxrxazlg.supabase.co" },
      { protocol: "https", hostname: "tile.openstreetmap.org" },
    ],
  },
  webpack: (config) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    return config;
  },
};

module.exports = nextConfig;
