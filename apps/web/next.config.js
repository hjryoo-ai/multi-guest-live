/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 모노레포에서 shared 패키지 트랜스파일
  transpilePackages: ["@multi-live/shared"],
};

export default nextConfig;
