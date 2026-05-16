import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    config.cache = false;

    if (isServer && config.output) {
      config.output.chunkFilename = "[name].js";
    }

    return config;
  },
};

export default nextConfig;
