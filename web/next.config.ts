import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The app lives in web/ of a larger repo; trace from the repo root.
  outputFileTracingRoot: path.join(__dirname, ".."),
};

export default nextConfig;
