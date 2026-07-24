# chatlog (챗로그)

## 설치

### 1. 클라이언트 확장 (깃허브 설치)
ST → 확장 → Install extension → 이 저장소 URL 붙여넣기

수동 설치라면 저장소 전체를:
```
SillyTavern/public/scripts/extensions/third-party/chatlog/
```

### 2. 서버 플러그인 (수동 필수)
서버 플러그인은 확장 설치 기능으로 안 들어갑니다. 직접 복사하세요:
```
server/  →  SillyTavern/plugins/chatlog/
```
`config.yaml` 에서 `enableServerPlugins: true` 확인 후 ST 재시작.

### 3. 설정
확장 탭 → chatlog
- 연결 프로필 (텍스트 생성)
- 이미지 API 키 (별도)
- 활동 시간대 / 업로드 간격 / 댓글 지연

---

## 강제 실행

### 슬래시 커맨드 (ST 채팅창)
| 커맨드 | 설명 |
|---|---|
| `/chatlog` | 챗로그 열기 |
| `/chatlog-run` | 대기 댓글 + 캐릭터 컷 전부 지금 실행 |
| `/chatlog-run what=comments` | 대기 중인 댓글만 지금 실행 |
| `/chatlog-run what=cut` | 캐릭터 컷만 지금 생성 |
| `/chatlog-run room=우리로그` | 특정 로그만 |
| `/chatlog-now` | 다음 슬롯 시각을 지금으로 당김 (1분 내 실행) |
| `/chatlog-local` | 대기 댓글을 브라우저에서 조용히 생성 (채팅 UI에 안 뜸) |
| `/chatlog-jobs` | 대기 중인 작업 목록 (콘솔에 표로 출력) |

### curl (터먹스에서 직접)
```bash
# 전부 지금 실행
curl -X POST http://127.0.0.1:8000/api/plugins/chatlog/force \
  -H 'Content-Type: application/json' -d '{"what":"all"}'

# 댓글만
curl -X POST http://127.0.0.1:8000/api/plugins/chatlog/force \
  -H 'Content-Type: application/json' -d '{"what":"comments"}'

# 다음 슬롯 당기기
curl -X POST http://127.0.0.1:8000/api/plugins/chatlog/force/now \
  -H 'Content-Type: application/json' -d '{}'

# 대기 작업 확인
curl http://127.0.0.1:8000/api/plugins/chatlog/jobs

# 현재 상태 통째로
curl http://127.0.0.1:8000/api/plugins/chatlog/state
```
포트는 ST 설정에 맞게 바꾸세요. ST에 인증을 걸어뒀다면 `-u 아이디:비번` 추가.

### 데이터 위치
```
plugins/chatlog/data.json       # 방 / 게시물 / 작업 큐
plugins/chatlog/settings.json   # 플러그인 설정
public/user/images/chatlog/     # 생성된 이미지
```
큐가 꼬이면 `data.json` 의 `jobs` 를 `[]` 로 비우고 재시작하면 됩니다.

---

## 남은 작업
프롬프트 튜닝 (`server/ai.js` 의 `generateComment`, `generateCharacterCut`)

---

## 저장 / 정리

- 게시물 하단 **저장** — 사진 파일 다운로드
- 게시물 하단 **보관** — 자동 삭제 대상에서 제외
- 하루로그 → **움짤 저장** — 그날 사진을 webm 영상으로 내보내기 (컷당 0.7초, 켄번스 줌)
- 확장 탭 → **지난 기록 자동 삭제** — N일 지난 게시물·사진·하루로그 영상 일괄 삭제 (하루 한 번 자동, 또는 "지금 정리")

---

## 생성 경로

| 상황 | 사용 API | 채팅 UI |
|---|---|---|
| 서버 스케줄러 (기본) | `server/ai.js` 직접 호출 | 안 뜸 |
| `/chatlog-local` | `ConnectionManagerRequestService` | 안 뜸 |

둘 다 활성 연결 프로필을 바꾸지 않습니다.
