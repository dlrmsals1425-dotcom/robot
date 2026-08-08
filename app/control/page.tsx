import type { Metadata } from "next";
import ControlCenter from "./control-center";

export const metadata: Metadata = {
  title: "고양 폴리봇 관제센터 | SAFEBOT",
  description:
    "고양 폴리봇 현장기기의 AI 감지 알림과 익명화된 10초 영상을 확인하는 주민안전 관제센터",
};

export default function ControlPage() {
  return <ControlCenter />;
}
