# SAFEBOT — 주민안전 AI 순찰·관제 MVP

현장 휴대폰 또는 순찰 로봇 카메라에서 사람·사물을 인식하고, 쓰러진 자세가 10초간 지속되면 익명화된 사건 영상을 관제센터에 전달하는 모바일 우선 PWA입니다.

## 화면 구성

| 주소 | 역할 | 주요 기능 |
| --- | --- | --- |
| `/` | 현장 단말·로봇 카메라 | 카메라 감지, 얼굴 흐림, 실시간 송출, 10초 확인, 사건 영상 녹화·전송 |
| `/control` | 관제실 | 로그인, 익명화 실시간 영상, 사건 목록·영상, 현장기기 상태 확인 |

`/control`은 관제실에서 사용하는 **관제 프로그램**입니다. 현장 단말이
카메라와 관제 송출을 켜면 얼굴 흐림과 감지 표시가 적용된 무음 영상을
우선 WebRTC로 실시간 확인할 수 있습니다. 서로 다른 5G·Wi-Fi처럼 직접 연결이
막힌 경우에는 Cloudflare Realtime TURN을 통해 익명화 영상을 원격 중계합니다.
TURN 설정이나 연결에 문제가 생기면 같은 인증 WebSocket이 익명화 화면을 초당
1장으로 임시 중계합니다. 현장 단말에서 쓰러짐이 10초간 확정되면 해당 구간은
별도 사건 영상으로 저장되어 실시간 연결이 끝난 뒤에도 이력에서 확인할 수
있습니다.

## 실시간 시연 방법

1. 상황실 PC 또는 다른 휴대폰에서 `/control`을 열고 관제 접속 코드로
   로그인합니다. 실시간 연결 대기 화면은 자동으로 준비됩니다.
2. 현장 휴대폰에서 `/`을 열어 같은 관제 접속 코드로 연결한 뒤
   `카메라 순찰 시작`을 누릅니다.
3. 카메라가 실행되면 `관제 실시간 공유`를 누릅니다.
4. 상황실 화면에 `절약형 LIVE · 360p` 또는 `저속 RELAY · 1fps`가 표시되면
   익명화된 무음 영상을 확인하거나 화면 녹화로 시연 영상을 만들 수 있습니다.

현장 휴대폰의 `관제 LIVE` 숫자는 직접 영상이 연결됐거나 저속 중계 프레임
수신이 확인된 관제 화면 수입니다. 관제 화면의 `절약형 LIVE · 360p` 또는
`저속 RELAY · 1fps` 표시로 실제 수신을 함께 확인합니다. 촬영을 끝낼 때는
`실시간 공유 중지` 또는 `순찰 종료`를 누릅니다.

## 현재 구현 범위

- MediaPipe Pose Landmarker를 이용한 사람 자세 분석
- MediaPipe Object Detector를 이용한 사람·일반 사물 감지
- MediaPipe Face Detector와 자세·사람 영역 폴백을 이용한 얼굴 픽셀화
- 10초 연속 확인, 10초 이내 회복, 오탐 취소, 추적 중단 상태
- 서비스 워커 기반 기기 알림
- 익명화가 완료된 렌더링 화면만 최대 10초간 녹화
- IndexedDB 기기 저장: 최근 5개, 합계 50MB 이내
- 로그인 후 Cloudflare D1 비공개 사건·영상 저장·재생
- Cloudflare Realtime TURN 지원 익명화 WebRTC: 최대 360p·12fps·350kbps,
  현장 단말 1대, 관제 화면 최대 3대, 음성 없음
- 직접 연결 실패 시 320px·1fps·48KiB 이하 JPEG 무저장 저속 중계
- Cloudflare Durable Object WebSocket을 이용한 인증된 연결 협상·중계
- 서버 사건 영상 합계 100MB 하드캡(초과 업로드 차단)
- 서버 영상·이력 7일 자동 만료
- `/control` 관제 로그인과 사건 이력 대시보드
- 홈 화면 설치가 가능한 PWA
- 실제 카메라 없이 검증할 수 있는 10초 알림 흐름 테스트

## 중요한 한계

이 프로젝트는 연구·현장 실증용 프로토타입입니다. MediaPipe는 낙상을 직접 판정하지 않으며, 현재 판정은 몸통 각도와 신체 영역 비율을 조합한 휴리스틱입니다. 눕기, 가림, 야간, 여러 사람이 겹치는 상황, 카메라 움직임에서 오탐 또는 미탐이 발생할 수 있습니다.

얼굴 흐림도 AI 검출 결과를 사용하므로 사람과 얼굴을 모든 모델이 동시에
미탐한 경우까지 완전히 보장할 수는 없습니다. 실제 공개 장소 운영 전에는
촬영 고지와 함께 야간·역광·군중·가림 조건의 별도 개인정보 보호 검증이
필요합니다.

화면이 잠기거나 브라우저가 백그라운드로 이동하면 휴대폰 카메라 감지와
실시간 송출은 중단됩니다. 현재 알림은 감지를 실행 중인 기기에 표시되는 로컬
알림이며, 관제 화면에는 사건 이력이 전달됩니다. 앱이 닫힌 관제 기기까지
도착하는 Web Push는 VAPID 키와 관제 PWA 구독을 연결하는 다음 단계입니다.

실시간 영상은 무료 STUN을 사용한 P2P 연결을 먼저 시도하고, 직접 연결이 막힌
회사망·공공망·대칭형 NAT에서는 Cloudflare Realtime TURN으로 원격 중계합니다.
TURN 자격증명 발급이나 연결이 실패하면 약 5초 뒤 익명화 화면을 초당 1장으로
보내는 저속 안전 중계로 전환합니다. 이 최종 중계는 연결 확인용이므로 부드러운
동영상이나 긴급 대응 수준의 지연시간을 보장하지 않습니다.

현재 현장 단말의 영상 업로드와 관제 담당자 조회는 하나의 관제 접속 코드를 공유합니다. 실제 주민 대상 운영 전에는 현장기기 전용 업로드 자격증명과 관제자 조회·삭제 권한을 분리해야 합니다.

현재 실시간 기능은 신뢰된 1인 시연을 위한 단일 방입니다. 같은 접속 코드를
아는 사용자는 현장 송출자와 관제 시청자 역할을 모두 선택할 수 있으므로,
여러 로봇·여러 기관 운영 전에는 현장기기 토큰, 관제자 계정, 현장별 방을
분리해야 합니다. 관제 세션은 8시간 유효하며 세션 만료 시 실시간 연결도
서버에서 종료됩니다. 시연을 마치면 현장 송출을 중지하고 관제 화면에서
로그아웃하세요. 로그아웃 직후 이미 연결된 세션까지 즉시 철회하는 기능과
계정별 접속 감사는 운영 버전의 필수 보강 항목입니다.

WebRTC는 가능한 경우 기기 간 직접 연결하고, 막힌 환경에서는 Cloudflare TURN을
사용합니다. TURN과 저속 fallback 모두 서버를 신뢰 범위에 포함합니다. 저속
중계 JPEG는 저장·캐시·로그하지 않지만, 얼굴 외 장소·체형·행동 정보가 포함될
수 있으므로 실증 전 촬영·처리 고지가 필요합니다.

이 프로그램을 긴급 신고, 의료 판단 또는 생명안전 시스템의 대체 수단으로 사용하지 마세요. 실제 공개 장소 실증 전에는 촬영 고지, 운영방침, 적법 근거, 보관기간과 접근권한을 별도로 검토해야 합니다.

## 사건 영상 저장 원칙

- 카메라 원본 `MediaStream`과 음성은 녹화하지 않습니다.
- 얼굴·사람 익명화가 끝난 별도 캔버스만 녹화합니다.
- 익명화를 확인할 수 없는 프레임은 전체 픽셀화하여 원본 노출을 막습니다.
- 실시간 공유를 켜지 않은 평상시 영상은 전송하지 않고 사건 확인 구간만
  저장합니다.
- 실시간 영상은 얼굴 흐림이 적용된 캔버스에서 생성하며 음성 트랙이 없습니다.
- 실시간 영상은 WebRTC로 기기 간 직접 전송하는 것을 우선합니다.
- 직접 연결이 막히면 서버에서 발급한 1시간 이내 단기 TURN 자격증명으로
  Cloudflare Realtime 중계를 사용합니다. 장기 TURN 키는 Worker secret에만
  저장하며 브라우저나 저장소에 포함하지 않습니다. 단기 자격증명은 로그인
  남은 시간보다 길게 발급하지 않고 같은 세션 요청에서는 재사용합니다.
- WebRTC 송출은 최대 360p·12fps·350kbps, 관제 화면 3대로 제한합니다.
- 직접 연결 실패 시 같은 익명화 캔버스를 320px JPEG로 축소해 초당 1장만
  인증된 관제 화면에 전달하고, 해당 프레임은 서버에 저장하지 않습니다.
- 서버 영상은 공개 URL이 없으며 관제 로그인 세션을 통과해야 재생됩니다.
- 영상은 최대 12MB이며 업로드 시점부터 7일 후 삭제 대상으로 처리됩니다.
- 서버 영상은 D1에 1MB 이하 조각으로 저장되고, 전체 사건 영상 합계가
  100MB를 넘는 업로드는 데이터베이스 트랜잭션에서 거부됩니다.
- 서버 한도에 도달해도 휴대폰 IndexedDB의 최근 영상은 유지됩니다.

## 로컬 실행

요구 사항: Node.js 22.13 이상

```bash
npm install
npm run dev
```

현장 단말은 `http://localhost:3000`, 관제 화면은 `http://localhost:3000/control`에서 확인합니다. 카메라와 알림 권한을 허용해야 하며, 배포 환경에서는 HTTPS가 필요합니다.

## Cloudflare Workers 배포

이 저장소는 OpenAI Sites와 별개로 Cloudflare Workers에 배포할 수 있습니다.
루트의 `wrangler.jsonc`가 D1 `DB`와 매시간 실행되는 7일 만료 정리 작업을
선언합니다. R2는 사용하거나 구독하지 않습니다. 관제 비밀번호와 세션 서명키는
저장소에 커밋하지 않고 Worker secret으로만 설정합니다. Realtime TURN의 장기
키도 같은 방식으로 보관합니다.

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
npx wrangler secret put TURN_KEY_ID --config wrangler.jsonc
npx wrangler secret put TURN_KEY_API_TOKEN --config wrangler.jsonc
npm run build
npm run deploy:cloudflare
```

`npm run deploy:cloudflare`는 배포 전에
`migrations/`의 적용되지 않은 파일을 순서대로 원격 D1에 적용합니다.
마이그레이션에 실패하면 새 Worker 배포도 중단되므로, 테이블 없이 관제 API만
올라가는 상태를 방지합니다. `SESSION_SECRET`은 예측하기 어려운 32자 이상의 값을
사용해야 합니다.

필요한 Cloudflare 리소스는 다음과 같습니다.

- D1 데이터베이스 `safebot-events`, 바인딩 `DB`
- WebRTC 연결 신호와 무저장 저속 fallback 프레임을 전달하는 SQLite 기반
  Durable Object `LiveRoom`
- 브라우저에는 단기 자격증명만 전달하는 Cloudflare Realtime TURN key
- 매시간 만료 사건을 정리하는 Worker Cron Trigger

이 MVP는 R2를 구독하지 않으며 Workers/D1/Durable Objects와 Cloudflare
Realtime의 무료 포함량을 사용합니다. Realtime은 매월 첫 1,000GB가
포함됩니다. 앱은 음성 없이 최대 350kbps, 관제 3대로 제한하므로 세 화면이
31일 내내 모두 TURN을 사용해도 순수 영상 데이터는 약 352GB입니다. 프로토콜
오버헤드 25%를 보수적으로 더하면 약 440GB이고, 양쪽 기기가 모두 TURN을 쓰는
2중 릴레이까지 가정해도 약 879GB입니다. 앱은 송신 제한을 적용할 수 없는
브라우저에서는 무제한 WebRTC 대신 1fps 안전 중계로 전환합니다. 직접 P2P
연결을 우선하므로 일반적인 TURN 미디어 사용량은 이보다 더 줄어듭니다.

비용 절약 운영 체크리스트:

- `MAX_VIDEO_BITRATE = 350_000`, `FRAME_RATE = 12`, 관제 3대 제한 유지
- 관제 종료 후 현장 단말에서 `실시간 공유 중지` 누르기
- Cloudflare Realtime 사용량을 주기적으로 확인하고 700GB 이상이면 송출 중지
- `wrangler.jsonc`나 GitHub에 TURN 장기 키를 넣지 않고 Worker secret만 사용
- Cloudflare 플랜이나 가격 정책이 바뀌면 배포 전 공식 가격표 다시 확인

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
6. Jetson/ROS2 송신 모듈에서 현재 WebRTC 프로토콜 연결

## 주요 참고 문서

- [MediaPipe Pose Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- [MediaPipe Object Detector for Web](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js)
- [MediaPipe Face Detector for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js)
- [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN Notifications API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
- [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)

## 라이선스

프로젝트 코드는 [MIT License](./LICENSE)로 공개합니다. 포함된 MediaPipe 런타임과 모델은 각 원저작자의 라이선스와 이용 조건을 따릅니다.
