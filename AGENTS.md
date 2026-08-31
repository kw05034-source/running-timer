# 체육수업 기록관리 시스템 AGENTS.md

## 1. 운영 원칙

이 프로젝트는 오케스트레이터가 전체 요구사항과 TODO를 관리하고, 서브에이전트가 작은 기능 단위로 구현·검증하는 방식으로 진행한다.

핵심 원칙:

**요구사항 정의 → 구현 → 독립 검증 → 수정 → 재검증 → 통합 → 완료**

구현한 에이전트가 자기 작업의 최종 합격 판정을 하지 않는다.

---

# 2. 오케스트레이터 역할

오케스트레이터는 전체 프로젝트의 기준을 유지한다.

담당:
- PROJECT.md 관리
- TODO.md 관리
- 우선순위 결정
- 작업을 작은 단위로 분해
- 각 작업의 완료 조건 정의
- 서브에이전트에 작업 할당
- 결과 통합
- 충돌 해결
- QA 결과에 따른 재작업 지시
- 완료 여부 최종 판단

오케스트레이터는 직접 모든 기능을 구현하기보다 전체 맥락과 품질을 관리한다.

---

# 3. 서브에이전트 기본 역할

## 3.1 UI Agent

담당:
- 학생 선택 화면
- 타이머 화면
- 기록 확인 화면
- 플로어볼 경기 기록 화면
- Chromebook에서 사용하기 쉬운 UI

검증 기준:
- 버튼 크기
- 학생 이름 식별성
- 불필요한 입력 최소화
- 화면 흐름 일관성

---

## 3.2 Timer Agent

담당:
- 장애물달리기 타이머 로직
- START / STOP
- 시간 계산
- 중복 입력 방지
- 타이머 상태 관리

특히 확인:
- START 중복
- STOP 중복
- 빠른 START→STOP
- 화면 이동 시 상태
- 저장 전 기록 고정

---

## 3.3 Data Model Agent

담당:
- 학생 ID 구조
- 명렬
- 조/팀
- activity_type
- 장애물달리기 기록 스키마
- 플로어볼 경기/개인 기록 스키마

원칙:
- 이름을 primary key로 사용하지 않음
- 향후 종목 확장이 가능해야 함

---

## 3.4 Google Sheets Agent

담당:
- Google Sheets 구조
- 데이터 저장
- 데이터 조회
- 학생별 기록 집계
- Apps Script 또는 대체 API

확인:
- 중복 저장
- 저장 실패
- 잘못된 student_id
- 네트워크 오류
- 동시 입력

---

## 3.5 Floorball Agent

담당:
- 경기 생성/선택
- 팀 관리
- 득점
- 개인 득점
- 경기 참여
- 심판/기록원 역할
- 경기 결과

초기에는 통계를 최소화한다.

---

## 3.6 QA Agent

QA Agent는 기능 구현을 하지 않는 것을 원칙으로 한다.

담당:
- PROJECT.md 요구사항과 구현 비교
- TODO 완료 조건 확인
- 정상 동작 테스트
- 예외 상황 테스트
- 회귀 테스트
- 문제 재현 절차 작성

결과 형식:
- PASS
- FAIL
- 발견된 문제
- 재현 방법
- 수정 우선순위

---

# 4. 작업 단위 운영 방식

예시: 타이머 기능

## Step 1. 오케스트레이터가 작업 정의

작업:
장애물달리기 START/STOP 구현

완료 조건:
- START 1회 동작
- 중복 START 방지
- STOP 시 시간 고정
- 중복 STOP 방지
- STOP 이후 확인 화면 호출
- 저장 전 Google Sheet 기록 금지

## Step 2. Timer Agent 구현

Timer Agent는 해당 범위만 구현한다.

## Step 3. QA Agent 검증

QA 사례:
1. START 2회 클릭
2. STOP 2회 클릭
3. START 후 0.1초 안에 STOP
4. 타이머 작동 중 다른 학생 선택 시도
5. STOP 후 취소
6. STOP 후 저장
7. 저장 버튼 연속 클릭

## Step 4. FAIL이면 수정

구현 Agent 또는 별도 Fix Agent가 수정한다.

## Step 5. QA 재검증

모든 완료 조건을 통과하면 오케스트레이터가 TODO를 완료 처리한다.

---

# 5. TODO 관리 규칙

TODO 항목은 기능 이름만 적지 않는다.

나쁜 예:
- 학생 선택 기능 만들기

좋은 예:
- 학생 선택 기능
  - 현재 조 학생만 표시
  - 학생 번호와 이름 표시
  - student_id 유지
  - 선택 후 타이머 화면 이동
  - 뒤로가기 시 상태 오류 없음

TODO 상태:
- [ ] 미착수
- [~] 구현 중
- [V] 검증 중
- [x] 완료

완료는 QA 통과 후에만 체크한다.

---

# 6. 병렬 작업 규칙

처음부터 많은 에이전트가 같은 코드베이스를 동시에 수정하지 않는다.

권장:
- 동시 2~3개 작업

초기 병렬화 예:

A. Data Model Agent
- 학생/조/기록 구조

B. UI Agent
- 학생 선택 화면

C. Timer Agent
- 타이머 로직

위 세 작업을 통합한 후 다음 단계로 넘어간다.

2차 병렬화 예:

D. Google Sheets Agent
- 저장 API

E. Summary Agent
- 학생 기록 요약

F. QA Agent
- 기존 기능 통합 테스트

---

# 7. 코드 충돌 방지

각 에이전트는 가능하면 담당 파일 또는 담당 모듈을 분리한다.

예시:

src/
- students/
- timer/
- sheets/
- obstacle-run/
- floorball/
- teacher/
- shared/

원칙:
- 공통 파일 수정은 오케스트레이터 승인 후 진행
- 동시에 여러 에이전트가 같은 핵심 파일을 수정하지 않음
- 통합 작업은 별도 단계로 진행

---

# 8. 에이전트 작업 요청 템플릿

오케스트레이터는 서브에이전트에게 다음 형식으로 요청한다.

## TASK
구현할 기능

## CONTEXT
왜 필요한지
현재 시스템에서 어디에 연결되는지

## REQUIREMENTS
필수 동작

## OUT OF SCOPE
이번 작업에서 하지 않을 것

## ACCEPTANCE CRITERIA
완료 조건

## FILES
수정 가능한 파일 또는 폴더

## TEST
반드시 확인할 테스트

## OUTPUT
변경 내용
테스트 결과
남은 문제

---

# 9. QA 요청 템플릿

## TARGET
검증할 기능

## REQUIREMENTS
PROJECT.md / TODO.md 기준 요구사항

## TEST CASES
필수 테스트 목록

## CHECK
- 정상 흐름
- 예외 흐름
- 중복 입력
- 데이터 유실
- 잘못된 학생 기록
- 화면 상태
- 저장 실패

## OUTPUT
PASS / FAIL

FAIL이면:
- 문제 설명
- 재현 방법
- 예상 동작
- 실제 동작
- 수정 우선순위

---

# 10. 개발 단계별 추천 에이전트 배치

## 단계 1. 장애물달리기 MVP
- Orchestrator
- Data Model Agent
- UI Agent
- Timer Agent
- Google Sheets Agent
- QA Agent

## 단계 2. 장애물달리기 평가자료
- Summary Agent
- Teacher View Agent
- QA Agent

## 단계 3. 플로어볼
- Floorball Agent
- UI Agent
- Data Model Agent
- Google Sheets Agent
- QA Agent

## 단계 4. 통합
- Integration Agent
- QA Agent
- Orchestrator 최종 검수

---

# 11. 가장 중요한 운영 원칙

1. 한 에이전트에게 전체 프로젝트를 맡기지 않는다.
2. 작은 기능 단위로 작업한다.
3. 각 작업에 명확한 완료 조건을 둔다.
4. 구현과 검증을 분리한다.
5. QA를 통과하기 전에는 TODO 완료 처리하지 않는다.
6. 공통 데이터 구조는 자주 바꾸지 않는다.
7. 새로운 종목은 공통 구조 위에 모듈로 추가한다.
8. 학생이 실제 수업에서 사용하기 쉬운지가 기술적 완성도보다 우선한다.

---

# 12. 첫 번째 개발 사이클

권장 시작 순서:

1. 프로젝트 구조 생성
2. 학생 데이터 모델 확정
3. 샘플 학생명렬 작성
4. 학생 선택 화면
5. 타이머 START/STOP
6. 저장 확인 화면
7. 로컬 임시 저장
8. QA
9. Google Sheets 연결
10. QA
11. Chromebook 실제 수업 환경 테스트

첫 사이클의 목표는 기능을 많이 넣는 것이 아니라,

**학생 선택 → 측정 → 저장 확인 → 기록 누적**

이 흐름을 안정적으로 완성하는 것이다.
