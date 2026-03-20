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
  { page_slug: "슈뢰딩거-방정식", question: "슈뢰딩거 방정식은 1926년에 발표되었다.", answer: "O", explanation: "에르빈 슈뢰딩거가 1926년에 발표한 이 방정식은 양자계의 시간 변화를 기술하는 기본 방정식입니다.", quiz_type: "ox" },
  { page_slug: "양자-중첩", question: "양자 중첩에서 관측하면 어떤 현상이 일어나는가?", answer: "중첩이 붕괴하여 하나의 상태만 남는다", explanation: "관측 행위가 양자 시스템에 영향을 주어 여러 가능한 상태 중 하나로 '붕괴'됩니다. 이를 파동함수 붕괴라고 합니다.", quiz_type: "short_answer" },
  { page_slug: "양자-얽힘", question: "아인슈타인은 양자 얽힘을 '___한 원격 작용'이라 불렀다.", answer: "으스스", explanation: "아인슈타인은 양자 얽힘이 국소적 실재론에 위배된다고 생각하여 'spooky action at a distance(으스스한 원격 작용)'이라 비판했습니다.", quiz_type: "fill_blank" },
  { page_slug: "양자-중첩", question: "슈뢰딩거의 고양이 사고실험에서 고양이는 살아있는 상태와 죽어있는 상태의 ___에 놓인다.", answer: "중첩", explanation: "이 사고실험은 양자 중첩의 개념을 거시적 세계에 적용하여 양자역학의 해석 문제를 드러내기 위해 고안되었습니다.", quiz_type: "fill_blank" },
  { page_slug: "양자-얽힘", question: "2022년 노벨 물리학상은 양자 얽힘의 벨 부등식 실험 검증과 관련이 있다.", answer: "O", explanation: "알랭 아스페, 존 클라우저, 안톤 차일링거가 벨 부등식 위반을 실험적으로 증명하여 양자 얽힘의 실재성을 확인한 공로로 수상했습니다.", quiz_type: "ox" },
  { page_slug: "슈뢰딩거-방정식", question: "시간 독립 슈뢰딩거 방정식에서 E는 무엇을 나타내는가?", answer: "에너지 고유값", explanation: "시간 독립 슈뢰딩거 방정식 Hψ = Eψ에서 E는 시스템의 에너지 고유값으로, 허용된 에너지 준위를 나타냅니다.", quiz_type: "short_answer" },
  { page_slug: "하이젠베르크", question: "불확정성 원리에서 Δx·Δp ≥ ℏ/2 이다.", answer: "O", explanation: "이 부등식은 위치의 불확정성(Δx)과 운동량의 불확정성(Δp)의 곱이 플랑크 상수의 절반 이상임을 나타냅니다.", quiz_type: "ox" },
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
