(() => {
  const tokenInput = document.getElementById("admin-token");
  const notice = document.getElementById("notice");
  const shopsBody = document.getElementById("shops-body");
  const releasesBody = document.getElementById("releases-body");
  const pushButton = document.getElementById("push-button");
  const selectAll = document.getElementById("select-all");
  const configOutput = document.getElementById("shop-config");
  const copyConfigButton = document.getElementById("copy-config");
  const uploadProgressPanel = document.getElementById("release-upload-progress");
  const uploadProgressBar = document.getElementById("release-upload-bar");
  const uploadProgressMessage = document.getElementById("release-upload-message");
  const uploadProgressPercent = document.getElementById("release-upload-percent");
  const uploadProgressSpeed = document.getElementById("release-upload-speed");
  const uploadProgressEta = document.getElementById("release-upload-eta");
  const shopsSearch = document.getElementById("shops-search");
  const releasesSearch = document.getElementById("releases-search");
  let shops = [];
  let releases = [];
  const selectedShops = new Set();
  let selectedReleaseId = null;
  let lastCopyValue = null;

  tokenInput.value = sessionStorage.getItem("adminToken") || "";

  function showNotice(message, isError = false) {
    notice.textContent = message || "";
    notice.className = `notice ${message ? (isError ? "error" : "success") : ""}`;
  }

  async function api(url, options = {}) {
    const token = tokenInput.value.trim();
    if (!token) throw new Error("Enter the dashboard admin API token.");
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(url, { ...options, headers, cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds)) return "--";
    const remaining = Math.max(0, Math.ceil(seconds));
    const minutes = Math.floor(remaining / 60);
    const secondsPart = remaining % 60;
    return minutes ? `${minutes}m ${secondsPart}s` : `${secondsPart}s`;
  }

  function renderUploadProgress(percent, message, speedBytesPerSecond, etaSeconds) {
    const boundedPercent = Math.max(0, Math.min(100, Math.round(percent)));
    uploadProgressPanel.hidden = false;
    uploadProgressBar.value = boundedPercent;
    uploadProgressPercent.textContent = `${boundedPercent}%`;
    uploadProgressMessage.textContent = message;
    uploadProgressSpeed.textContent = speedBytesPerSecond > 0
      ? `Speed: ${(speedBytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`
      : "Speed: --";
    uploadProgressEta.textContent = etaSeconds !== null && etaSeconds !== undefined
      ? `ETA: ${formatEta(etaSeconds)}`
      : "ETA: --";
  }

  function createUploadId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function uploadRelease(formData, uploadId, onProgress) {
    return new Promise((resolve, reject) => {
      const token = tokenInput.value.trim();
      if (!token) {
        reject(new Error("Enter the dashboard admin API token."));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/admin/releases");
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("X-Upload-Id", uploadId);
      xhr.upload.addEventListener("progress", onProgress);
      xhr.addEventListener("load", () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch (_error) {
          data = {};
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          reject(new Error(data.error || `Request failed (${xhr.status}).`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Network error while uploading the release.")));
      xhr.addEventListener("abort", () => reject(new Error("Release upload was cancelled.")));
      xhr.send(formData);
    });
  }

  async function pollUploadProgress(uploadId, signal) {
    while (!signal.aborted) {
      try {
        const response = await fetch(`/api/admin/releases/progress/${encodeURIComponent(uploadId)}`, {
          headers: { Authorization: `Bearer ${tokenInput.value.trim()}` },
          cache: "no-store",
          signal,
        });
        const progress = await response.json();
        if (!response.ok) throw new Error(progress.error || `Progress check failed (${response.status}).`);
        if (progress.phase !== "waiting") {
          renderUploadProgress(
            progress.percent,
            progress.message,
            progress.speedBytesPerSecond,
            progress.etaSeconds,
          );
        }
      } catch (error) {
        if (signal.aborted) return;
        if (error.name !== "AbortError") {
          renderUploadProgress(0, error.message || "Unable to read upload progress.", 0, null);
          return;
        }
      }
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    }
  }

  function selectedShopIds() {
    return [...selectedShops];
  }

  function updatePushButton() {
    pushButton.disabled = selectedShopIds().length === 0 || !selectedReleaseId;
  }

  function updateSelectAllState() {
    const checkboxes = [...document.querySelectorAll(".shop-select")];
    const selectedCount = checkboxes.filter((checkbox) => selectedShops.has(checkbox.value)).length;
    selectAll.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
  }

  async function loadShops() {
    const data = await api("/api/admin/shops");
    document.getElementById("total-count").textContent = data.total;
    document.getElementById("online-count").textContent = data.online;
    document.getElementById("offline-count").textContent = data.offline;
    document.getElementById("online-window").textContent = `${Math.round(data.onlineWindowSeconds / 60)} min`;
    shops = data.shops;
    const shopIds = new Set(shops.map((shop) => shop.shopId));
    for (const shopId of selectedShops) {
      if (!shopIds.has(shopId)) selectedShops.delete(shopId);
    }
    renderShops();
  }

  function renderShops() {
    shopsBody.replaceChildren();
    if (!shops.length) {
      shopsBody.innerHTML = '<tr><td colspan="9" class="empty">No shops registered yet.</td></tr>';
      updateSelectAllState();
      updatePushButton();
      return;
    }
    const query = shopsSearch.value.trim().toLocaleLowerCase();
    const visibleShops = shops.filter((shop) => [
      shop.shopId,
      shop.shopName,
      shop.currentVersion || "",
      shop.online ? "online" : "offline",
    ].some((value) => String(value).toLocaleLowerCase().includes(query)));
    if (!visibleShops.length) {
      shopsBody.innerHTML = '<tr><td colspan="9" class="empty">No shops match this search.</td></tr>';
      updateSelectAllState();
      updatePushButton();
      return;
    }
    for (const shop of visibleShops) {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td><input class="shop-select" type="checkbox" value="${escapeHtml(shop.shopId)}" aria-label="Select ${escapeHtml(shop.shopName)}" ${selectedShops.has(shop.shopId) ? "checked" : ""}></td>
        <td>${escapeHtml(shop.shopId)}</td><td>${escapeHtml(shop.shopName)}</td>
        <td>${escapeHtml(shop.currentVersion || "—")}</td>
        <td><span class="badge ${shop.online ? "online" : "offline"}">${shop.online ? "Online" : "Offline"}</span></td>
        <td>${escapeHtml(formatDate(shop.lastSeen))}</td>
        <td>${escapeHtml(shop.assignedVersion || "—")}</td>
        <td><button class="button secondary rotate-token" data-shop-id="${escapeHtml(shop.shopId)}" type="button">Rotate token</button></td>
        <td class="row-actions">
          <button class="button secondary billing-pass" data-shop-id="${escapeHtml(shop.shopId)}" type="button">Pass / Pause Billing</button>
          <button class="button secondary edit-shop" data-shop-id="${escapeHtml(shop.shopId)}" data-shop-name="${escapeHtml(shop.shopName)}" type="button">Edit</button>
          <button class="button danger delete-shop" data-shop-id="${escapeHtml(shop.shopId)}" type="button">Delete</button>
        </td>`;
      shopsBody.append(row);
    }
    updateSelectAllState();
    updatePushButton();
  }

  async function loadReleases() {
    const data = await api("/api/admin/releases");
    releases = data.releases;
    if (!releases.some((release) => String(release.id) === selectedReleaseId)) {
      selectedReleaseId = null;
    }
    renderReleases();
  }

  function renderReleases() {
    releasesBody.replaceChildren();
    if (!releases.length) {
      releasesBody.innerHTML = '<tr><td colspan="7" class="empty">No releases published yet.</td></tr>';
      updatePushButton();
      return;
    }
    const query = releasesSearch.value.trim().toLocaleLowerCase();
    const visibleReleases = releases.filter((release) => [
      release.version,
      release.tag_name,
      release.notes || "",
    ].some((value) => String(value).toLocaleLowerCase().includes(query)));
    if (!visibleReleases.length) {
      releasesBody.innerHTML = '<tr><td colspan="7" class="empty">No releases match this search.</td></tr>';
      updatePushButton();
      return;
    }
    for (const release of visibleReleases) {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td><input class="release-select" type="radio" name="release" value="${release.id}" aria-label="Select release ${escapeHtml(release.version)}" ${String(release.id) === selectedReleaseId ? "checked" : ""}></td>
        <td>${escapeHtml(release.version)}</td><td>${escapeHtml(release.tag_name)}</td>
        <td><a href="${escapeHtml(release.github_html_url)}" target="_blank" rel="noopener noreferrer">Open</a></td>
        <td>${escapeHtml(formatDate(release.published_at))}</td><td>${release.target_count}</td>
        <td><button class="button danger delete-release" data-release-id="${release.id}" data-release-version="${escapeHtml(release.version)}" type="button">Delete</button></td>`;
      releasesBody.append(row);
    }
    updatePushButton();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function formatDate(value) {
    if (!value) return "Never";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
  }

  async function refresh() {
    sessionStorage.setItem("adminToken", tokenInput.value.trim());
    await Promise.all([loadShops(), loadReleases()]);
  }

  document.getElementById("connect-button").addEventListener("click", async () => {
    try {
      await refresh();
      showNotice("Connected. Shop status refreshes every 30 seconds.");
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  document.getElementById("refresh-button").addEventListener("click", async () => {
    try {
      await refresh();
      showNotice("Dashboard refreshed.");
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  selectAll.addEventListener("change", () => {
    document.querySelectorAll(".shop-select").forEach((checkbox) => {
      checkbox.checked = selectAll.checked;
      if (checkbox.checked) selectedShops.add(checkbox.value);
      else selectedShops.delete(checkbox.value);
    });
    updateSelectAllState();
    updatePushButton();
  });
  shopsSearch.addEventListener("input", renderShops);
  releasesSearch.addEventListener("input", renderReleases);
  shopsBody.addEventListener("change", (event) => {
    const checkbox = event.target instanceof Element ? event.target.closest(".shop-select") : null;
    if (!checkbox) return;
    if (checkbox.checked) selectedShops.add(checkbox.value);
    else selectedShops.delete(checkbox.value);
    updateSelectAllState();
    updatePushButton();
  });
  releasesBody.addEventListener("change", (event) => {
    const radio = event.target instanceof Element ? event.target.closest(".release-select") : null;
    if (!radio) return;
    selectedReleaseId = radio.value;
    updatePushButton();
  });
  document.getElementById("shop-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      const created = await api("/api/admin/shops", { method: "POST", body: JSON.stringify(body) });
      showShopConfig(created.clientConfig);
      event.currentTarget.reset();
      await loadShops();
      showNotice(`${created.shopName} registered. Copy the full client config; it contains the one-time token and offline-pass secret.`);
    } catch (error) {
      showNotice(error.message, true);
    }
  });
  copyConfigButton.addEventListener("click", async () => {
    if (!lastCopyValue) return;
    try {
      await navigator.clipboard.writeText(lastCopyValue);
      showNotice(lastCopyValue.startsWith("{") ? "Shop config copied. Store it securely." : "Offline code copied. Apply it in the shop app.");
    } catch (error) {
      showNotice(`Could not access clipboard: ${error.message}`, true);
    }
  });
  shopsBody.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    const button = target && target.closest("button");
    if (!button) return;
    if (button.classList.contains("edit-shop")) {
      const shopId = button.dataset.shopId;
      const shopName = window.prompt(`Edit the name for ${shopId}:`, button.dataset.shopName);
      if (shopName === null || shopName.trim() === "") return;
      button.disabled = true;
      try {
        await api(`/api/admin/shops/${encodeURIComponent(shopId)}`, {
          method: "PUT",
          body: JSON.stringify({ shopName }),
        });
        await loadShops();
        showNotice(`${shopId} updated.`);
      } catch (error) {
        showNotice(error.message, true);
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (button.classList.contains("delete-shop")) {
      const shopId = button.dataset.shopId;
      if (!window.confirm(`Delete ${shopId}? This also removes its assigned update and revokes its token.`)) return;
      button.disabled = true;
      try {
        await api(`/api/admin/shops/${encodeURIComponent(shopId)}`, { method: "DELETE" });
        selectedShops.delete(shopId);
        await loadShops();
        showNotice(`${shopId} deleted.`);
      } catch (error) {
        showNotice(error.message, true);
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (button.classList.contains("billing-pass")) {
      const shopId = button.dataset.shopId;
      const action = window.prompt(`Enter PAUSE or RESUME for ${shopId}:`, "PAUSE");
      if (action === null) return;
      const normalizedAction = action.trim().toUpperCase();
      if (!["PAUSE", "RESUME"].includes(normalizedAction)) {
        showNotice("Action must be PAUSE or RESUME.", true);
        return;
      }
      let paidUntil = "";
      if (normalizedAction === "PAUSE") {
        const answer = window.prompt("Optional paid-until date (YYYY-MM-DD):", "");
        if (answer === null) return;
        paidUntil = answer.trim();
      }
      button.disabled = true;
      try {
        const result = await api(`/api/admin/shops/${encodeURIComponent(shopId)}/billing-pass`, {
          method: "POST",
          body: JSON.stringify({ action: normalizedAction, paidUntil }),
        });
        showOfflinePassCode(shopId, result.code);
        showNotice(`Offline ${normalizedAction.toLowerCase()} code generated for ${shopId}.`);
      } catch (error) {
        showNotice(error.message, true);
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (!button.classList.contains("rotate-token")) return;
    if (!window.confirm(`Rotate the heartbeat/update token for ${button.dataset.shopId}? The old token stops working immediately.`)) return;
    button.disabled = true;
    try {
      const result = await api(`/api/admin/shops/${encodeURIComponent(button.dataset.shopId)}/rotate-token`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showShopConfig(result.clientConfig);
      showNotice(`${result.warning} Replace the config on that shop before its next heartbeat.`);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  releasesBody.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : event.target.parentElement;
    const button = target && target.closest(".delete-release");
    if (!button) return;
    const releaseId = button.dataset.releaseId;
    const version = button.dataset.releaseVersion;
    if (!window.confirm(`Delete release ${version}? Its shop assignments will be cleared and the GitHub release/tag will also be removed when configured.`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/releases/${encodeURIComponent(releaseId)}`, { method: "DELETE" });
      if (selectedReleaseId === releaseId) selectedReleaseId = null;
      await Promise.all([loadShops(), loadReleases()]);
      showNotice(`Release ${version} deleted.`);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById("release-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const uploadId = createUploadId();
    const progressController = new AbortController();
    let previousLoaded = 0;
    let previousSampleTime = performance.now();
    button.disabled = true;
    renderUploadProgress(0, "Sending installer to dashboard.", 0, null);
    const progressPolling = pollUploadProgress(uploadId, progressController.signal);
    try {
      const data = await uploadRelease(new FormData(event.currentTarget), uploadId, (progressEvent) => {
        if (!progressEvent.lengthComputable) return;
        const currentTime = performance.now();
        const elapsed = (currentTime - previousSampleTime) / 1000;
        const speed = elapsed > 0 ? (progressEvent.loaded - previousLoaded) / elapsed : 0;
        const remainingBytes = progressEvent.total - progressEvent.loaded;
        renderUploadProgress(
          progressEvent.loaded * 100 / progressEvent.total,
          "Sending installer to dashboard.",
          speed,
          speed > 0 ? remainingBytes / speed : null,
        );
        previousLoaded = progressEvent.loaded;
        previousSampleTime = currentTime;
      });
      event.currentTarget.reset();
      await loadReleases();
      selectedReleaseId = String(data.releaseId);
      renderReleases();
      updatePushButton();
      renderUploadProgress(100, "Release published successfully.", 0, 0);
      showNotice(`${data.message} ${data.githubUrl}`);
    } catch (error) {
      uploadProgressMessage.textContent = error.message;
      showNotice(error.message, true);
    } finally {
      progressController.abort();
      await progressPolling;
      button.disabled = false;
    }
  });
  pushButton.addEventListener("click", async () => {
    const releaseId = selectedReleaseId;
    const shopIds = selectedShopIds();
    if (!releaseId || !shopIds.length) return;
    if (!window.confirm(`Assign this update to ${shopIds.length} selected shop(s)?`)) return;
    pushButton.disabled = true;
    try {
      const data = await api("/api/admin/push", {
        method: "POST",
        body: JSON.stringify({ releaseId, shopIds }),
      });
      await Promise.all([loadShops(), loadReleases()]);
      showNotice(`Update assigned to ${data.assigned} selected shop(s). They will receive it on their next heartbeat.`);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      updatePushButton();
    }
  });

  if (tokenInput.value) {
    refresh().then(() => showNotice("Connected. Shop status refreshes every 10 seconds."))
      .catch((error) => showNotice(error.message, true));
  }

  function showShopConfig(config) {
    lastCopyValue = JSON.stringify(config, null, 2);
    configOutput.textContent = lastCopyValue;
    configOutput.hidden = false;
    copyConfigButton.textContent = "Copy config JSON";
    copyConfigButton.hidden = false;
  }

  function showOfflinePassCode(shopId, code) {
    lastCopyValue = code;
    configOutput.textContent = `Shop ID: ${shopId}\nOffline ${code.startsWith("KGS1.") ? "Pass / Unlock" : "Billing"} code:\n${code}`;
    configOutput.hidden = false;
    copyConfigButton.textContent = "Copy offline code";
    copyConfigButton.hidden = false;
  }
  window.setInterval(() => {
    if (!tokenInput.value.trim()) return;
    Promise.all([loadShops(), loadReleases()]).catch((error) => showNotice(error.message, true));
  }, 10000);
})();
