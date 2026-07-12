import type { Metadata } from "next";
import "./globals.css";
import "@livekit/components-styles";
import { UiProviders } from "../components/ui";

export const metadata: Metadata = {
  title: "Multi-Live",
  description: "멀티 게스트 라이브 스트리밍",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // data-theme: 토큰 세트 선택자(향후 라이트/아티스트 스킨 교체 지점).
    <html lang="ko" data-theme="dark">
      <body>
        <UiProviders>{children}</UiProviders>
      </body>
    </html>
  );
}
