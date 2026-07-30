import type { Metadata } from "next";
import ControlCenter from "./control-center";

export const metadata: Metadata = {
  title: "SAFEBOT 관제센터 | 주민안전 AI 순찰",
  description:
    "현장 순찰기기의 쓰러짐 감지 알림과 익명화된 10초 영상을 확인하는 SAFEBOT 관제센터",
};

export default function ControlPage() {
  return <ControlCenter />;
}
