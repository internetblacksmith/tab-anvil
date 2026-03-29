const DASHBOARD_PATH = "dashboard.html";

// Open dashboard in a new tab (or focus existing one) on browser action click
browser.action.onClicked.addListener(async () => {
  const dashboardUrl = browser.runtime.getURL(DASHBOARD_PATH);
  const tabs = await browser.tabs.query({ url: dashboardUrl });

  if (tabs.length > 0) {
    // Focus existing dashboard tab
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: dashboardUrl });
  }
});
