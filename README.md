# SAFEBOT — 주민안전 AI 순찰·관제 MVP

현장 휴대폰 또는 순찰 로봇 카메라에서 사람·사물을 인식하고, 쓰러진 자세가 10초간 지속되면 익명화된 사건 영상을 관제센터에 전달하는 모바일 우선 PWA입니다.

## 화면 구성

| 주소 | 역할 | 주요 기능 |
| --- | --- | --- |
| `/` | 현장 단말·로봇 카메라 | 카메라 감지, 얼굴 흐림, 실시간 송출, 10초 확인, 사건 영상 녹화·전송 |
| `/control` | 관제실 | 로그인, 익명화 실시간 영상, 사건 목록·영상, 현장기기 상태 확인 |

`/control`은 관제실에서 사용하는 **관제 프로그램**입니다. 현장 단말이
카메라와 관제 송출을 켜면 얼굴 흐림과 감지 표시가 적용된 무음 영상을
WebRTC로 실시간 확인할 수 있습니다. 현장 단말에서 쓰러짐이 10초간 확정되면
해당 구간은 별도 사건 영상으로 저장되어 실시간 연결이 끝난 뒤에도 이력에서
확인할 수 있습니다.

## 실시간 시연 방법

1. 상황실 PC 또는 다른 휴대폰에서 `/control`을 열고 관제 접속 코드로
   로그인합니다. 실시간 연결 대기 화면은 자동으로 준비됩니다.
2. 현장 휴대폰에서 `/`을 열어 같은 관제 접속 코드로 연결한 뒤
   `카메라 순찰 시작`을 누릅니다.
3. 카메라가 실행되면 `관제 실시간 공유`를 누릅니다.
4. 상황실 화면에 `LIVE`가 표시되면 익명화된 무음 영상을 확인하거나
   화면 녹화로 시연 영상을 만들 수 있습니다.

현장 휴대폰의 `관제 LIVE` 숫자는 실제로 영상 연결이 완료된 관제 화면 수입니다.
촬영을 끝낼 때는 `실시간 공유 중지` 또는 `순찰 종료`를 누릅니다.

## 현재 구현 범위

- MediaPipe Pose Landmarker를 이용한 사람 자세 분석
- MediaPipe Object Detector를 이용한 사람·일반 사물 감지
- MediaPipe Face Detector와 자세·사람 영역 폴백을 이용한 얼굴 픽셀화
- 10초 연속 확인, 10초 이내 회복, 오탐 취소, 추적 중단 상태
- 서비스 워커 기반 기기 알림
- 익명화가 완료된 렌더링 화면만 최대 10초간 녹화
- IndexedDB 기기 저장: 최근 5개, 합계 50MB 이내
- 로그인 후 Cloudflare D1 비공개 사건·영상 저장·재생
- WebRTC 기반 익명화 실시간 영상: 현장 단말 1대, 관제 화면 최대 3대
- Cloudflare Durable Object WebSocket을 이용한 인증된 연결 협상
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

실시간 영상은 서버를 거치지 않는 P2P 연결이며 무료 STUN만 사용합니다.
따라서 일부 회사망·공공망·대칭형 NAT에서는 연결되지 않을 수 있습니다.
모든 네트워크에서 연결을 보장하려면 별도의 TURN 중계가 필요하고 트래픽 비용이
발생할 수 있으므로, 이 무료 MVP에는 TURN을 설정하지 않았습니다.

현재 현장 단말의 영상 업로드와 관제 담당자 조회는 하나의 관제 접속 코드를 공유합니다. 실제 주민 대상 운영 전에는 현장기기 전용 업로드 자격증명과 관제자 조회·삭제 권한을 분리해야 합니다.

현재 실시간 기능은 신뢰된 1인 시연을 위한 단일 방입니다. 같은 접속 코드를
아는 사용자는 현장 송출자와 관제 시청자 역할을 모두 선택할 수 있으므로,
여러 로봇·여러 기관 운영 전에는 현장기기 토큰, 관제자 계정, 현장별 방을
분리해야 합니다. 관제 세션은 8시간 유효하며 세션 만료 시 실시간 연결도
서버에서 종료됩니다. 시연을 마치면 현장 송출을 중지하고 관제 화면에서
로그아웃하세요. 로그아웃 직후 이미 연결된 세션까지 즉시 철회하는 기능과
계정별 접속 감사는 운영 버전의 필수 보강 항목입니다.

WebRTC P2P 연결에서는 인증된 현장기기와 관제기기가 연결 협상을 위해 서로의
공인 IP 등 일부 네트워크 메타데이터를 알 수 있습니다. IP를 중계 서버 뒤에
숨기려면 TURN이 필요하지만, 비용이 발생할 수 있어 이 무료 MVP에는 포함하지
않았습니다.

이 프로그램을 긴급 신고, 의료 판단 또는 생명안전 시스템의 대체 수단으로 사용하지 마세요. 실제 공개 장소 실증 전에는 촬영 고지, 운영방침, 적법 근거, 보관기간과 접근권한을 별도로 검토해야 합니다.

## 사건 영상 저장 원칙

- 카메라 원본 `MediaStream`과 음성은 녹화하지 않습니다.
- 얼굴·사람 익명화가 끝난 별도 캔버스만 녹화합니다.
- 익명화를 확인할 수 없는 프레임은 전체 픽셀화하여 원본 노출을 막습니다.
- 평상시 영상은 서버로 보내지 않고 사건 확인 구간만 저장합니다.
- 실시간 영상은 얼굴 흐림이 적용된 캔버스에서 생성하며 음성 트랙이 없습니다.
- 실시간 영상은 WebRTC로 기기 간 직접 전송되고 서버에 녹화되지 않습니다.
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
저장소에 커밋하지 않고 Worker secret으로만 설정합니다.

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
`migrations/`의 적용되지 않은 파일을 순서대로 원격 D1에 적용합니다.
마이그레이션에 실패하면 새 Worker 배포도 중단되므로, 테이블 없이 관제 API만
올라가는 상태를 방지합니다. `SESSION_SECRET`은 예측하기 어려운 32자 이상의 값을
사용해야 합니다.

필요한 Cloudflare 리소스는 다음과 같습니다.

- D1 데이터베이스 `safebot-events`, 바인딩 `DB`
- WebRTC 연결 신호만 전달하는 SQLite 기반 Durable Object `LiveRoom`
- 매시간 만료 사건을 정리하는 Worker Cron Trigger

이 MVP는 별도 유료 R2 구독 없이 기존 Workers/D1 무료 플랜에서 동작하도록
구성했습니다. 실시간 영상에는 무료 STUN만 사용하고 유료 TURN·Cloudflare
Realtime 중계는 활성화하지 않습니다. 애플리케이션 저장량 하드캡은 100MB로,
D1 Free의 데이터베이스 저장 한도보다 충분히 낮습니다. Cloudflare 플랜이나
가격 정책이 바뀌는 경우에는 배포 전 공식 가격표를 다시 확인해야 합니다.

무과금 운영 체크리스트:

- Cloudflare `Workers 요금제`에서 `무료 · 현재 요금제`인지 확인
- `업그레이드`, `R2 구독 추가`, Realtime TURN 구매·키 발급을 누르지 않기
- 무료 한도에 도달하면 기능 실패를 허용하고 유료 플랜으로 자동 전환하지 않기
- 배포 전 `wrangler.jsonc`에 `r2_buckets`나 TURN 자격증명이 없는지 확인

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
