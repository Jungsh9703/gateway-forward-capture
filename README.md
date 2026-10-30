# Gateway Forward Capture

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Jungsh9703/gateway-forward-capture)

Cloudflare Zero Trust Gateway HTTP 정책의 **Forward** 액션(공개 베타)으로 요청을 이 Worker에 넘겨,
메일 발송·첨부 업로드의 **사용자 · 애플리케이션 · 발신 · 수신 · 시간 · 전송 경로 · 제목 · 파일명 · 원문**을 저장하고
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
                 ├─ D1  captures, capture_files
                 └─ Host → 애플리케이션 조회 (Resource Library API → D1 host_apps, 7일 캐시)
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

1. 이 Worker를 배포합니다 (R2 버킷·D1은 첫 배포 때 자동 생성).

   **방법 A — 맨 위 Deploy to Cloudflare 버튼:** Cloudflare가 이 저장소를 내 GitHub 계정으로 복제한 뒤
   배포하고, 이후 그 복제본에 push할 때마다 자동으로 다시 배포합니다. 설정 화면에서:
   - `DASHBOARD_TOKEN`: 길고 무작위인 문자열 (대시보드 로그인에 사용)
   - `CF_ACCOUNT_ID` / `CF_API_TOKEN`: 애플리케이션 이름 조회용 (선택, 토큰 권한 Account > Zero Trust > Read)
   - R2 버킷·D1 이름은 기본값 그대로 두면 됩니다

   **방법 B — 로컬에서 wrangler:**
   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put DASHBOARD_TOKEN   # 길고 무작위인 문자열
   npx wrangler secret put CF_API_TOKEN      # 선택: Account > Zero Trust > Read (애플리케이션 이름 조회)
   npm run deploy
   ```
   애플리케이션 이름을 쓰려면 `wrangler.toml`의 `CF_ACCOUNT_ID`도 채웁니다.
2. Zero Trust → Traffic policies → HTTP 정책 → **Then: Forward → Worker: `gateway-forward-capture`**
   (버튼 배포 때 Worker 이름을 바꿨다면 그 이름).
   범위는 좁게 유지하세요 (예: HTTP Method `POST` + Application `Naver Mail` + 테스트 사용자).
3. `https://gateway-forward-capture.<계정>.workers.dev/` 에서 `DASHBOARD_TOKEN`으로 대시보드를 엽니다.
   **Cloudflare Access**(Settings → Domains & Routes → workers.dev → Enable Cloudflare Access)로 한 번 더
   막는 것을 권장합니다.

## 애플리케이션 이름

Forward context에는 애플리케이션 정보가 없어서, 요청 Host를 Cloudflare **Resource Library**
(`GET /accounts/{id}/resource-library/applications?filter=hostname:<host>` — Gateway의 Application 선택지와
같은 목록)에서 조회합니다. 그래서 정책을 "HTTP Method = POST"처럼 넓혀도 요청마다 애플리케이션이 붙습니다.

- Host 그대로 → 상위 도메인 순으로 찾습니다 (`m.mail.naver.com` → `mail.naver.com`). 상위 도메인에서는 앱의
  **고유 hostname**만 인정하고, 여러 앱이 같이 쓰는 support domain(예: Naver Mail의 `naver.com`)은 Host가 정확히
  같을 때만 인정합니다 — `www.naver.com` 검색이 Naver Mail로 잡히지 않도록.
- 결과는 D1 `host_apps`에 캐시되고(찾음 7일, 못 찾음 1일) **조회 시점에 조인**되므로, 매핑을 고치면 과거 데이터도
  바로 반영됩니다.
- 라이브러리에 없는 Host는 직접 지정할 수 있습니다 (자동 조회가 덮어쓰지 않음):
  ```sql
  INSERT OR REPLACE INTO host_apps (host, app_name, source, fetched_at)
  VALUES ('upload.example.com', '사내 파일공유', 'manual', unixepoch() * 1000);
  ```
- `CF_ACCOUNT_ID` / `CF_API_TOKEN`이 없으면 "(unknown)"으로 표시됩니다.

## 대시보드 / API

- **요약 탭:** 캡처 요청 수, 메일 발송, 첨부파일, 사용자, 애플리케이션, 전송량 + 일별 요청 차트 +
  상위 애플리케이션 / 사용자 / 수신자 / Host (항목을 누르면 그 조건으로 상세 내역 탭이 열림)
- **상세 내역 탭:** 시간 · 사용자(Zero Trust) · 애플리케이션 · 발신 · 수신 · 전송 경로 · 제목 · 첨부파일 · 원문 크기
- 행 클릭 → 상세: 전체 메타데이터, 첨부 다운로드, **원문 미리보기(최대 256 KiB) + 원문 다운로드**,
  본문 필드 이름 목록(추출 규칙 보정용)
- 필터(두 탭 공통): 기간, 종류(메일·첨부 / 메일 발송 / 전체), 사용자, 애플리케이션, Host, 발신, 수신, 제목, 파일명
- API (`Authorization: Bearer <DASHBOARD_TOKEN>`): `GET /api/summary`, `GET /api/captures`, `/api/captures/<id>`,
  `/api/captures/<id>/preview`, `/api/captures/<id>/raw`, `/api/captures/<id>/files/<n>`, `/api/status`

## 한계 / 확인 필요

- **발신·수신 추출은 필드 이름 기반 추정입니다.** 네이버 메일의 실제 요청 형식이 문서화돼 있지 않아
  `to`, `toList`, `cc`, `bcc`, `from`, `senderAddress`, `subject`, `title` 같은 이름으로 찾습니다.
  실제 캡처의 상세 화면에 나오는 "본문 필드 이름"을 보고 `src/parse.ts`의 규칙을 맞춰야 합니다.
- **Device name은 Forward context에 없습니다** (사용자 이메일·IP·Host·URL·정책 ID만 제공). 애플리케이션은
  위처럼 Host로 조회합니다.
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
