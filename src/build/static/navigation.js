        // Mobile hamburger menu
        (function() {
            const menuBtn = document.querySelector('.topbar-menu-btn');
            const sidebar = document.querySelector('.sidebar');
            const overlay = document.querySelector('.sidebar-overlay');
            if (menuBtn && sidebar) {
                const mobileMenu = window.matchMedia('(max-width: 768px)');
                const setSidebarAvailability = (isOpen) => {
                    const closedOnMobile = mobileMenu.matches && !isOpen;
                    sidebar.inert = closedOnMobile;
                    if (closedOnMobile) sidebar.setAttribute('aria-hidden', 'true');
                    else sidebar.removeAttribute('aria-hidden');
                };
                const focusSidebar = () => {
                    const target = sidebar.querySelector('.sidebar-tab[aria-selected="true"], a[href], button:not([disabled])');
                    if (target instanceof HTMLElement) target.focus();
                };
                menuBtn.addEventListener('click', () => {
                    const isOpen = sidebar.classList.toggle('open');
                    overlay?.classList.toggle('active', isOpen);
                    menuBtn.setAttribute('aria-expanded', String(isOpen));
                    menuBtn.setAttribute('aria-label', isOpen ? '문서 메뉴 닫기' : '문서 메뉴 열기');
                    setSidebarAvailability(isOpen);
                    if (isOpen) {
                        requestAnimationFrame(focusSidebar);
                        sidebar.addEventListener('transitionend', () => {
                            if (sidebar.classList.contains('open')) focusSidebar();
                        }, { once: true });
                    }
                });
                const closeMenu = (restoreFocus = false) => {
                    sidebar.classList.remove('open');
                    overlay?.classList.remove('active');
                    menuBtn.setAttribute('aria-expanded', 'false');
                    menuBtn.setAttribute('aria-label', '문서 메뉴 열기');
                    setSidebarAvailability(false);
                    if (restoreFocus) menuBtn.focus();
                };
                overlay?.addEventListener('click', () => closeMenu(true));
                sidebar.addEventListener('click', (event) => {
                    if (event.target.closest('a') && window.matchMedia('(max-width: 768px)').matches) closeMenu();
                });
                document.addEventListener('keydown', (event) => {
                    if (event.key === 'Escape' && sidebar.classList.contains('open')) closeMenu(true);
                });
                mobileMenu.addEventListener('change', () => closeMenu(false));
                setSidebarAvailability(false);
            }
        })();
        // Sidebar tabs
        const sidebarTabs = Array.from(document.querySelectorAll('.sidebar-tab'));
        function activateSidebarTab(tab, focus = false) {
                sidebarTabs.forEach(t => {
                    const active = t === tab;
                    t.classList.toggle('active', active);
                    t.setAttribute('aria-selected', String(active));
                    t.tabIndex = active ? 0 : -1;
                });
                document.querySelectorAll('.sidebar-panel').forEach(p => {
                    const active = p.id === 'tab-' + tab.dataset.tab;
                    p.classList.toggle('active', active);
                    p.hidden = !active;
                });
                tab.classList.add('active');
                if (focus) tab.focus();
        }
        sidebarTabs.forEach((tab, index) => {
            tab.addEventListener('click', () => activateSidebarTab(tab));
            tab.addEventListener('keydown', (event) => {
                let nextIndex = index;
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % sidebarTabs.length;
                else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + sidebarTabs.length) % sidebarTabs.length;
                else if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') nextIndex = sidebarTabs.length - 1;
                else return;
                event.preventDefault();
                activateSidebarTab(sidebarTabs[nextIndex], true);
            });
        });
