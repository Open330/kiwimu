(function() {
    const STORAGE_SCHEMA = 'v1';
    const LEGACY_KEYS = {
        catalog: 'kiwimu-quiz-catalog',
        schedule: 'kiwimu-srs',
        attempts: 'kiwimu-quiz-attempts',
    };
    const scriptSuffix = '/' + 'static/dashboard.js';
    const scriptPath = new URL(document.currentScript?.src || scriptSuffix, window.location.href).pathname;
    const storageScope = scriptPath.endsWith(scriptSuffix)
        ? (scriptPath.slice(0, -scriptSuffix.length) || '/')
        : '/';
    const storagePrefix = 'kiwimu-learning:' + STORAGE_SCHEMA + ':' + encodeURIComponent(storageScope) + ':';

    function scopedKey(key) {
        return storagePrefix + key;
    }

    function readStorage(key, fallback) {
        try {
            const value = localStorage.getItem(scopedKey(key));
            if (value) return JSON.parse(value);
            const legacyKey = storageScope === '/' ? LEGACY_KEYS[key] : null;
            const legacyValue = legacyKey ? localStorage.getItem(legacyKey) : null;
            if (!legacyValue) return fallback;
            const parsed = JSON.parse(legacyValue);
            localStorage.setItem(scopedKey(key), legacyValue);
            return parsed;
        } catch { return fallback; }
    }

    const catalog = readStorage('catalog', []);
    if (!Array.isArray(catalog) || catalog.length === 0) return;
    const schedule = readStorage('schedule', {});
    const attempts = readStorage('attempts', []);
    const catalogById = new Map(catalog.map(q => [String(q.id), q]));
    const now = Date.now();
    let mastered = 0;
    let learning = 0;
    let newCount = 0;
    let due = 0;

    catalog.forEach(q => {
        const state = schedule[q.id];
        if (!state || !state.nextReview) {
            newCount++;
            return;
        }
        const interval = Number(state.interval) || 0;
        if (interval >= 21) mastered++;
        else learning++;
        const nextReview = Date.parse(state.nextReview);
        if (!Number.isFinite(nextReview) || nextReview <= now) due++;
    });

    const total = catalog.length;
    const progress = total > 0 ? Math.round(mastered / total * 100) : 0;
    const values = { total, mastered, learning, new: newCount, due };
    Object.entries(values).forEach(([key, value]) => {
        const element = document.getElementById('dash-' + key);
        if (element) element.textContent = String(value);
    });
    const progressBar = document.getElementById('dash-progress-bar');
    const progressText = document.getElementById('dash-progress-text');
    if (progressBar) {
        progressBar.value = progress;
        progressBar.setAttribute('aria-valuetext', mastered + ' / ' + total + ' 문제 숙달');
    }
    if (progressText) progressText.textContent = mastered + ' / ' + total + ' 문제 숙달 (' + progress + '%)';

    const validAttempts = Array.isArray(attempts)
        ? attempts.filter(attempt => catalogById.has(String(attempt.quizId)))
        : [];
    const recentList = document.getElementById('dash-recent-list');
    if (recentList) {
        recentList.replaceChildren();
        const recent = validAttempts.slice(-20).reverse();
        if (recent.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'dash-empty';
            empty.textContent = '아직 시도한 퀴즈가 없습니다.';
            recentList.appendChild(empty);
        } else {
            recent.forEach(attempt => {
                const quiz = catalogById.get(String(attempt.quizId));
                const item = document.createElement('li');
                item.append(document.createTextNode(attempt.isCorrect ? '✅ ' : '❌ '));
                const question = document.createElement('span');
                question.className = 'dash-q';
                question.textContent = quiz.question.length > 60 ? quiz.question.slice(0, 57) + '...' : quiz.question;
                const date = document.createElement('span');
                date.className = 'dash-date';
                date.textContent = typeof attempt.timestamp === 'string' ? attempt.timestamp.slice(0, 10) : '';
                item.append(question, date);
                recentList.appendChild(item);
            });
        }
    }

    const wrongByPage = new Map();
    validAttempts.forEach(attempt => {
        if (attempt.isCorrect) return;
        const quiz = catalogById.get(String(attempt.quizId));
        if (!quiz?.pageTitle) return;
        const key = quiz.pageSlug || quiz.pageTitle;
        const current = wrongByPage.get(key) || { title: quiz.pageTitle, slug: quiz.pageSlug, count: 0 };
        current.count++;
        wrongByPage.set(key, current);
    });
    const weakList = document.getElementById('dash-weak-list');
    if (weakList) {
        weakList.replaceChildren();
        const weak = [...wrongByPage.values()].sort((a, b) => b.count - a.count).slice(0, 10);
        if (weak.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'dash-empty';
            empty.textContent = '아직 데이터가 없습니다.';
            weakList.appendChild(empty);
        } else {
            weak.forEach(entry => {
                const item = document.createElement('li');
                const label = document.createElement(entry.slug ? 'a' : 'span');
                if (entry.slug) label.href = '/kiwimu/wiki/' + encodeURIComponent(entry.slug) + '.html';
                label.textContent = entry.title;
                const count = document.createElement('span');
                count.className = 'dash-weak-count';
                count.textContent = '오답 ' + entry.count + '회';
                item.append(label, count);
                weakList.appendChild(item);
            });
        }
    }
})();
