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
  themeColor: "#10221a",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host") || "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "SAFEBOT | 주민안전 AI 순찰·관제",
    description:
      "현장 카메라로 사람과 사물을 감지하고, 익명화된 10초 사건 영상을 관제센터에 전달하는 주민안전 AI MVP",
    applicationName: "SAFEBOT",
    manifest: "/manifest.webmanifest",
    formatDetection: {
      telephone: false,
      address: false,
      email: false,
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "SAFEBOT",
    },
    icons: {
      icon: [
        { url: "/icons/icon-192.png", type: "image/png", sizes: "192x192" },
        { url: "/icons/icon-512.png", type: "image/png", sizes: "512x512" },
      ],
      shortcut: "/icons/icon-192.png",
      apple: "/icons/icon-192.png",
    },
    openGraph: {
      type: "website",
      url: origin,
      title: "SAFEBOT | 주민안전 AI 순찰·관제",
      description:
        "현장 순찰 로봇과 비공개 사건 영상을 연결하는 개인정보 보호형 안전 관제 MVP",
      siteName: "SAFEBOT",
      locale: "ko_KR",
      images: [
        {
          url: new URL("/og-control-center.png", origin),
          width: 1200,
          height: 630,
          alt: "주민 공간을 순찰하는 SAFEBOT과 영상을 확인하는 관제센터",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "SAFEBOT | 주민안전 AI 순찰·관제",
      description:
        "현장 단말의 익명화 사건 영상을 확인하는 Physical AI 안전 관제 실증",
      images: [new URL("/og-control-center.png", origin)],
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
