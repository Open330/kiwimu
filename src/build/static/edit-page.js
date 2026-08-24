(function() {
  "use strict";
  if (!document.querySelector('meta[name="kiwi-live"]')) return; // Static build - editing disabled

  const slug = document.querySelector("[data-page-slug]")?.dataset.pageSlug;
  if (!slug) return;

  const editBtn = document.querySelector(".edit-btn");
  const modal = document.getElementById("edit-modal");
  const textarea = document.getElementById("edit-textarea");
  const status = document.getElementById("edit-status");
  const saveBtn = modal?.querySelector(".edit-save");
  if (!editBtn || !modal || !textarea || !saveBtn) return;

  let lastFocused = null;
  editBtn.hidden = false;

  function setStatus(message, kind) {
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind || "";
  }

  function closeModal() {
    if (modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    setStatus("");
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    lastFocused = null;
  }

  editBtn.addEventListener("click", async () => {
    lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.classList.add("modal-open");
    textarea.disabled = true;
    saveBtn.disabled = true;
    setStatus("페이지 내용을 불러오는 중…");
    // Keep focus inside the modal even when the content request is slow.
    modal.querySelector(".edit-modal-close")?.focus();
    try {
      const response = await fetch("/api/page/" + encodeURIComponent(slug), {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("page " + response.status);
      const data = await response.json();
      textarea.value = typeof data.content === "string" ? data.content : "";
      textarea.disabled = false;
      saveBtn.disabled = false;
      setStatus("");
      textarea.focus();
    } catch {
      setStatus("페이지 내용을 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.", "error");
      textarea.disabled = false;
      saveBtn.disabled = false;
      modal.querySelector(".edit-modal-close")?.focus();
    }
  });

  modal.querySelector(".edit-modal-close")?.addEventListener("click", closeModal);
  modal.querySelector(".edit-cancel")?.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });

  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = Array.from(modal.querySelectorAll('button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((node) => !node.hidden);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    textarea.disabled = true;
    setStatus("저장하는 중…");
    try {
      const response = await fetch("/api/page/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ slug, content: textarea.value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "save failed");
      setStatus("저장되었습니다.", "success");
      window.location.reload();
    } catch {
      setStatus("저장에 실패했습니다. 내용을 확인한 뒤 다시 시도해 주세요.", "error");
      textarea.disabled = false;
      saveBtn.disabled = false;
      saveBtn.focus();
    }
  });
})();
