# Discord Schedule Bot

월~일요일 + 30분 단위(19:00~21:00) 일정 조율용 디스코드 봇입니다.

## Features

- `/일정생성` 슬래시 명령어로 조율판 생성
- 요일 버튼(월~일) 선택
- 시간 선택(19:00, 19:30, 20:00, 20:30, 21:00)
- 사용자별 가능 시간 집계
- 가장 많이 가능한 시간 자동 표시
- `내 선택 초기화` 버튼 제공

## Setup

1. Node.js 18 이상 설치
2. 프로젝트 폴더에서 의존성 설치
3. `.env` 파일 작성
4. 봇 실행

```bash
npm install
copy .env.example .env
npm start
```

## Environment Variables

- `DISCORD_TOKEN`: Bot Token
- `CLIENT_ID`: Discord Application Client ID
- `GUILD_ID` (선택): 테스트 서버 ID (설정하면 슬래시 명령어가 즉시 반영)
