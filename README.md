# Gateway Forward Capture

Cloudflare Zero Trust Gateway HTTP 정책의 **Forward** 액션(공개 베타)으로 요청을 이 Worker에 넘겨,
메일 발송·첨부 업로드의 **사용자 · 발신 · 수신 · 시간 · 전송 경로 · 제목 · 파일명 · 원문**을 저장하고
대시보드로 보여줍니다. Cloudflare **Workers + R2 + D1**만 사용합니다.

```
사용자 ──HTTPS──▶ Gateway (TLS 복호화)
                    │ HTTP 정책: POST + Application "Naver Mail" + 대상 사용자 → Forward
                    ▼
          Worker  GatewayMiddleware.handle(request, context, next)
            ├─ next(request)  ─────────────────────▶ 원래 목적지 (본문 그대로 전달)
            └─ 본문 사본(tee) → waitUntil(백그라운드)
                 ├─ 파싱: 발신/수신(to·cc·bcc)/제목, multipart 첨부
                 ├─ R2  raw/<날짜>/<id>      요청 원문
                 ├─ R2  files/<id>/<n>        첨부 원본
                 └─ D1  captures, capture_files
          Worker  fetch → 대시보드(/) + /api/*
```

## 동작 원칙

- **트래픽을 막지 않습니다.** Forward Worker가 예외를 던지면 Gateway가 요청을 차단(fail closed)하므로,
  원본 요청은 항상 `next()`로 그대로 보내고 저장은 본문 사본으로 백그라운드에서만 합니다. 저장이 실패해도
  로그만 남고 메일 전송에는 영향이 없습니다.
- **복호화가 따로 필요 없습니다.** Gateway가 TLS를 풀어 평문 본문을 넘겨줍니다. `Content-Encoding`
  (gzip/deflate/br)이 있으면 그것만 풉니다.
- **쿠키·인증 헤더는 저장하지 않습니다.** Content-Type, User-Agent, Referer 등만 남깁니다.
- 본문은 요청당 최대 `MAX_CAPTURE_BYTES`(기본 25 MiB)까지만 저장하고, 그 이상은 "잘림"으로 표시합니다.
  원래 목적지에는 항상 전체가 전달됩니다.

## 배포

1. 이 Worker를 배포합니다 (R2 버킷·D1은 첫 배포 때 자동 생성):
   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put DASHBOARD_TOKEN   # 길고 무작위인 문자열
   npm run deploy
   ```
2. Zero Trust → Traffic policies → HTTP 정책 → **Then: Forward → Worker: `gateway-forward-capture`**.
   범위는 좁게 유지하세요 (예: HTTP Method `POST` + Application `Naver Mail` + 테스트 사용자).
3. `https://gateway-forward-capture.<계정>.workers.dev/` 에서 `DASHBOARD_TOKEN`으로 대시보드를 엽니다.
   **Cloudflare Access**(Settings → Domains & Routes → workers.dev → Enable Cloudflare Access)로 한 번 더
   막는 것을 권장합니다.

## 대시보드 / API

- 목록: 시간 · 사용자(Zero Trust) · 발신 · 수신 · 전송 경로 · 제목 · 첨부파일 · 원문 크기
- 행 클릭 → 상세: 전체 메타데이터, 첨부 다운로드, **원문 미리보기(최대 256 KiB) + 원문 다운로드**,
  본문 필드 이름 목록(추출 규칙 보정용)
- 필터: 기간, 종류(메일·첨부 / 메일 발송 / 전체), 사용자, 발신, 수신, 제목, 파일명
- API (`Authorization: Bearer <DASHBOARD_TOKEN>`): `GET /api/captures`, `/api/captures/<id>`,
  `/api/captures/<id>/preview`, `/api/captures/<id>/raw`, `/api/captures/<id>/files/<n>`, `/api/status`

## 한계 / 확인 필요

- **발신·수신 추출은 필드 이름 기반 추정입니다.** 네이버 메일의 실제 요청 형식이 문서화돼 있지 않아
  `to`, `toList`, `cc`, `bcc`, `from`, `senderAddress`, `subject`, `title` 같은 이름으로 찾습니다.
  실제 캡처의 상세 화면에 나오는 "본문 필드 이름"을 보고 `src/parse.ts`의 규칙을 맞춰야 합니다.
- **Device name, Application name은 Forward context에 없습니다** (사용자 이메일·IP·Host·URL·정책 ID만 제공).
- Forward는 공개 베타이고, WebSocket·CONNECT 터널은 Worker를 거치지 않습니다.
- 저장된 원문·첨부는 민감 데이터입니다. 버킷은 비공개로 두고 R2 lifecycle rule로 보존 기간을 정하세요.

## 로컬 테스트

```bash
npx wrangler dev --var ENABLE_TEST_FORWARD:true --var DASHBOARD_TOKEN:local-test-token
curl -X POST -H "content-type: application/x-www-form-urlencoded" \
  --data "to=alice%40example.com&subject=test&senderAddress=me%40naver.com" \
  "http://127.0.0.1:8787/__test/forward?user=tester%40example.com"
```

`/__test/forward`는 가짜 Gateway context로 `handle()`을 호출하고, 원래 목적지 역할을 하는 가짜 `next()`가
받은 바이트 수와 SHA-256을 돌려줍니다 (본문이 그대로 전달되는지 확인용). `ENABLE_TEST_FORWARD`는
`wrangler.toml`에 없으므로 배포된 Worker에서는 꺼져 있습니다.
