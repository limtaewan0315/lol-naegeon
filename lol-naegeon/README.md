# ⚔ 롤 내전 매니저

티어·라인 기반 팀 균형 매칭 + 전적 기록 대시보드

## 기능
- 참가자 10명 추가 (소환사명 + 티어 + 라인)
- 티어×라인 점수표 기반 팀 균형 자동 배정 (3000회 시뮬레이션)
- 경기 결과 기록 (블루/레드 승리)
- 전적 통계 (총 경기, 블루/레드 승수, 승률)
- 소환사별 개인 승률 통계
- 기록 개별/전체 삭제

## 로컬 실행

```bash
npm install
npm run dev
```
http://localhost:3000 접속

## Vercel 배포 방법

### 1. GitHub에 올리기
```bash
git init
git add .
git commit -m "첫 번째 커밋"
git branch -M main
git remote add origin https://github.com/내아이디/lol-naegeon.git
git push -u origin main
```

### 2. Vercel 배포
1. https://vercel.com 에서 GitHub으로 로그인
2. `Add New Project` 클릭
3. `lol-naegeon` 저장소 선택
4. `Deploy` 클릭
5. 완료! → `yourname.vercel.app` 주소 생성

## 데이터 저장
- 경기 기록은 브라우저 `localStorage`에 저장됩니다.
- 같은 브라우저에서는 새로고침해도 데이터가 유지됩니다.
- 여러 기기에서 공유하려면 DB 연동이 필요합니다 (추후 업그레이드 가능).
