import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// 유지보수 모드 스위치: Vercel 대시보드 → Settings → Environment Variables 에서
// MAINTENANCE_MODE 값을 true 로 설정 + 재배포하면 사이트 전체가 안내 화면으로 바뀜.
// 다시 운영하려면 MAINTENANCE_MODE 를 false 로 바꾸거나 변수 자체를 지우고 재배포하면 됨.
// DB는 전혀 건드리지 않으므로 데이터는 그대로 보존됨.
const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>운영 중단 안내</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: #0f1115; color: #e8e8ec;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Pretendard, sans-serif;
    text-align: center; padding: 24px; box-sizing: border-box;
  }
  .box { max-width: 420px; }
  h1 { font-size: 20px; margin-bottom: 12px; }
  p { font-size: 14px; color: #a3a3ad; line-height: 1.6; }
</style>
</head>
<body>
  <div class="box">
    <h1>운영을 중단합니다</h1>
  </div>
</body>
</html>`

export function middleware(req: NextRequest) {
  if (process.env.MAINTENANCE_MODE === 'true') {
    return new NextResponse(MAINTENANCE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '3600' },
    })
  }
  return NextResponse.next()
}

// _next(정적 자산), favicon 등은 제외하고 모든 페이지 요청에 적용
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
