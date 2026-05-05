export const DEMO_SOURCES = [
  {
    uri: "demo://quantum-mechanics",
    type: "demo",
    title: "양자역학 입문",
    raw_content: "양자역학의 기초 개념을 소개합니다..."
  }
];

export const DEMO_PAGES = [
  {
    slug: "양자역학-입문",
    title: "양자역학 입문",
    content: `# 양자역학 입문\n\n양자역학은 원자와 아원자 입자의 행동을 설명하는 물리학의 분야입니다.\n\n## 핵심 개념\n\n### 파동-입자 이중성\n입자는 파동과 입자의 성질을 동시에 가집니다. ~~이것만 이해하면 양자역학 마스터~~\n\n### 불확정성 원리\n[[하이젠베르크]]가 제안한 원리로, 위치와 운동량을 동시에 정확히 측정할 수 없습니다. (아인슈타인도 처음엔 못 믿었다고 합니다)\n\n### 슈뢰딩거 방정식\n$$i\\hbar\\frac{\\partial}{\\partial t}|\\psi(t)\\rangle = \\hat{H}|\\psi(t)\\rangle$$\n\n양자계의 시간 변화를 기술하는 기본 방정식입니다.\n\n## 관련 개념\n- [[슈뢰딩거-방정식]]\n- [[하이젠베르크]]\n- [[양자-중첩]]\n- [[양자-얽힘]]`,
    page_type: "source",
    source_id: 1
  },
  {
    slug: "슈뢰딩거-방정식",
    title: "슈뢰딩거 방정식",
    content: `# 슈뢰딩거 방정식\n\n**슈뢰딩거 방정식**은 양자역학에서 양자계의 [[파동함수]]를 기술하는 편미분 방정식입니다.\n\n## 시간 의존 방정식\n$$i\\hbar\\frac{\\partial}{\\partial t}\\Psi(\\mathbf{r},t) = \\hat{H}\\Psi(\\mathbf{r},t)$$\n\n## 시간 독립 방정식\n$$\\hat{H}|\\psi\\rangle = E|\\psi\\rangle$$\n\n여기서 $E$는 에너지 고유값입니다. ~~사실 이 방정식만 풀면 세상 모든 화학 문제가 풀린다는 건 비밀~~\n\n## 역사\n1926년 에르빈 슈뢰딩거가 발표했습니다. [[하이젠베르크]]의 행렬역학과 동등하다는 것이 나중에 증명되었습니다.`,
    page_type: "concept",
    source_id: 1
  },
  {
    slug: "하이젠베르크",
    title: "하이젠베르크의 불확정성 원리",
    content: `# 하이젠베르크의 불확정성 원리\n\n**불확정성 원리**는 1927년 베르너 하이젠베르크가 발표한 [[양자역학-입문|양자역학]]의 핵심 원리입니다.\n\n## 수학적 표현\n$$\\Delta x \\cdot \\Delta p \\geq \\frac{\\hbar}{2}$$\n\n위치($x$)의 불확정성과 운동량($p$)의 불확정성의 곱은 항상 $\\frac{\\hbar}{2}$ 이상입니다.\n\n## 의미\n(이건 측정 기술의 한계가 아니라 자연의 근본적인 성질입니다!)\n\n이 원리는 고전물리학의 결정론적 세계관에 근본적인 도전을 제기했습니다.`,
    page_type: "concept",
    source_id: 1
  },
  {
    slug: "양자-중첩",
    title: "양자 중첩",
    content: `# 양자 중첩\n\n**양자 중첩**(superposition)은 양자계가 여러 상태의 선형 결합으로 존재할 수 있는 [[양자역학-입문|양자역학]]의 원리입니다.\n\n## 슈뢰딩거의 고양이\n가장 유명한 사고 실험으로, 고양이가 살아있는 상태와 죽어있는 상태의 중첩에 놓인다는 역설입니다. ~~고양이한테는 미안하지만~~\n\n$$|\\psi\\rangle = \\alpha|살아있음\\rangle + \\beta|죽어있음\\rangle$$\n\n## 측정 문제\n관측하면 중첩이 붕괴하여 하나의 상태만 남습니다. [[하이젠베르크|불확정성 원리]]와도 깊이 연결됩니다.`,
    page_type: "concept",
    source_id: 1
  },
  {
    slug: "양자-얽힘",
    title: "양자 얽힘",
    content: `# 양자 얽힘\n\n**양자 얽힘**(entanglement)은 두 입자가 서로의 상태에 즉각적으로 영향을 주는 [[양자역학-입문|양자역학]] 현상입니다.\n\n## EPR 역설\n아인슈타인, 포돌스키, 로젠이 1935년에 제기한 사고 실험입니다. 아인슈타인은 이를 "으스스한 원격 작용"이라 불렀습니다.\n\n## 벨 부등식\n1964년 존 벨이 증명한 부등식으로, 실험으로 양자역학의 예측이 맞다는 것이 확인되었습니다. (2022년 노벨 물리학상!)\n\n## 응용\n- 양자 컴퓨팅\n- 양자 암호\n- 양자 텔레포테이션`,
    page_type: "concept",
    source_id: 1
  }
];

export const DEMO_QUIZZES = [
  { page_slug: "하이젠베르크", question: "___은 위치와 운동량을 동시에 정확히 측정할 수 없다는 양자역학의 원리이다.", answer: "불확정성 원리", explanation: "하이젠베르크가 1927년에 제안한 이 원리는 양자역학의 근본적 한계를 보여줍니다. 위치를 정확히 측정하면 운동량의 불확정성이 커지고, 그 반대도 마찬가지입니다.", quiz_type: "fill_blank" },
  { page_slug: "슈뢰딩거-방정식", question: "슈뢰딩거 방정식은 1936년에 발표되었다.", answer: "X", explanation: "슈뢰딩거 방정식은 1936년이 아니라 1926년에 에르빈 슈뢰딩거가 발표했습니다.", quiz_type: "ox" },
  { page_slug: "양자-중첩", question: "양자 중첩에서 관측하면 어떤 현상이 일어나는가?", answer: "중첩이 붕괴하여 하나의 상태만 남는다", explanation: "관측 행위가 양자 시스템에 영향을 주어 여러 가능한 상태 중 하나로 '붕괴'됩니다. 이를 파동함수 붕괴라고 합니다.", quiz_type: "short_answer" },
  { page_slug: "양자-얽힘", question: "아인슈타인은 양자 얽힘을 '___한 원격 작용'이라 불렀다.", answer: "으스스", explanation: "아인슈타인은 양자 얽힘이 국소적 실재론에 위배된다고 생각하여 'spooky action at a distance(으스스한 원격 작용)'이라 비판했습니다.", quiz_type: "fill_blank" },
  { page_slug: "양자-중첩", question: "슈뢰딩거의 고양이 사고실험에서 고양이는 살아있는 상태와 죽어있는 상태의 ___에 놓인다.", answer: "중첩", explanation: "이 사고실험은 양자 중첩의 개념을 거시적 세계에 적용하여 양자역학의 해석 문제를 드러내기 위해 고안되었습니다.", quiz_type: "fill_blank" },
  { page_slug: "양자-얽힘", question: "2022년 노벨 물리학상은 양자 얽힘의 벨 부등식 실험 검증과 관련이 있다.", answer: "O", explanation: "알랭 아스페, 존 클라우저, 안톤 차일링거가 벨 부등식 위반을 실험적으로 증명하여 양자 얽힘의 실재성을 확인한 공로로 수상했습니다.", quiz_type: "ox" },
  { page_slug: "슈뢰딩거-방정식", question: "시간 독립 슈뢰딩거 방정식에서 E는 무엇을 나타내는가?", answer: "에너지 고유값", explanation: "시간 독립 슈뢰딩거 방정식 Hψ = Eψ에서 E는 시스템의 에너지 고유값으로, 허용된 에너지 준위를 나타냅니다.", quiz_type: "short_answer" },
  { page_slug: "하이젠베르크", question: "불확정성 원리에서 Δx·Δp ≥ ℏ 이다.", answer: "X", explanation: "정확한 부등식은 Δx·Δp ≥ ℏ/2 입니다. ℏ가 아니라 ℏ/2(플랑크 상수의 절반)가 하한값입니다.", quiz_type: "ox" },
];

export const DEMO_LINKS = [
  // source_slug -> target_slug
  { from: "양자역학-입문", to: "슈뢰딩거-방정식" },
  { from: "양자역학-입문", to: "하이젠베르크" },
  { from: "양자역학-입문", to: "양자-중첩" },
  { from: "양자역학-입문", to: "양자-얽힘" },
  { from: "슈뢰딩거-방정식", to: "하이젠베르크" },
  { from: "하이젠베르크", to: "양자역학-입문" },
  { from: "양자-중첩", to: "양자역학-입문" },
  { from: "양자-중첩", to: "하이젠베르크" },
  { from: "양자-얽힘", to: "양자역학-입문" },
];

export const CS_DEMO_SOURCES = [
  {
    uri: "demo://data-structures",
    type: "demo",
    title: "자료구조와 알고리즘 입문",
    raw_content: "자료구조와 알고리즘의 기초를 소개합니다..."
  }
];

export const CS_DEMO_PAGES = [
  {
    slug: "자료구조-입문",
    title: "자료구조와 알고리즘 입문",
    content: `# 자료구조와 알고리즘 입문\n\n자료구조는 데이터를 효율적으로 저장하고 접근하기 위한 방법입니다.\n\n## 왜 자료구조를 배워야 하는가?\n\n같은 문제라도 어떤 자료구조를 선택하느냐에 따라 시간 복잡도가 $O(n)$에서 $O(\\log n)$으로 바뀔 수 있습니다. ~~코딩 테스트 합격의 비밀이 여기에~~\n\n## 핵심 자료구조\n\n- [[배열과-연결리스트]] — 가장 기본적인 선형 자료구조\n- [[스택과-큐]] — LIFO와 FIFO\n- [[해시테이블]] — $O(1)$ 탐색의 마법\n- [[이진탐색트리]] — 정렬된 데이터의 효율적 관리\n\n## 시간 복잡도\n\n| 자료구조 | 탐색 | 삽입 | 삭제 |\n|----------|------|------|------|\n| 배열 | $O(n)$ | $O(n)$ | $O(n)$ |\n| 해시테이블 | $O(1)$ | $O(1)$ | $O(1)$ |\n| BST | $O(\\log n)$ | $O(\\log n)$ | $O(\\log n)$ |`,
    page_type: "source",
    source_id: 2
  },
  {
    slug: "배열과-연결리스트",
    title: "배열과 연결리스트",
    content: `# 배열과 연결리스트\n\n**배열**(Array)과 **연결리스트**(Linked List)는 가장 기본적인 선형 [[자료구조-입문|자료구조]]입니다.\n\n## 배열\n\n연속된 메모리 공간에 데이터를 저장합니다.\n\n\`\`\`\n인덱스:  [0] [1] [2] [3] [4]\n값:      10  20  30  40  50\n\`\`\`\n\n- 장점: $O(1)$ 랜덤 접근\n- 단점: 삽입/삭제 시 $O(n)$ 이동 필요\n\n## 연결리스트\n\n각 노드가 다음 노드를 가리킵니다. (포인터의 힘!)\n\n- 장점: $O(1)$ 삽입/삭제 (위치를 알 때)\n- 단점: $O(n)$ 탐색 — 인덱스 접근 불가\n\n## 언제 뭘 쓰나?\n\n랜덤 접근이 많으면 배열, 삽입/삭제가 많으면 연결리스트. ~~면접에서 이것만 대답해도 반은 먹고 들어간다~~`,
    page_type: "concept",
    source_id: 2
  },
  {
    slug: "스택과-큐",
    title: "스택과 큐",
    content: `# 스택과 큐\n\n**스택**(Stack)과 **큐**(Queue)는 [[자료구조-입문|자료구조]]의 핵심 추상 자료형입니다.\n\n## 스택 (LIFO)\n\nLast In, First Out. 마지막에 넣은 것이 먼저 나옵니다.\n\n$$push(x) → [1, 2, 3, x]$$\n$$pop() → x$$\n\n활용: 함수 호출 스택, 괄호 매칭, DFS, Undo 기능\n\n## 큐 (FIFO)\n\nFirst In, First Out. 먼저 넣은 것이 먼저 나옵니다.\n\n활용: BFS, 작업 스케줄링, 프린터 큐\n\n## 덱 (Deque)\n\n양쪽에서 삽입/삭제 가능. 스택과 큐의 일반화. (사실 이것만 알면 됩니다)`,
    page_type: "concept",
    source_id: 2
  },
  {
    slug: "해시테이블",
    title: "해시테이블",
    content: `# 해시테이블\n\n**해시테이블**(Hash Table)은 키-값 쌍을 $O(1)$에 저장하고 검색하는 [[자료구조-입문|자료구조]]입니다.\n\n## 해시 함수\n\n$$h(key) = key \\mod m$$\n\n키를 배열 인덱스로 변환합니다. 좋은 해시 함수는 충돌을 최소화합니다.\n\n## 충돌 해결\n\n### 체이닝 (Chaining)\n같은 인덱스에 연결리스트로 저장. [[배열과-연결리스트|연결리스트]] 활용.\n\n### 개방 주소법 (Open Addressing)\n충돌 시 다음 빈 슬롯을 찾음. 선형 탐사, 이차 탐사 등.\n\n## Python의 dict\n\nPython의 딕셔너리가 바로 해시테이블입니다. ~~이미 매일 쓰고 있었다는 사실~~`,
    page_type: "concept",
    source_id: 2
  },
  {
    slug: "이진탐색트리",
    title: "이진탐색트리",
    content: `# 이진탐색트리 (BST)\n\n**이진탐색트리**는 왼쪽 자식 < 부모 < 오른쪽 자식 규칙을 따르는 [[자료구조-입문|자료구조]]입니다.\n\n## 시간 복잡도\n\n| 연산 | 평균 | 최악 |\n|------|------|------|\n| 탐색 | $O(\\log n)$ | $O(n)$ |\n| 삽입 | $O(\\log n)$ | $O(n)$ |\n| 삭제 | $O(\\log n)$ | $O(n)$ |\n\n최악의 경우는 트리가 한쪽으로 치우칠 때 발생합니다. (편향 이진 트리)\n\n## 균형 트리\n\nAVL 트리, Red-Black 트리는 **회전(rotation)** 연산을 통해 자동으로 균형을 유지하여 항상 $O(\\log n)$을 보장합니다. 회전은 부모-자식 관계를 재배치해 트리의 높이를 낮추는 핵심 연산입니다.\n\n## 순회\n\n- 중위 순회 (Inorder): 정렬된 순서로 출력\n- 전위 순회 (Preorder): 트리 복사\n- 후위 순회 (Postorder): 트리 삭제`,
    page_type: "concept",
    source_id: 2
  }
];

export const CS_DEMO_LINKS = [
  { from: "자료구조-입문", to: "배열과-연결리스트" },
  { from: "자료구조-입문", to: "스택과-큐" },
  { from: "자료구조-입문", to: "해시테이블" },
  { from: "자료구조-입문", to: "이진탐색트리" },
  { from: "해시테이블", to: "배열과-연결리스트" },
  { from: "스택과-큐", to: "자료구조-입문" },
  { from: "이진탐색트리", to: "자료구조-입문" },
  { from: "배열과-연결리스트", to: "자료구조-입문" },
];

export const CS_DEMO_QUIZZES = [
  { page_slug: "배열과-연결리스트", question: "배열에서 인덱스를 통한 랜덤 접근의 시간 복잡도는?", answer: "O(1)", quiz_type: "short_answer", explanation: "배열은 연속된 메모리 공간에 저장되므로 인덱스 계산만으로 직접 접근 가능합니다." },
  { page_slug: "해시테이블", question: "해시테이블의 평균 탐색 시간 복잡도는 ___이다.", answer: "O(1)", quiz_type: "fill_blank", explanation: "해시 함수가 키를 배열 인덱스로 직접 변환하므로 상수 시간에 접근 가능합니다." },
  { page_slug: "스택과-큐", question: "스택은 FIFO(First In First Out) 구조이다.", answer: "X", quiz_type: "ox", explanation: "스택은 LIFO(Last In First Out)입니다. FIFO는 큐의 특성입니다." },
  { page_slug: "이진탐색트리", question: "BST에서 중위 순회를 하면 데이터가 정렬된 순서로 출력된다.", answer: "O", quiz_type: "ox", explanation: "BST의 왼쪽 < 부모 < 오른쪽 규칙에 의해 중위 순회는 오름차순 정렬을 보장합니다." },
  { page_slug: "해시테이블", question: "해시 충돌을 해결하는 두 가지 방법은 ___과 개방 주소법이다.", answer: "체이닝", quiz_type: "fill_blank", explanation: "체이닝은 같은 인덱스에 연결리스트로 저장하고, 개방 주소법은 다음 빈 슬롯을 찾습니다." },
  { page_slug: "이진탐색트리", question: "편향 이진 트리에서 탐색의 최악 시간 복잡도는?", answer: "O(n)", quiz_type: "short_answer", explanation: "트리가 한쪽으로 치우치면 사실상 연결리스트와 같아져 선형 탐색이 됩니다." },
];
