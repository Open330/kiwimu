    // Authentication remains in the HttpOnly same-origin cookie. Never expose
    // the bearer token to page scripts or third-party resources.
    const authHeaders = {};
    function setAdminStatus(status, text, tone) {
        status.textContent = text;
        status.dataset.tone = tone;
    }
    function taskDelay(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }
    async function readJson(response) {
        return response.json().catch(() => ({}));
    }
    async function waitForTask(taskId, label) {
        if (typeof taskId !== 'string' || !taskId) throw new Error('작업 ID를 받지 못했습니다');
        while (true) {
            const response = await fetch('/kiwimu/api/tasks/' + encodeURIComponent(taskId), { headers: authHeaders });
            const task = await readJson(response);
            if (!response.ok) throw new Error(task.error || '작업 상태를 확인할 수 없습니다');
            if (task.status === 'completed') return task.result;
            if (task.status === 'error') throw new Error(task.error || label + '에 실패했습니다');
            if (task.status !== 'processing') throw new Error('알 수 없는 작업 상태입니다');
            await taskDelay(1000);
        }
    }
    async function runAction(url, label) {
        const status = document.getElementById('action-status');
        const button = document.getElementById('btn-build');
        button.disabled = true;
        setAdminStatus(status, '⏳ ' + label + ' 중...', 'pending');
        try {
            const r = await fetch(url, { method: 'POST', headers: authHeaders });
            const data = await readJson(r);
            if (!r.ok) throw new Error(data.error || '실패');
            await waitForTask(data.task_id, label);
            setAdminStatus(status, '✅ 완료!', 'success');
        } catch (error) {
            setAdminStatus(status, '❌ ' + (error instanceof Error ? error.message : '연결 실패'), 'error');
        } finally {
            button.disabled = false;
        }
    }
    async function saveSettings(form, body, status) {
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        setAdminStatus(status, '⏳ 저장 후 빌드 중...', 'pending');
        try {
            const r = await fetch('/kiwimu/api/settings', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify(body) });
            const data = await readJson(r);
            if (!r.ok) throw new Error(data.error || '저장에 실패했습니다');
            await waitForTask(data.task_id, '저장 후 빌드');
            setAdminStatus(status, '✅ 저장됨', 'success');
            setTimeout(() => location.reload(), 500);
        } catch (error) {
            setAdminStatus(status, '❌ ' + (error instanceof Error ? error.message : '연결 실패'), 'error');
            button.disabled = false;
        }
    }

    document.getElementById('general-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('general-save-status');
        const name = document.getElementById('wiki-name').value.trim();
        if (!name) return;
        await saveSettings(e.currentTarget, { wiki_name: name }, status);
    });

    document.getElementById('llm-provider').addEventListener('change', (e) => {
        document.getElementById('endpoint-row').hidden = e.target.value !== 'azure-openai';
        const models = { gemini: 'gemini-3.1-flash-lite', 'azure-openai': 'gpt-5.4-nano', openai: 'gpt-5.4-nano', anthropic: 'claude-sonnet-4-6' };
        document.getElementById('llm-model').placeholder = models[e.target.value] || '';
    });
    document.getElementById('llm-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const status = document.getElementById('save-status');
        const body = { provider: document.getElementById('llm-provider').value, model: document.getElementById('llm-model').value };
        const key = document.getElementById('llm-key').value;
        if (key) body.api_key = key;
        const ep = document.getElementById('llm-endpoint').value;
        if (ep) body.endpoint = ep;
        await saveSettings(e.currentTarget, body, status);
    });

    async function submitSource(form, request, status, label) {
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        setAdminStatus(status, '⏳ ' + label + ' 중...', 'pending');
        try {
            const response = await fetch(request.url, request.init);
            const data = await readJson(response);
            if (!response.ok) throw new Error(data.error || label + ' 요청에 실패했습니다');
            await waitForTask(data.task_id, label);
            setAdminStatus(status, '✅ ' + label + ' 완료!', 'success');
            form.reset();
        } catch (error) {
            setAdminStatus(status, '❌ ' + (error instanceof Error ? error.message : '연결 실패'), 'error');
        } finally {
            button.disabled = false;
        }
    }

    document.getElementById('url-add-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const source = document.getElementById('source-url').value.trim();
        if (!source) return;
        await submitSource(form, {
            url: '/kiwimu/api/add',
            init: { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify({ source }) },
        }, document.getElementById('url-add-status'), 'URL 추가');
    });

    document.getElementById('file-upload-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const fileInput = document.getElementById('source-file');
        if (!fileInput.files || fileInput.files.length !== 1) return;
        const file = fileInput.files[0];
        const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
        const body = new FormData();
        body.set('file', file);
        await submitSource(form, {
            url: '/kiwimu/api/upload',
            init: { method: 'POST', headers: {...authHeaders, 'X-Kiwimu-File-Extension': extension}, body },
        }, document.getElementById('file-upload-status'), '파일 추가');
    });

    // ── Persona management ──
    let personaData = [];
    try {
        const personaDataElement = document.getElementById("kiwi-personas-data");
        const parsed = JSON.parse(personaDataElement?.textContent || "[]");
        personaData = Array.isArray(parsed) ? parsed : [];
    } catch { /* treat malformed static data as an empty persona list */ }
    const personaModal = document.getElementById('persona-modal');
    let personaModalTrigger = null;

    async function activatePersona(name) {
        const status = document.getElementById('persona-activate-status');
        try {
            const r = await fetch('/kiwimu/api/personas', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify({ action: 'activate', name }) });
            if (r.ok) { setAdminStatus(status, '✅', 'success'); setTimeout(() => location.reload(), 800); }
            else { setAdminStatus(status, '❌', 'error'); }
        } catch { setAdminStatus(status, '❌', 'error'); }
    }

    function showPersonaModal(existing) {
        personaModalTrigger = document.activeElement;
        personaModal.hidden = false;
        if (existing) {
            const p = personaData.find(x => x.name === existing);
            if (!p) return;
            document.getElementById('persona-modal-title').textContent = '페르소나 편집';
            document.getElementById('persona-original-name').value = existing;
            document.getElementById('persona-name').value = p.name;
            document.getElementById('persona-desc').value = p.description;
            document.getElementById('persona-system').value = p.system_prompt;
            document.getElementById('persona-style').value = p.content_style;
        } else {
            document.getElementById('persona-modal-title').textContent = '새 페르소나 추가';
            document.getElementById('persona-original-name').value = '';
            document.getElementById('persona-name').value = '';
            document.getElementById('persona-desc').value = '';
            document.getElementById('persona-system').value = '';
            document.getElementById('persona-style').value = '';
        }
        requestAnimationFrame(() => document.getElementById('persona-name').focus());
    }

    function closePersonaModal() {
        personaModal.hidden = true;
        if (personaModalTrigger && typeof personaModalTrigger.focus === 'function') personaModalTrigger.focus();
        personaModalTrigger = null;
    }

    async function savePersona() {
        const originalName = document.getElementById('persona-original-name').value;
        const persona = {
            name: document.getElementById('persona-name').value.trim(),
            description: document.getElementById('persona-desc').value.trim(),
            system_prompt: document.getElementById('persona-system').value,
            content_style: document.getElementById('persona-style').value,
        };
        if (!persona.name) { alert('이름을 입력해주세요'); return; }
        const body = originalName
            ? { action: 'update', original_name: originalName, persona }
            : { action: 'add', persona };
        try {
            const r = await fetch('/kiwimu/api/personas', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify(body) });
            if (r.ok) { closePersonaModal(); location.reload(); }
            else { const d = await r.json(); alert(d.error || '실패'); }
        } catch { alert('연결 실패'); }
    }

    async function deletePersona(name) {
        if (!confirm(name + ' 페르소나를 삭제하시겠습니까?')) return;
        try {
            const r = await fetch('/kiwimu/api/personas', { method: 'POST', headers: {...authHeaders, 'Content-Type':'application/json'}, body: JSON.stringify({ action: 'delete', name }) });
            if (r.ok) location.reload();
            else { const d = await r.json(); alert(d.error || '실패'); }
        } catch { alert('연결 실패'); }
    }

    document.getElementById('btn-build').addEventListener('click', () => runAction('/kiwimu/api/build', '빌드'));
    document.getElementById('active-persona').addEventListener('change', (event) => activatePersona(event.target.value));
    document.getElementById('persona-add-btn').addEventListener('click', () => showPersonaModal());
    document.getElementById('persona-cancel-btn').addEventListener('click', closePersonaModal);
    document.getElementById('persona-save-btn').addEventListener('click', savePersona);
    document.getElementById('persona-list').addEventListener('click', (event) => {
        const button = event.target.closest('[data-persona-action]');
        if (!button) return;
        const name = button.dataset.name || '';
        if (button.dataset.personaAction === 'edit') showPersonaModal(name);
        else if (button.dataset.personaAction === 'delete') deletePersona(name);
    });
    personaModal.addEventListener('click', (event) => {
        if (event.target === personaModal) closePersonaModal();
    });
    personaModal.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closePersonaModal(); return; }
        if (event.key !== 'Tab') return;
        const nodes = Array.from(personaModal.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
