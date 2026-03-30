// ── TabAnvil Dashboard ────────────────────────────────────
// Full-page tab manager with virtual scrolling, search,
// sort, native grouping, and multi-window support.
// Zero dependencies.

(() => {
  "use strict";

  // ── Constants ─────────────────────────────────────────
  const ROW_HEIGHT = 36;
  const GROUP_HEADER_HEIGHT = 28;
  const BUFFER_ROWS = 20;
  const SEARCH_DEBOUNCE_MS = 50;
  const EVENT_COALESCE_MS = 100;
  const BURST_THRESHOLD = 10; // events within coalesce window = burst

  // Firefox tab group colors
  const GROUP_COLORS = ["blue", "turquoise", "green", "yellow", "orange", "red", "pink", "purple", "grey"];
  const GROUP_COLOR_HEX = {
    blue: "#0060DF", turquoise: "#00C8D7", green: "#30E60B",
    yellow: "#FFD567", orange: "#FF9F43", red: "#FF6B6B",
    pink: "#FF7DE9", purple: "#AF7AE9", grey: "#8F8F9D"
  };

  // ── State ─────────────────────────────────────────────
  let allTabs = [];
  let allGroups = new Map(); // groupId -> { title, color, collapsed }
  let allWindows = new Map(); // windowId -> Window
  let displayRows = []; // { type: "tab"|"group-header", data, height }
  let selectedIds = new Set();
  let focusIndex = -1;
  let lastClickIndex = -1; // for shift-select range
  let searchQuery = "";
  let activeFilter = "all";
  let activeSort = "position";
  let activeGroupFilter = null; // null = all, groupId or "ungrouped"
  let collapsedGroups = new Set();

  // Debounce/coalesce state
  let searchTimer = null;
  let pendingEvents = [];
  let coalesceTimer = null;
  let burstCount = 0;

  // DOM refs
  const $ = (sel) => document.querySelector(sel);
  const searchInput = $("#search-input");
  const tabListEl = $("#tab-list");
  const spacerEl = $("#tab-list-spacer");
  const viewportEl = $("#tab-list-viewport");
  const tabCountEl = $("#tab-count");
  const actionBar = $("#action-bar");
  const actionCountEl = $("#action-count");
  const groupListEl = $("#group-list");

  // ── Tab Data Layer ────────────────────────────────────

  async function loadAllTabs() {
    try {
      const [tabs, windows] = await Promise.all([
        browser.tabs.query({}),
        browser.windows.getAll({ populate: false })
      ]);

      allTabs = tabs.filter(t => t.url !== browser.runtime.getURL("dashboard.html"));
      allWindows = new Map(windows.map(w => [w.id, w]));

      await loadGroups();
      rebuildDisplay();
    } catch (err) {
      console.error("Failed to load tabs:", err);
      showToast("Failed to load tabs", true);
    }
  }

  async function loadGroups() {
    allGroups.clear();
    if (!browser.tabGroups) return;

    try {
      const groups = await browser.tabGroups.query({});
      for (const g of groups) {
        allGroups.set(g.id, { title: g.title || "", color: g.color || "grey", collapsed: g.collapsed || false });
      }
    } catch {
      // tabGroups API unavailable, proceed without native groups
    }
  }

  function getDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  // ── Memoized Derived Views ────────────────────────────

  let _filteredCache = null;
  let _filterCacheKey = "";

  function getFilteredTabs() {
    const key = `${searchQuery}|${activeFilter}|${activeGroupFilter}|${allTabs.length}|${allTabs.map(t => t.id).join(",")}`;
    if (key === _filterCacheKey && _filteredCache) return _filteredCache;

    let tabs = [...allTabs];

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      tabs = tabs.filter(t =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.url || "").toLowerCase().includes(q)
      );
    }

    // Category filter
    if (activeFilter === "grouped") {
      tabs = tabs.filter(t => t.groupId && t.groupId !== -1);
    } else if (activeFilter === "ungrouped") {
      tabs = tabs.filter(t => !t.groupId || t.groupId === -1);
    } else if (activeFilter === "duplicates") {
      const urlCount = new Map();
      for (const t of allTabs) {
        const u = t.url || "";
        urlCount.set(u, (urlCount.get(u) || 0) + 1);
      }
      tabs = tabs.filter(t => urlCount.get(t.url || "") > 1);
    }

    // Group sidebar filter
    if (activeGroupFilter !== null) {
      if (activeGroupFilter === "ungrouped") {
        tabs = tabs.filter(t => !t.groupId || t.groupId === -1);
      } else if (activeGroupFilter === "all") {
        // show all
      } else {
        tabs = tabs.filter(t => t.groupId === activeGroupFilter);
      }
    }

    _filteredCache = tabs;
    _filterCacheKey = key;
    return tabs;
  }

  function getSortedTabs(tabs) {
    const sorted = [...tabs];
    switch (activeSort) {
      case "domain":
        sorted.sort((a, b) => getDomain(a.url).localeCompare(getDomain(b.url)));
        break;
      case "title":
        sorted.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
        break;
      case "lastAccessed":
        sorted.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
        break;
      case "position":
      default:
        sorted.sort((a, b) => {
          if (a.windowId !== b.windowId) return a.windowId - b.windowId;
          return a.index - b.index;
        });
        break;
    }
    return sorted;
  }

  function findDuplicateUrls() {
    const urlCount = new Map();
    for (const t of allTabs) {
      const u = t.url || "";
      urlCount.set(u, (urlCount.get(u) || 0) + 1);
    }
    return urlCount;
  }

  // ── Display Rows Builder ──────────────────────────────

  function rebuildDisplay() {
    const filtered = getFilteredTabs();
    const sorted = getSortedTabs(filtered);
    const rows = [];

    // Group tabs by their groupId (and window)
    if (activeSort === "position" && !searchQuery && activeFilter !== "duplicates") {
      // Show group headers when in position sort with no search
      let currentGroupId = null;
      let currentWindowId = null;

      for (const tab of sorted) {
        // Window header (always shown, even with one window)
        if (tab.windowId !== currentWindowId) {
          currentWindowId = tab.windowId;
          currentGroupId = null;
          const windowIndex = [...allWindows.keys()].indexOf(tab.windowId) + 1;
          const windowTabs = sorted.filter(t => t.windowId === tab.windowId);
          rows.push({
            type: "window-header",
            data: { windowId: tab.windowId, windowIndex, tabCount: windowTabs.length },
            height: GROUP_HEADER_HEIGHT
          });
        }

        // Group header
        const gid = (tab.groupId && tab.groupId !== -1) ? tab.groupId : null;
        if (gid !== currentGroupId) {
          currentGroupId = gid;
          if (gid && allGroups.has(gid)) {
            const group = allGroups.get(gid);
            const groupTabs = sorted.filter(t => t.groupId === gid);
            rows.push({
              type: "group-header",
              data: { groupId: gid, ...group, tabCount: groupTabs.length },
              height: GROUP_HEADER_HEIGHT
            });
          }
        }

        // Skip tabs in collapsed groups
        if (gid && collapsedGroups.has(gid)) continue;

        rows.push({ type: "tab", data: tab, height: ROW_HEIGHT });
      }
    } else {
      // Flat list (sorted/filtered modes)
      for (const tab of sorted) {
        rows.push({ type: "tab", data: tab, height: ROW_HEIGHT });
      }
    }

    displayRows = rows;

    // Update total height
    const totalHeight = displayRows.reduce((sum, r) => sum + r.height, 0);
    spacerEl.style.height = `${totalHeight}px`;

    // Update counters
    const windowCount = new Set(allTabs.map(t => t.windowId)).size;
    tabCountEl.textContent = `${allTabs.length} tabs${windowCount > 1 ? ` \u00B7 ${windowCount} windows` : ""}`;

    // Update search placeholder
    searchInput.placeholder = `Search ${allTabs.length} tabs by title or URL...   /`;

    // Clean stale selections
    const tabIds = new Set(allTabs.map(t => t.id));
    for (const id of selectedIds) {
      if (!tabIds.has(id)) selectedIds.delete(id);
    }

    renderSidebar();
    renderVisibleRows();
    updateActionBar();
  }

  // ── Virtual Scroller ──────────────────────────────────

  function renderVisibleRows() {
    const scrollTop = tabListEl.scrollTop;
    const viewHeight = tabListEl.clientHeight;

    // Find first visible row
    let accHeight = 0;
    let startIdx = 0;
    for (let i = 0; i < displayRows.length; i++) {
      if (accHeight + displayRows[i].height > scrollTop) {
        startIdx = i;
        break;
      }
      accHeight += displayRows[i].height;
    }

    // Buffer above
    const bufferedStart = Math.max(0, startIdx - BUFFER_ROWS);
    let offsetTop = 0;
    for (let i = 0; i < bufferedStart; i++) {
      offsetTop += displayRows[i].height;
    }

    // Find last visible row + buffer below
    let visibleHeight = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < displayRows.length; i++) {
      visibleHeight += displayRows[i].height;
      endIdx = i;
      if (visibleHeight > viewHeight) break;
    }
    const bufferedEnd = Math.min(displayRows.length - 1, endIdx + BUFFER_ROWS);

    // Render
    viewportEl.style.top = `${offsetTop}px`;
    const fragment = document.createDocumentFragment();

    for (let i = bufferedStart; i <= bufferedEnd; i++) {
      const row = displayRows[i];
      if (row.type === "window-header") {
        fragment.appendChild(createWindowHeaderEl(row.data, i));
      } else if (row.type === "group-header") {
        fragment.appendChild(createGroupHeaderEl(row.data, i));
      } else {
        fragment.appendChild(createTabRowEl(row.data, i));
      }
    }

    viewportEl.replaceChildren(fragment);
  }

  function createTabRowEl(tab, rowIndex) {
    const el = document.createElement("div");
    el.className = "tab-row";
    el.dataset.tabId = tab.id;
    el.dataset.rowIndex = rowIndex;

    if (selectedIds.has(tab.id)) el.classList.add("selected");
    if (rowIndex === focusIndex) el.classList.add("focused");
    if (tab.active) el.classList.add("active-tab");

    // Checkbox
    const checkbox = document.createElement("div");
    checkbox.className = `tab-checkbox${selectedIds.has(tab.id) ? " checked" : ""}`;
    el.appendChild(checkbox);

    // Favicon
    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.className = "tab-favicon";
      img.src = tab.favIconUrl;
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => {
        const ph = document.createElement("div");
        ph.className = "tab-favicon-placeholder";
        ph.textContent = getDomain(tab.url).charAt(0).toUpperCase();
        img.replaceWith(ph);
      };
      el.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "tab-favicon-placeholder";
      ph.textContent = getDomain(tab.url).charAt(0).toUpperCase();
      el.appendChild(ph);
    }

    // Title
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url || "Untitled";
    el.appendChild(title);

    // Domain badge
    const domain = document.createElement("span");
    domain.className = "tab-domain";
    domain.textContent = getDomain(tab.url);
    el.appendChild(domain);

    // Window badge (only when not in position sort, since window headers handle it)
    if (allWindows.size > 1 && activeSort !== "position") {
      const wBadge = document.createElement("span");
      wBadge.className = "tab-window-badge";
      wBadge.textContent = `W${[...allWindows.keys()].indexOf(tab.windowId) + 1}`;
      el.appendChild(wBadge);
    }

    // Close button
    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "\u00D7";
    close.title = "Close tab";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });
    el.appendChild(close);

    // Click handler
    el.addEventListener("click", (e) => handleRowClick(tab.id, rowIndex, e));

    // Double-click to activate tab
    el.addEventListener("dblclick", () => activateTab(tab.id, tab.windowId));

    return el;
  }

  function createGroupHeaderEl(group, rowIndex) {
    const el = document.createElement("div");
    el.className = "group-header-row";
    el.dataset.groupId = group.groupId;
    el.dataset.rowIndex = rowIndex;

    const expand = document.createElement("span");
    expand.className = `group-expand${collapsedGroups.has(group.groupId) ? " collapsed" : ""}`;
    expand.textContent = "\u25BC";
    el.appendChild(expand);

    const dot = document.createElement("div");
    dot.className = "group-dot";
    dot.style.background = GROUP_COLOR_HEX[group.color] || GROUP_COLOR_HEX.grey;
    el.appendChild(dot);

    const name = document.createElement("span");
    name.textContent = group.title || "Unnamed Group";
    el.appendChild(name);

    const count = document.createElement("span");
    count.className = "group-header-count";
    count.textContent = `(${group.tabCount} tabs)`;
    el.appendChild(count);

    el.addEventListener("click", () => {
      if (collapsedGroups.has(group.groupId)) {
        collapsedGroups.delete(group.groupId);
      } else {
        collapsedGroups.add(group.groupId);
      }
      rebuildDisplay();
    });

    return el;
  }

  function createWindowHeaderEl(win, rowIndex) {
    const el = document.createElement("div");
    el.className = "window-header-row";
    el.dataset.windowId = win.windowId;
    el.dataset.rowIndex = rowIndex;

    const icon = document.createElement("span");
    icon.className = "window-icon";
    // SVG window icon: title bar with three dots + frame
    icon.innerHTML = '<svg width="14" height="12" viewBox="0 0 14 12" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="0.5" y="0.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1"/>' +
      '<line x1="0.5" y1="3.5" x2="13.5" y2="3.5" stroke="currentColor" stroke-width="1"/>' +
      '<circle cx="3" cy="2" r="0.7" fill="currentColor"/>' +
      '<circle cx="5" cy="2" r="0.7" fill="currentColor"/>' +
      '<circle cx="7" cy="2" r="0.7" fill="currentColor"/>' +
      '</svg>';
    el.appendChild(icon);

    const name = document.createElement("span");
    name.className = "window-label";
    name.textContent = `Window ${win.windowIndex}`;
    el.appendChild(name);

    const count = document.createElement("span");
    count.className = "group-header-count";
    count.textContent = `(${win.tabCount} tabs)`;
    el.appendChild(count);

    return el;
  }

  // ── Sidebar ───────────────────────────────────────────

  function renderSidebar() {
    const fragment = document.createDocumentFragment();

    // "All Tabs" item
    const allItem = createGroupSidebarItem("all", "All Tabs", null, allTabs.length);
    if (activeGroupFilter === null || activeGroupFilter === "all") allItem.classList.add("active");
    fragment.appendChild(allItem);

    // Group items
    for (const [gid, group] of allGroups) {
      const count = allTabs.filter(t => t.groupId === gid).length;
      if (count === 0) continue;
      const item = createGroupSidebarItem(gid, group.title || "Unnamed", GROUP_COLOR_HEX[group.color], count, group.color);
      if (activeGroupFilter === gid) item.classList.add("active");
      fragment.appendChild(item);
    }

    // "Ungrouped" item
    const ungroupedCount = allTabs.filter(t => !t.groupId || t.groupId === -1).length;
    if (ungroupedCount > 0) {
      const item = createGroupSidebarItem("ungrouped", "Ungrouped", GROUP_COLOR_HEX.grey, ungroupedCount);
      if (activeGroupFilter === "ungrouped") item.classList.add("active");
      fragment.appendChild(item);
    }

    groupListEl.replaceChildren(fragment);
  }

  function createGroupSidebarItem(id, label, color, count, colorName) {
    const btn = document.createElement("button");
    btn.className = "group-item";
    btn.dataset.groupFilter = id;

    const dot = document.createElement("div");
    dot.className = "group-dot";
    dot.style.background = color || "#0060DF";
    btn.appendChild(dot);

    const text = document.createElement("span");
    text.className = "group-item-label";
    text.textContent = label;
    btn.appendChild(text);

    // Edit button for real groups (not "all" or "ungrouped")
    if (typeof id === "number") {
      const editBtn = document.createElement("span");
      editBtn.className = "group-edit-btn";
      editBtn.title = "Rename group";
      editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M7.5 1.5L9.5 3.5M1 10L1.5 7.5L8.5 0.5L10.5 2.5L3.5 9.5L1 10Z" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        showEditGroupModal(id, label, colorName || "grey");
      });
      btn.appendChild(editBtn);
    }

    const countEl = document.createElement("span");
    countEl.className = "group-count";
    countEl.textContent = count;
    btn.appendChild(countEl);

    btn.addEventListener("click", () => {
      activeGroupFilter = (id === "all") ? null : id;
      _filteredCache = null;
      rebuildDisplay();
    });

    return btn;
  }

  // ── Tab Actions ───────────────────────────────────────

  async function activateTab(tabId, windowId) {
    try {
      await browser.tabs.update(tabId, { active: true });
      await browser.windows.update(windowId, { focused: true });
    } catch (err) {
      console.error("Failed to switch to tab:", err);
      showToast("Failed to switch to tab", true);
    }
  }

  async function closeTab(tabId) {
    try {
      await browser.tabs.remove(tabId);
    } catch (err) {
      console.error("Failed to close tab:", err);
      showToast("Failed to close tab", true);
    }
  }

  async function closeTabs(tabIds) {
    const ids = [...tabIds];
    try {
      await browser.tabs.remove(ids);
      selectedIds.clear();
      showToast(`Closed ${ids.length} tab${ids.length > 1 ? "s" : ""}`);
    } catch (err) {
      console.error("Failed to close some tabs:", err);
      showToast("Failed to close some tabs", true);
    }
  }

  async function groupSelectedTabs() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    // Check for pinned tabs
    const pinnedTabs = allTabs.filter(t => ids.includes(t.id) && t.pinned);
    if (pinnedTabs.length > 0) {
      const ok = confirm(`${pinnedTabs.length} pinned tab(s) will be unpinned when grouped. Continue?`);
      if (!ok) return;
    }

    showGroupModal(ids);
  }

  async function createGroup(tabIds, title, color) {
    if (!browser.tabs.group) {
      showToast("Tab grouping not supported in this Firefox version", true);
      return;
    }

    try {
      // Move tabs to be adjacent first
      const firstTab = allTabs.find(t => t.id === tabIds[0]);
      if (firstTab) {
        for (let i = 1; i < tabIds.length; i++) {
          await browser.tabs.move(tabIds[i], {
            windowId: firstTab.windowId,
            index: -1
          });
        }
      }

      const groupId = await browser.tabs.group({ tabIds });
      await browser.tabGroups.update(groupId, { title, color });
      selectedIds.clear();
      showToast(`Grouped ${tabIds.length} tabs into "${title}"`);
    } catch (err) {
      console.error("Failed to group tabs:", err);
      showToast("Failed to group tabs", true);
    }
  }

  async function moveTabsToWindow(tabIds, windowId) {
    try {
      if (windowId === "new") {
        const newWin = await browser.windows.create({ tabId: tabIds[0] });
        for (let i = 1; i < tabIds.length; i++) {
          await browser.tabs.move(tabIds[i], { windowId: newWin.id, index: -1 });
        }
        showToast(`Moved ${tabIds.length} tab(s) to new window`);
      } else {
        for (const id of tabIds) {
          await browser.tabs.move(id, { windowId, index: -1 });
        }
        showToast(`Moved ${tabIds.length} tab(s) to window`);
      }
      selectedIds.clear();
    } catch (err) {
      console.error("Failed to move tabs:", err);
      showToast("Failed to move tabs", true);
    }
  }

  // ── Selection ─────────────────────────────────────────

  function handleRowClick(tabId, rowIndex, event) {
    if (event.shiftKey && lastClickIndex >= 0) {
      // Range select
      const start = Math.min(lastClickIndex, rowIndex);
      const end = Math.max(lastClickIndex, rowIndex);
      for (let i = start; i <= end; i++) {
        if (displayRows[i] && displayRows[i].type === "tab") {
          selectedIds.add(displayRows[i].data.id);
        }
      }
    } else if (event.ctrlKey || event.metaKey) {
      // Toggle select
      if (selectedIds.has(tabId)) {
        selectedIds.delete(tabId);
      } else {
        selectedIds.add(tabId);
      }
    } else {
      // Single select / focus
      focusIndex = rowIndex;
    }

    lastClickIndex = rowIndex;
    renderVisibleRows();
    updateActionBar();
  }

  function toggleSelect(rowIndex) {
    const row = displayRows[rowIndex];
    if (!row || row.type !== "tab") return;
    if (selectedIds.has(row.data.id)) {
      selectedIds.delete(row.data.id);
    } else {
      selectedIds.add(row.data.id);
    }
    renderVisibleRows();
    updateActionBar();
  }

  function clearSelection() {
    selectedIds.clear();
    renderVisibleRows();
    updateActionBar();
  }

  function updateActionBar() {
    if (selectedIds.size > 0) {
      actionBar.classList.remove("hidden");
      actionCountEl.textContent = `${selectedIds.size} selected`;
    } else {
      actionBar.classList.add("hidden");
    }
  }

  // ── Search ────────────────────────────────────────────

  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      _filteredCache = null;
      focusIndex = -1;
      rebuildDisplay();
    }, SEARCH_DEBOUNCE_MS);
  }

  // ── Sort ──────────────────────────────────────────────

  function setSort(sortKey) {
    activeSort = sortKey;
    document.querySelectorAll(".sort-option").forEach(el => {
      el.classList.toggle("active", el.dataset.sort === sortKey);
    });
    _filteredCache = null;
    rebuildDisplay();
  }

  // ── Filter Chips ──────────────────────────────────────

  function setFilter(filterKey) {
    activeFilter = filterKey;
    document.querySelectorAll(".chip").forEach(el => {
      el.classList.toggle("active", el.dataset.filter === filterKey);
    });
    _filteredCache = null;
    rebuildDisplay();
  }

  // ── Keyboard Navigation ───────────────────────────────

  function handleKeydown(event) {
    // Don't handle if typing in an input (except search with Esc)
    if (event.target.tagName === "INPUT" && event.key !== "Escape") return;

    switch (event.key) {
      case "/":
        event.preventDefault();
        searchInput.focus();
        break;

      case "j":
        event.preventDefault();
        moveFocus(1);
        break;

      case "k":
        event.preventDefault();
        moveFocus(-1);
        break;

      case "x":
        event.preventDefault();
        if (focusIndex >= 0) toggleSelect(focusIndex);
        break;

      case "d":
        event.preventDefault();
        if (selectedIds.size > 0) {
          closeTabs(selectedIds);
        } else if (focusIndex >= 0 && displayRows[focusIndex]?.type === "tab") {
          closeTab(displayRows[focusIndex].data.id);
        }
        break;

      case "g":
        event.preventDefault();
        if (selectedIds.size > 0) groupSelectedTabs();
        break;

      case "Enter":
        event.preventDefault();
        if (focusIndex >= 0 && displayRows[focusIndex]?.type === "tab") {
          const tab = displayRows[focusIndex].data;
          activateTab(tab.id, tab.windowId);
        }
        break;

      case "Escape":
        if (searchInput === document.activeElement) {
          searchInput.blur();
          searchInput.value = "";
          searchQuery = "";
          _filteredCache = null;
          rebuildDisplay();
        } else if (selectedIds.size > 0) {
          clearSelection();
        }
        break;
    }
  }

  function moveFocus(delta) {
    let newIndex = focusIndex + delta;

    // Skip group headers
    while (newIndex >= 0 && newIndex < displayRows.length && displayRows[newIndex].type !== "tab") {
      newIndex += delta;
    }

    if (newIndex < 0 || newIndex >= displayRows.length) return;
    focusIndex = newIndex;

    // Auto-scroll to keep focused row visible
    let rowTop = 0;
    for (let i = 0; i < focusIndex; i++) {
      rowTop += displayRows[i].height;
    }
    const rowBottom = rowTop + displayRows[focusIndex].height;
    const scrollTop = tabListEl.scrollTop;
    const viewHeight = tabListEl.clientHeight;

    if (rowTop < scrollTop) {
      tabListEl.scrollTop = rowTop;
    } else if (rowBottom > scrollTop + viewHeight) {
      tabListEl.scrollTop = rowBottom - viewHeight;
    }

    renderVisibleRows();
  }

  // ── Live Updates (Tab Event Listeners) ────────────────

  function coalesceEvent(eventType, tabId, changeInfo) {
    pendingEvents.push({ eventType, tabId, changeInfo, ts: Date.now() });
    burstCount++;

    clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => {
      // Burst detection: if we got many events quickly, do a full re-query
      if (burstCount >= BURST_THRESHOLD) {
        burstCount = 0;
        pendingEvents = [];
        loadAllTabs();
        return;
      }

      burstCount = 0;
      processPendingEvents();
    }, EVENT_COALESCE_MS);
  }

  function processPendingEvents() {
    const events = pendingEvents;
    pendingEvents = [];
    let needsRebuild = false;

    for (const evt of events) {
      switch (evt.eventType) {
        case "created":
        case "removed":
        case "moved":
        case "attached":
        case "detached":
          // For structural changes, re-query is simplest
          needsRebuild = true;
          break;
        case "updated": {
          const tab = allTabs.find(t => t.id === evt.tabId);
          if (tab && evt.changeInfo) {
            const ci = evt.changeInfo;
            if (ci.title !== undefined) tab.title = ci.title;
            if (ci.url !== undefined) tab.url = ci.url;
            if (ci.favIconUrl !== undefined) tab.favIconUrl = ci.favIconUrl;
            if (ci.status !== undefined) tab.status = ci.status;
            if (ci.pinned !== undefined) tab.pinned = ci.pinned;
            if (ci.active !== undefined) tab.active = ci.active;
            if (ci.groupId !== undefined) tab.groupId = ci.groupId;
            if (ci.discarded !== undefined) tab.discarded = ci.discarded;
          }
          break;
        }
      }
    }

    if (needsRebuild) {
      loadAllTabs();
    } else {
      _filteredCache = null;
      rebuildDisplay();
    }
  }

  function setupTabListeners() {
    browser.tabs.onCreated.addListener((tab) => {
      coalesceEvent("created", tab.id);
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      coalesceEvent("removed", tabId);
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      coalesceEvent("updated", tabId, changeInfo);
    });

    browser.tabs.onMoved.addListener((tabId) => {
      coalesceEvent("moved", tabId);
    });

    browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
      // Update active state only within the same window
      for (const t of allTabs) {
        if (t.windowId === windowId) t.active = (t.id === tabId);
      }
      renderVisibleRows();
    });

    browser.tabs.onAttached.addListener((tabId) => {
      coalesceEvent("attached", tabId);
    });

    browser.tabs.onDetached.addListener((tabId) => {
      coalesceEvent("detached", tabId);
    });

    // Group events (if API available)
    if (browser.tabGroups) {
      browser.tabGroups.onCreated?.addListener(() => loadAllTabs());
      browser.tabGroups.onRemoved?.addListener(() => loadAllTabs());
      browser.tabGroups.onUpdated?.addListener(() => loadAllTabs());
    }
  }

  // ── Group Modal ───────────────────────────────────────

  function showGroupModal(tabIds) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";

    const h3 = document.createElement("h3");
    h3.textContent = `Group ${tabIds.length} tab${tabIds.length > 1 ? "s" : ""}`;
    modal.appendChild(h3);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Group name...";
    input.autofocus = true;
    modal.appendChild(input);

    // Color picker
    const colors = document.createElement("div");
    colors.className = "modal-colors";
    let selectedColor = "blue";

    for (const color of GROUP_COLORS) {
      const swatch = document.createElement("div");
      swatch.className = `modal-color${color === "blue" ? " selected" : ""}`;
      swatch.style.background = GROUP_COLOR_HEX[color];
      swatch.dataset.color = color;
      swatch.addEventListener("click", () => {
        colors.querySelectorAll(".modal-color").forEach(s => s.classList.remove("selected"));
        swatch.classList.add("selected");
        selectedColor = color;
      });
      colors.appendChild(swatch);
    }
    modal.appendChild(colors);

    // Actions
    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => overlay.remove());
    actions.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.className = "primary";
    confirm.textContent = "Create Group";
    confirm.addEventListener("click", () => {
      const name = input.value.trim() || "Unnamed";
      overlay.remove();
      createGroup(tabIds, name, selectedColor);
    });
    actions.appendChild(confirm);

    modal.appendChild(actions);
    overlay.appendChild(modal);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);

    // Focus input and handle Enter
    requestAnimationFrame(() => input.focus());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirm.click();
      if (e.key === "Escape") overlay.remove();
    });
  }

  // ── Edit Group Modal ───────────────────────────────────

  function showEditGroupModal(groupId, currentTitle, currentColor) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";

    const h3 = document.createElement("h3");
    h3.textContent = "Edit Group";
    modal.appendChild(h3);

    const input = document.createElement("input");
    input.type = "text";
    input.value = currentTitle || "";
    input.placeholder = "Group name...";
    modal.appendChild(input);

    // Color picker
    const colors = document.createElement("div");
    colors.className = "modal-colors";
    let selectedColor = currentColor || "grey";

    for (const color of GROUP_COLORS) {
      const swatch = document.createElement("div");
      swatch.className = `modal-color${color === selectedColor ? " selected" : ""}`;
      swatch.style.background = GROUP_COLOR_HEX[color];
      swatch.dataset.color = color;
      swatch.addEventListener("click", () => {
        colors.querySelectorAll(".modal-color").forEach(s => s.classList.remove("selected"));
        swatch.classList.add("selected");
        selectedColor = color;
      });
      colors.appendChild(swatch);
    }
    modal.appendChild(colors);

    // Actions
    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => overlay.remove());
    actions.appendChild(cancel);

    const save = document.createElement("button");
    save.className = "primary";
    save.textContent = "Save";
    save.addEventListener("click", async () => {
      const newTitle = input.value.trim();
      overlay.remove();
      try {
        await browser.tabGroups.update(groupId, {
          title: newTitle || "",
          color: selectedColor
        });
        await loadAllTabs();
        showToast(`Group renamed to "${newTitle || "Unnamed"}"`);
      } catch (err) {
        console.error("Failed to update group:", err);
        showToast("Failed to update group", true);
      }
    });
    actions.appendChild(save);

    modal.appendChild(actions);
    overlay.appendChild(modal);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
      if (e.key === "Escape") overlay.remove();
    });
  }

  // ── Move to Window Dropdown ───────────────────────────

  function showMoveDropdown() {
    // Remove any existing dropdown
    document.querySelector(".move-dropdown")?.remove();

    const dropdown = document.createElement("div");
    dropdown.className = "move-dropdown";

    // Position near the Move button
    const moveBtn = $("#action-move");
    const rect = moveBtn.getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.bottom = `${window.innerHeight - rect.top + 8}px`;

    // New window option
    const newWinBtn = document.createElement("button");
    newWinBtn.className = "move-dropdown-item new-window";
    newWinBtn.textContent = "+ New Window";
    newWinBtn.addEventListener("click", () => {
      dropdown.remove();
      moveTabsToWindow([...selectedIds], "new");
    });
    dropdown.appendChild(newWinBtn);

    // Existing windows
    let idx = 1;
    for (const [windowId] of allWindows) {
      const windowTabs = allTabs.filter(t => t.windowId === windowId);
      const btn = document.createElement("button");
      btn.className = "move-dropdown-item";
      btn.textContent = `Window ${idx} (${windowTabs.length} tabs)`;
      btn.addEventListener("click", () => {
        dropdown.remove();
        moveTabsToWindow([...selectedIds], windowId);
      });
      dropdown.appendChild(btn);
      idx++;
    }

    document.body.appendChild(dropdown);

    // Close on outside click
    const closeHandler = (e) => {
      if (!dropdown.contains(e.target) && e.target !== moveBtn) {
        dropdown.remove();
        document.removeEventListener("click", closeHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", closeHandler), 0);
  }

  // ── Toast ─────────────────────────────────────────────

  let toastTimer = null;

  function showToast(message, isError = false) {
    let toast = document.querySelector(".toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "toast";
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
  }

  // ── Event Wiring ──────────────────────────────────────

  function setupEventListeners() {
    // Search
    searchInput.addEventListener("input", onSearchInput);

    // Sort buttons
    document.querySelectorAll(".sort-option").forEach(btn => {
      btn.addEventListener("click", () => setSort(btn.dataset.sort));
    });

    // Filter chips
    document.querySelectorAll(".chip").forEach(btn => {
      btn.addEventListener("click", () => setFilter(btn.dataset.filter));
    });

    // Scroll handler for virtual scroller
    tabListEl.addEventListener("scroll", renderVisibleRows);

    // Keyboard
    document.addEventListener("keydown", handleKeydown);

    // Action bar buttons
    $("#action-close").addEventListener("click", () => closeTabs(selectedIds));
    $("#action-group").addEventListener("click", () => groupSelectedTabs());
    $("#action-move").addEventListener("click", () => showMoveDropdown());

    // Resize handler
    window.addEventListener("resize", renderVisibleRows);
  }

  // ── Init ──────────────────────────────────────────────

  async function init() {
    setupEventListeners();
    setupTabListeners();
    await loadAllTabs();
  }

  init();
})();
