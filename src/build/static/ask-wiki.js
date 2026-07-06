// ask-the-wiki: RAG chat widget. Only active in serve mode when authenticated
// (an authed page carries <meta name="kiwi-auth">). On a static deploy there is
// no server/LLM, so the widget stays hidden.
(function () {
  document.addEventListener("DOMContentLoaded", function () {
    var meta = document.querySelector('meta[name="kiwi-auth"]');
    if (!meta) return; // no auth context → no ask-the-wiki
    var token = meta.getAttribute("content") || "";

    function esc(text) {
      var d = document.createElement("div");
      d.textContent = text == null ? "" : String(text);
      return d.innerHTML;
    }

    // ── DOM ──
    var btn = document.createElement("button");
    btn.className = "askwiki-fab";
    btn.type = "button";
    btn.setAttribute("aria-label", "위키에 질문하기");
    btn.textContent = "🥝 위키에 질문";

    var panel = document.createElement("div");
    panel.className = "askwiki-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "위키 Q&A");
    panel.innerHTML =
      '<div class="askwiki-header">' +
      '<span>🥝 위키에 질문하기</span>' +
      '<button class="askwiki-close" type="button" aria-label="닫기">×</button>' +
      "</div>" +
      '<div class="askwiki-log" id="askwiki-log"></div>' +
      '<form class="askwiki-form" id="askwiki-form">' +
      '<input type="text" id="askwiki-input" placeholder="위키 전체에 대해 물어보세요..." autocomplete="off" maxlength="2000">' +
      '<button type="submit" id="askwiki-send">전송</button>' +
      "</form>";

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    var log = panel.querySelector("#askwiki-log");
    var form = panel.querySelector("#askwiki-form");
    var input = panel.querySelector("#askwiki-input");
    var sendBtn = panel.querySelector("#askwiki-send");

    function open() {
      panel.classList.add("open");
      setTimeout(function () { input.focus(); }, 50);
    }
    function close() { panel.classList.remove("open"); }

    btn.addEventListener("click", function () {
      panel.classList.contains("open") ? close() : open();
    });
    panel.querySelector(".askwiki-close").addEventListener("click", close);

    function appendMsg(role, htmlContent) {
      var div = document.createElement("div");
      div.className = "askwiki-msg askwiki-" + role;
      div.innerHTML = htmlContent;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    }

    // Render answer text with [n] markers turned into anchors, plus a citation list.
    function renderAnswer(result) {
      var answer = esc(result.answer || "");
      answer = answer.replace(/\[(\d+)\]/g, function (m, n) {
        return '<sup class="askwiki-cite" data-n="' + esc(n) + '">[' + esc(n) + "]</sup>";
      });
      var html = '<div class="askwiki-answer">' + answer + "</div>";
      if (result.citations && result.citations.length) {
        html += '<div class="askwiki-sources"><strong>출처</strong><ol>';
        result.citations.forEach(function (c) {
          html +=
            '<li><a href="/wiki/' + encodeURIComponent(c.slug) + '.html">' +
            esc(c.title) + "</a>" +
            (c.snippet ? '<div class="askwiki-snippet">' + esc(c.snippet) + "</div>" : "") +
            "</li>";
        });
        html += "</ol></div>";
      }
      if (result.method === "keyword") {
        html += '<div class="askwiki-note">키워드 검색으로 답변했습니다 (임베딩 미사용).</div>';
      } else if (result.generated === false) {
        html += '<div class="askwiki-note">LLM이 설정되지 않아 관련 문서만 표시합니다.</div>';
      }
      return html;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      appendMsg("user", esc(q));
      input.value = "";
      input.disabled = true;
      sendBtn.disabled = true;
      var thinking = appendMsg("bot", '<span class="askwiki-thinking">생각 중…</span>');

      fetch("/api/ask-wiki", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ question: q }),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) {
            thinking.innerHTML = '<span class="askwiki-error">' + esc(res.d.error || "오류가 발생했습니다") + "</span>";
            return;
          }
          thinking.innerHTML = renderAnswer(res.d);
        })
        .catch(function (err) {
          thinking.innerHTML = '<span class="askwiki-error">' + esc(String(err)) + "</span>";
        })
        .finally(function () {
          input.disabled = false;
          sendBtn.disabled = false;
          input.focus();
          log.scrollTop = log.scrollHeight;
        });
    });
  });
})();
