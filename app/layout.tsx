import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0b1f36",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "고양 폴리봇 | AI 감지·실시간 안전관제",
    description:
      "사람과 사물을 감지하고 쓰러짐 의심 자세를 10초간 확인해 관제센터에 전달하는 고양 폴리봇 AI 관제 프로토타입",
    applicationName: "고양 폴리봇 SAFEBOT",
    manifest: "/manifest.webmanifest?theme=blue-v1",
    formatDetection: {
      telephone: false,
      address: false,
      email: false,
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "고양 폴리봇",
    },
    icons: {
      icon: [
        {
          url: "/icons/icon-192-blue-v1.png",
          type: "image/png",
          sizes: "192x192",
        },
        {
          url: "/icons/icon-512-blue-v1.png",
          type: "image/png",
          sizes: "512x512",
        },
      ],
      shortcut: "/icons/icon-192-blue-v1.png",
      apple: "/icons/icon-192-blue-v1.png",
    },
    openGraph: {
      type: "website",
      url: origin,
      title: "AI 감지 기능을 탑재한 고양 폴리봇",
      description:
        "사람·사물 감지, 쓰러짐 10초 확인, 얼굴 비식별화를 검증하는 주민안전 AI 관제 프로토타입",
      siteName: "고양 폴리봇 SAFEBOT",
      locale: "ko_KR",
      images: [
        {
          url: new URL("/og-goyang-polybot-v3.jpg", origin),
          width: 1200,
          height: 630,
          alt: "AI 감지 기능을 탑재한 고양 폴리봇 주민안전 관제 프로토타입",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "AI 감지 기능을 탑재한 고양 폴리봇",
      description:
        "현장 감지부터 익명화 영상 관제 알림까지 연결하는 Physical AI 안전관제 실증",
      images: [new URL("/og-goyang-polybot-v3.jpg", origin)],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
