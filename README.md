# SAFEBOT — 주민안전 AI 순찰·관제 MVP

현장 휴대폰 또는 순찰 로봇 카메라에서 사람·사물을 인식하고, 쓰러진 자세가 10초간 지속되면 익명화된 사건 영상을 관제센터에 전달하는 모바일 우선 PWA입니다.

## 화면 구성

| 주소 | 역할 | 주요 기능 |
| --- | --- | --- |
| `/` | 현장 단말·로봇 카메라 | 카메라 감지, 얼굴 흐림, 10초 확인, 사건 영상 녹화·전송 |
| `/control` | 관제실 | 로그인, 사건 목록, 익명화 영상 재생, 현장기기 상태 확인 |

`/control`은 관제실에서 사용하는 **관제 프로그램**입니다. 다만 현재 MVP는 평상시 영상을 계속 원격 생중계하지 않고, 현장 단말에서 확정된 사건과 10초 영상을 받습니다. 로봇 카메라의 상시 원격 라이브 스트리밍은 WebRTC와 로봇 송신 모듈을 추가하는 다음 단계입니다.

## 현재 구현 범위

- MediaPipe Pose Landmarker를 이용한 사람 자세 분석
- MediaPipe Object Detector를 이용한 사람·일반 사물 감지
- MediaPipe Face Detector와 자세·사람 영역 폴백을 이용한 얼굴 픽셀화
- 10초 연속 확인, 10초 이내 회복, 오탐 취소, 추적 중단 상태
- 서비스 워커 기반 기기 알림
- 익명화가 완료된 렌더링 화면만 최대 10초간 녹화
- IndexedDB 기기 저장: 최근 5개, 합계 50MB 이내
- 로그인 후 Cloudflare D1/R2 비공개 사건 저장·재생
- 서버 영상·이력 7일 자동 만료
- `/control` 관제 로그인과 사건 이력 대시보드
- 홈 화면 설치가 가능한 PWA
- 실제 카메라 없이 검증할 수 있는 10초 알림 흐름 테스트

## 중요한 한계

이 프로젝트는 연구·현장 실증용 프로토타입입니다. MediaPipe는 낙상을 직접 판정하지 않으며, 현재 판정은 몸통 각도와 신체 영역 비율을 조합한 휴리스틱입니다. 눕기, 가림, 야간, 여러 사람이 겹치는 상황, 카메라 움직임에서 오탐 또는 미탐이 발생할 수 있습니다.

화면이 잠기거나 브라우저가 백그라운드로 이동하면 휴대폰 카메라 감지는 중단됩니다. 현재 알림은 감지를 실행 중인 기기에 표시되는 로컬 알림이며, 관제 화면에는 사건 이력이 전달됩니다. 앱이 닫힌 관제 기기까지 도착하는 Web Push는 VAPID 키와 관제 PWA 구독을 연결하는 다음 단계입니다.

현재 현장 단말의 영상 업로드와 관제 담당자 조회는 하나의 관제 접속 코드를 공유합니다. 실제 주민 대상 운영 전에는 현장기기 전용 업로드 자격증명과 관제자 조회·삭제 권한을 분리해야 합니다.

이 프로그램을 긴급 신고, 의료 판단 또는 생명안전 시스템의 대체 수단으로 사용하지 마세요. 실제 공개 장소 실증 전에는 촬영 고지, 운영방침, 적법 근거, 보관기간과 접근권한을 별도로 검토해야 합니다.

## 사건 영상 저장 원칙

- 카메라 원본 `MediaStream`과 음성은 녹화하지 않습니다.
- 얼굴·사람 익명화가 끝난 별도 캔버스만 녹화합니다.
- 익명화를 확인할 수 없는 프레임은 전체 픽셀화하여 원본 노출을 막습니다.
- 평상시 영상은 서버로 보내지 않고 사건 확인 구간만 저장합니다.
- 서버 영상은 공개 URL이 없으며 관제 로그인 세션을 통과해야 재생됩니다.
- 영상은 최대 12MB이며 업로드 시점부터 7일 후 삭제 대상으로 처리됩니다.

## 로컬 실행

요구 사항: Node.js 22.13 이상

```bash
npm install
npm run dev
```

현장 단말은 `http://localhost:3000`, 관제 화면은 `http://localhost:3000/control`에서 확인합니다. 카메라와 알림 권한을 허용해야 하며, 배포 환경에서는 HTTPS가 필요합니다.

## Cloudflare Workers 배포

이 저장소는 OpenAI Sites와 별개로 Cloudflare Workers에 배포할 수 있습니다.
루트의 `wrangler.jsonc`가 D1 `DB`, 비공개 R2 `EVENT_MEDIA`, 매시간 실행되는
7일 만료 정리 작업을 함께 선언합니다. 관제 비밀번호와 세션 서명키는 저장소에
커밋하지 않고 Worker secret으로만 설정합니다.

Cloudflare Workers Builds에서 GitHub 저장소를 연결할 때 다음 값을 사용합니다.

| 항목 | 값 |
| --- | --- |
| GitHub 저장소 | `dlrmsals1425-dotcom/robot` |
| Worker 이름 | `safebot-patrol-mvp` |
| 프로덕션 브랜치 | `main` |
| 루트 디렉터리 | 비워두기 |
| 빌드 명령 | `npm run build` |
| 배포 명령 | `npm run deploy:cloudflare` |
| 비프로덕션 배포 명령 | `npm run preview:cloudflare` |

Cloudflare 대시보드의 자동 생성 API 토큰을 사용하면 토큰을 저장소나 채팅에 노출하지 않고 배포할 수 있습니다. 로컬에서 이미 Wrangler 로그인을 마쳤다면 다음과 같이 직접 배포할 수도 있습니다.

```bash
npx wrangler secret put CONTROL_PASSWORD --config wrangler.jsonc
npx wrangler secret put SESSION_SECRET --config wrangler.jsonc
npm run build
npm run deploy:cloudflare
```

`npm run deploy:cloudflare`는 배포 전에
`migrations/0001_event_storage.sql`을 원격 D1에 적용합니다. 마이그레이션에
실패하면 새 Worker 배포도 중단되므로, 테이블 없이 관제 API만 올라가는 상태를
방지합니다. `SESSION_SECRET`은 예측하기 어려운 32자 이상의 값을 사용해야 합니다.

필요한 Cloudflare 리소스는 다음과 같습니다.

- D1 데이터베이스 `safebot-events`, 바인딩 `DB`
- 비공개 R2 버킷 `safebot-event-clips`, 바인딩 `EVENT_MEDIA`
- 매시간 만료 사건을 정리하는 Worker Cron Trigger

초기 관제 비밀번호는 저장소에 커밋하지 않습니다. 운영 전에는 충분히 긴 새 비밀번호로 교체하고 관제 담당자에게 별도 보안 채널로 전달하세요.

## AI 자산

모델과 WASM 런타임을 `public/` 아래에 고정해 런타임 CDN 버전 변경에 영향을 받지 않도록 했습니다.

- `pose_landmarker_lite.task`
- `blaze_face_full_range.tflite`
- `efficientdet_lite0_uint8.tflite`
- `@mediapipe/tasks-vision` WASM 런타임

모델 체크섬은 [`MODEL_CHECKSUMS.txt`](./MODEL_CHECKSUMS.txt)에서 확인할 수 있습니다.

## 다음 개발 단계

1. 현장 영상으로 임계값, 오탐률, 미탐률 검증
2. 현장기기 전용 자격증명과 관제 담당자 역할 분리
3. 관제 PWA 구독 및 실제 Web Push 연결
4. 사건 접수·확인·종결 워크플로와 접근 감사 로그
5. Jetson/ROS2/로봇 카메라 및 IMU 연동
6. WebRTC 기반 로봇 실시간 영상 연결

## 주요 참고 문서

- [MediaPipe Pose Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- [MediaPipe Object Detector for Web](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js)
- [MediaPipe Face Detector for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js)
- [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)

## 라이선스

프로젝트 코드는 [MIT License](./LICENSE)로 공개합니다. 포함된 MediaPipe 런타임과 모델은 각 원저작자의 라이선스와 이용 조건을 따릅니다.
