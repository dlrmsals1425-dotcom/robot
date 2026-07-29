# SAFEBOT — 주민안전 AI 순찰 MVP

휴대폰 후면 카메라에서 사람·사물을 인식하고, 누운 자세가 10초간 지속되면 기기 안전 알림과 이벤트 이력을 만드는 모바일 우선 PWA입니다.

## 현재 구현 범위

- MediaPipe Pose Landmarker를 이용한 사람 자세 분석
- MediaPipe Object Detector를 이용한 사람·일반 사물 감지
- MediaPipe Face Detector와 자세·사람 영역 폴백을 이용한 얼굴 픽셀화
- 10초 연속 확인, 10초 이내 회복, 오탐 취소, 추적 중단 상태
- 서비스 워커 기반 기기 알림
- 익명화된 이벤트 화면과 처리 이력의 기기 로컬 저장
- 홈 화면 설치가 가능한 PWA
- 실제 카메라 없이 검증할 수 있는 10초 알림 흐름 테스트

## 중요한 한계

이 프로젝트는 연구·현장 실증용 프로토타입입니다. MediaPipe는 낙상을 직접 판정하지 않으며, 현재 판정은 몸통 각도와 신체 영역 비율을 조합한 휴리스틱입니다. 눕기, 가림, 야간, 여러 사람이 겹치는 상황, 카메라 움직임에서 오탐 또는 미탐이 발생할 수 있습니다.

화면이 잠기거나 브라우저가 백그라운드로 이동하면 휴대폰 카메라 감지는 중단됩니다. 현재 버전의 알림은 감지를 실행 중인 기기에 표시되는 로컬 알림입니다. 앱이 닫혀 있어도 별도 관제 기기로 전달되는 웹푸시는 인증, 사건 API, 데이터베이스, VAPID 키를 갖춘 서버 단계에서 연결해야 합니다.

이 프로그램을 긴급 신고, 의료 판단 또는 생명안전 시스템의 대체 수단으로 사용하지 마세요. 실제 공개 장소 실증 전에는 촬영 고지, 운영방침, 적법 근거, 보관기간과 접근권한을 별도로 검토해야 합니다.

## 로컬 실행

요구 사항: Node.js 22.13 이상

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 열고 카메라와 알림 권한을 허용합니다. 배포 환경에서는 카메라와 서비스 워커를 위해 HTTPS가 필요합니다.

## AI 자산

모델과 WASM 런타임을 `public/` 아래에 고정해 런타임 CDN 버전 변경에 영향을 받지 않도록 했습니다.

- `pose_landmarker_lite.task`
- `blaze_face_full_range.tflite`
- `efficientdet_lite0_uint8.tflite`
- `@mediapipe/tasks-vision` WASM 런타임

모델 체크섬은 [`MODEL_CHECKSUMS.txt`](./MODEL_CHECKSUMS.txt)에서 확인할 수 있습니다.

## 다음 개발 단계

1. 현장 영상으로 임계값, 오탐률, 미탐률 검증
2. 이벤트 API와 관제 데이터베이스 구축
3. 관제 PWA 구독 및 실제 Web Push 연결
4. 사용자 인증, 사건 접수·확인·종결 워크플로
5. Jetson/ROS2/로봇 카메라 및 IMU 연동
6. 네트워크 단절 시 재전송과 중복 이벤트 방지

## 주요 참고 문서

- [MediaPipe Pose Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- [MediaPipe Object Detector for Web](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js)
- [MediaPipe Face Detector for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js)
- [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)

## 라이선스

프로젝트 코드는 [MIT License](./LICENSE)로 공개합니다. 포함된 MediaPipe 런타임과 모델은 각 원저작자의 라이선스와 이용 조건을 따릅니다.
