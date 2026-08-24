(function() {
    const STORAGE_SCHEMA = 'v1';
    const LEGACY_KEYS = {
        catalog: 'kiwimu-quiz-catalog',
        schedule: 'kiwimu-srs',
        attempts: 'kiwimu-quiz-attempts',
    };
    // Keep the suffix assembled so GitHub Pages URL rewriting changes script
    // URLs, not this base-path detection rule.
    const scriptSuffix = '/' + 'static/quiz.js';
    const scriptPath = new URL(document.currentScript?.src || scriptSuffix, window.location.href).pathname;
    const storageScope = scriptPath.endsWith(scriptSuffix)
        ? (scriptPath.slice(0, -scriptSuffix.length) || '/')
        : '/';
    const storagePrefix = 'kiwimu-learning:' + STORAGE_SCHEMA + ':' + encodeURIComponent(storageScope) + ':';

    const quizData = document.getElementById("kiwi-quiz-data");
    let ALL_QUIZZES = [];
    try {
        const parsed = JSON.parse(quizData?.textContent || "[]");
        ALL_QUIZZES = Array.isArray(parsed) ? parsed : [];
    } catch { /* treat malformed static data as an empty quiz list */ }
    const QUIZ_COUNT = Math.min(ALL_QUIZZES.length, 10);

    function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}

    function normalize(s) {
        return s.trim().toLowerCase().replace(/\s+/g, ' ');
    }

    let quizzes = [];
    let current = 0;
    let score = 0;
    let answered = false;

    function scopedKey(key) {
        return storagePrefix + key;
    }

    function readStorage(key, fallback) {
        try {
            const value = localStorage.getItem(scopedKey(key));
            if (value) return JSON.parse(value);
            // Only the origin-root site can unambiguously own the legacy keys.
            // Project-site scopes must never import another repository's data.
            const legacyKey = storageScope === '/' ? LEGACY_KEYS[key] : null;
            const legacyValue = legacyKey ? localStorage.getItem(legacyKey) : null;
            if (!legacyValue) return fallback;
            const parsed = JSON.parse(legacyValue);
            localStorage.setItem(scopedKey(key), legacyValue);
            return parsed;
        } catch { return fallback; }
    }

    function writeStorage(key, value) {
        try { localStorage.setItem(scopedKey(key), JSON.stringify(value)); } catch { /* storage may be unavailable */ }
    }

    writeStorage('catalog', ALL_QUIZZES.map(function(q) {
        return { id: q.id, question: q.question, pageTitle: q.page_title || '', pageSlug: q.page_slug || '' };
    }));

    if (ALL_QUIZZES.length === 0) {
        document.getElementById('quiz-empty').hidden = false;
        return;
    }

    function setCardFace(showAnswer) {
        const inner = document.getElementById('quiz-card-inner');
        const front = document.getElementById('quiz-card-front');
        const back = document.getElementById('quiz-card-back');
        inner.classList.toggle('flipped', showAnswer);
        front.setAttribute('aria-hidden', String(showAnswer));
        back.setAttribute('aria-hidden', String(!showAnswer));
        front.inert = showAnswer;
        back.inert = !showAnswer;
    }

    function shuffle(arr) {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function scheduledQuizOrder() {
        const schedule = readStorage('schedule', {});
        const now = Date.now();
        const due = [];
        const fresh = [];
        const later = [];
        ALL_QUIZZES.forEach(function(q) {
            const state = schedule[q.id];
            if (!state || !state.nextReview) {
                fresh.push(q);
                return;
            }
            const nextReview = Date.parse(state.nextReview);
            if (!Number.isFinite(nextReview) || nextReview <= now) due.push(q);
            else later.push(q);
        });
        return [...shuffle(due), ...shuffle(fresh), ...shuffle(later)];
    }

    function startQuiz() {
        quizzes = scheduledQuizOrder().slice(0, QUIZ_COUNT);
        current = 0;
        score = 0;
        answered = false;
        document.getElementById('quiz-active').hidden = false;
        document.getElementById('quiz-done').hidden = true;
        showQuestion();
    }

    function typeLabel(t) {
        return t === 'fill_blank' ? '빈칸 채우기' : t === 'ox' ? 'OX 퀴즈' : '단답형';
    }

    function setInputError(message) {
        const input = document.getElementById('quiz-answer-input');
        const error = document.getElementById('quiz-input-error');
        error.textContent = message;
        error.hidden = !message;
        if (message) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    }

    function showQuestion() {
        const q = quizzes[current];
        answered = false;
        setCardFace(false);

        document.getElementById('quiz-progress-text').textContent = (current + 1) + ' / ' + quizzes.length;
        const progressBar = document.getElementById('quiz-progress-bar');
        progressBar.max = quizzes.length;
        progressBar.value = current + 1;
        progressBar.setAttribute('aria-valuetext', (current + 1) + ' / ' + quizzes.length + ' 문제');
        document.getElementById('quiz-type-badge').textContent = typeLabel(q.quiz_type);
        document.getElementById('quiz-question').innerHTML = esc(q.question);

        const inputArea = document.getElementById('quiz-input-area');
        const oxArea = document.getElementById('quiz-ox-area');
        const answerInput = document.getElementById('quiz-answer-input');
        const submitBtn = document.getElementById('quiz-submit-btn');
        answerInput.disabled = false;
        submitBtn.disabled = false;
        document.querySelectorAll('.ox-btn').forEach(function(btn) { btn.disabled = false; });
        document.getElementById('quiz-result-status').textContent = '';
        document.getElementById('quiz-live-status').textContent = '';
        setInputError('');

        if (q.quiz_type === 'ox') {
            inputArea.hidden = true;
            oxArea.hidden = false;
            setTimeout(() => oxArea.querySelector('button')?.focus(), 100);
        } else {
            inputArea.hidden = false;
            oxArea.hidden = true;
            answerInput.value = '';
            setTimeout(() => answerInput.focus(), 100);
        }
    }

    function checkAnswer(userAnswer) {
        if (answered) return;
        answered = true;
        const q = quizzes[current];
        const isCorrect = normalize(userAnswer) === normalize(q.answer);

        if (isCorrect) score++;

        // SM-2 spaced repetition in localStorage
        var quality = isCorrect ? 4 : 1;
        var srsData = readStorage('schedule', {});
        var srs = srsData[q.id] || { ef: 2.5, interval: 0 };
        if (quality >= 3) {
            if (srs.interval === 0) srs.interval = 1;
            else if (srs.interval === 1) srs.interval = 6;
            else srs.interval = Math.round(srs.interval * srs.ef);
            srs.ef = srs.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
        } else {
            srs.interval = 0;
        }
        if (srs.ef < 1.3) srs.ef = 1.3;
        var nextDate = new Date();
        nextDate.setDate(nextDate.getDate() + srs.interval);
        srs.nextReview = nextDate.toISOString();
        srsData[q.id] = srs;
        writeStorage('schedule', srsData);

        // Record attempt in localStorage
        var attempts = readStorage('attempts', []);
        if (!Array.isArray(attempts)) attempts = [];
        attempts.push({ quizId: q.id, isCorrect: isCorrect, quality: quality, timestamp: new Date().toISOString() });
        writeStorage('attempts', attempts.slice(-1000));

        document.getElementById('quiz-result-icon').textContent = isCorrect ? '🎉' : '😅';
        document.getElementById('quiz-result-status').textContent = isCorrect ? '정답입니다.' : '오답입니다.';
        const answerText = document.getElementById('quiz-answer-text');
        answerText.innerHTML = esc(q.answer);
        answerText.classList.toggle('is-incorrect', !isCorrect);

        // Show next review info
        var reviewInfoEl = document.getElementById('quiz-review-info');
        if (srs.interval === 0) {
            reviewInfoEl.textContent = '🔄 다음 복습: 오늘';
        } else {
            reviewInfoEl.textContent = '📅 다음 복습: ' + srs.interval + '일 후';
        }
        reviewInfoEl.hidden = false;

        // Show explanation if available
        var explanationEl = document.getElementById('quiz-explanation');
        if (q.explanation) {
            document.getElementById('quiz-explanation-text').textContent = '💡 ' + q.explanation;
            explanationEl.hidden = false;
        } else {
            explanationEl.hidden = true;
        }

        const sourceEl = document.getElementById('quiz-source');
        if (q.page_slug) {
            const a = document.createElement('a');
            a.href = '/wiki/' + encodeURIComponent(q.page_slug) + '.html';
            a.textContent = '📖 ' + (q.page_title || q.page_slug) + ' 보기';
            sourceEl.textContent = '출처: ';
            sourceEl.appendChild(a);
        } else {
            sourceEl.textContent = '';
        }

        document.getElementById('quiz-answer-input').disabled = true;
        document.getElementById('quiz-submit-btn').disabled = true;
        document.querySelectorAll('.ox-btn').forEach(function(btn) { btn.disabled = true; });
        setCardFace(true);

        const nextBtn = document.getElementById('quiz-next-btn');
        nextBtn.textContent = current < quizzes.length - 1 ? '다음 문제 →' : '결과 보기 →';
        // Announce after the persistent live region is visible, independent of
        // the decorative card-flip transition.
        requestAnimationFrame(() => {
            document.getElementById('quiz-live-status').textContent = isCorrect
                ? '정답입니다.'
                : '오답입니다. 정답을 확인하세요.';
            nextBtn.focus();
        });
    }

    function nextQuestion() {
        current++;
        if (current >= quizzes.length) {
            showResults();
        } else {
            showQuestion();
        }
    }

    function showResults() {
        document.getElementById('quiz-active').hidden = true;
        document.getElementById('quiz-done').hidden = false;

        const pct = Math.round(score / quizzes.length * 100);
        document.getElementById('quiz-score-text').textContent = score + ' / ' + quizzes.length;
        document.getElementById('quiz-score-bar').value = pct;

        const msgs = pct >= 90 ? '🏆 완벽에 가깝습니다!' : pct >= 70 ? '👏 잘 하셨습니다!' : pct >= 50 ? '📚 조금 더 복습해보세요!' : '💪 다시 도전해보세요!';
        document.getElementById('quiz-score-msg').textContent = msgs;

        // Show cumulative stats from localStorage
        var allAttempts = readStorage('attempts', []);
        if (!Array.isArray(allAttempts)) allAttempts = [];
        if (allAttempts.length > 0) {
            var totalAttempts = allAttempts.length;
            var correctAttempts = allAttempts.filter(function(a) { return a.isCorrect; }).length;
            var overallPct = Math.round(correctAttempts / totalAttempts * 100);

            var statsEl = document.getElementById('quiz-stats');
            statsEl.hidden = false;
            document.getElementById('quiz-stats-summary').textContent = '전체 시도: ' + totalAttempts + '회 | 정답률: ' + overallPct + '%';

            // Find weak concepts (most wrong answers by page)
            var wrongByPage = {};
            allAttempts.forEach(function(a) {
                if (!a.isCorrect) {
                    var q = ALL_QUIZZES.find(function(quiz) { return quiz.id === a.quizId; });
                    if (q && q.page_title) {
                        wrongByPage[q.page_title] = (wrongByPage[q.page_title] || 0) + 1;
                    }
                }
            });
            var weakConcepts = Object.keys(wrongByPage).sort(function(a, b) { return wrongByPage[b] - wrongByPage[a]; }).slice(0, 3);
            if (weakConcepts.length > 0) {
                var weakEl = document.getElementById('quiz-stats-weak');
                weakEl.hidden = false;
                weakEl.textContent = '💪 약한 개념: ' + weakConcepts.join(', ');
            }
        }
        document.getElementById('quiz-done').focus();
    }

    // Event listeners
    document.getElementById('quiz-submit-btn').addEventListener('click', function() {
        const input = document.getElementById('quiz-answer-input');
        const val = input.value;
        if (val.trim()) checkAnswer(val);
        else {
            setInputError('정답을 입력해 주세요.');
            input.focus();
        }
    });

    document.getElementById('quiz-answer-input').addEventListener('keydown', function(e) {
        if (e.key !== 'Enter' || e.isComposing) return;
        if (this.value.trim()) checkAnswer(this.value);
        else setInputError('정답을 입력해 주세요.');
    });
    document.getElementById('quiz-answer-input').addEventListener('input', function() {
        if (this.value.trim()) setInputError('');
    });

    document.querySelectorAll('.ox-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { checkAnswer(this.dataset.answer); });
    });

    document.getElementById('quiz-next-btn').addEventListener('click', nextQuestion);
    document.getElementById('quiz-restart-btn').addEventListener('click', startQuiz);

    startQuiz();
})();
