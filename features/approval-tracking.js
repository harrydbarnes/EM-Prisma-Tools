(function() {
    'use strict';

    const PENDING_STORAGE_KEY = 'pendingApprovalCampaigns';
    const APPROVED_STORAGE_KEY = 'approvedCampaigns';
    const SETTINGS_KEY_TRACKING = 'approvalTrackingEnabled';
    const SETTINGS_KEY_BANNER = 'approvalBannerIndicatorEnabled';
    const SETTINGS_KEY_TOAST = 'approvalToastNotificationEnabled';
    const BANNER_HOST_SELECTOR = 'mo-banner, mo-banner-user-menu, mo-banner-user-menu-content';

    let trackingEnabled = true;
    let bannerEnabled = true;
    let toastEnabled = true;

    let bannerButton = null;
    let currentPanel = null;
    let currentOutsideClickHandler = null;
    let panelCloseTimer = null;
    let bannerLifecycleObserver = null;
    let bannerObservedRoots = new WeakSet();
    let bannerInjectionQueued = false;
    let bannerLifecycleEventsBound = false;
    const shownToastCampaignIds = new Set();

    function isExtensionContextValid() {
        try {
            return Boolean(chrome && chrome.runtime && chrome.runtime.id);
        } catch (_error) {
            return false;
        }
    }

    async function safeStorageGet(area, defaults) {
        if (!isExtensionContextValid()) return defaults;
        try {
            return await chrome.storage[area].get(defaults);
        } catch (error) {
            if (String(error?.message || error).includes('Extension context invalidated')) {
                stopBannerLifecycle();
                return defaults;
            }
            throw error;
        }
    }

    async function safeStorageSet(area, items) {
        if (!isExtensionContextValid()) return;
        try {
            await chrome.storage[area].set(items);
        } catch (error) {
            if (String(error?.message || error).includes('Extension context invalidated')) {
                stopBannerLifecycle();
                return;
            }
            throw error;
        }
    }

    async function safeSendMessage(message) {
        if (!isExtensionContextValid()) return null;
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (error) {
            if (String(error?.message || error).includes('Extension context invalidated')) {
                stopBannerLifecycle();
                return null;
            }
            throw error;
        }
    }

    function truncateString(str, maxLength) {
        maxLength = maxLength || 28;
        if (!str) return '';
        const trimmed = String(str).trim();
        return trimmed.length > maxLength ? trimmed.slice(0, maxLength - 1) + '…' : trimmed;
    }

    function formatRelativeTime(timestamp) {
        if (!timestamp) return '';
        const diffSeconds = Math.floor((Date.now() - timestamp) / 1000);
        if (diffSeconds < 60) return 'Just now';
        const diffMinutes = Math.floor(diffSeconds / 60);
        if (diffMinutes < 60) return diffMinutes + 'm ago';
        const diffHours = Math.floor(diffMinutes / 60);
        if (diffHours < 24) return diffHours + 'h ago';
        const date = new Date(timestamp);
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function getCampaignIdFromUrl() {
        try {
            const hash = window.location.hash.replace(/^#/, '');
            const params = new URLSearchParams(hash);
            return params.get('campaign-id') || '';
        } catch (_e) {
            return '';
        }
    }

    function getCampaignId() {
        const urlId = getCampaignIdFromUrl();
        if (urlId) return urlId;

        const headerText = document.querySelector('.buy-details-wrapper, .buy-details-background')?.textContent || '';
        const match = headerText.match(/(?:^|\s)(CP[A-Z0-9-]+)(?=\s*\|)/i);
        return match ? match[1].trim() : '';
    }

    function getCampaignName() {
        const el = document.querySelector('.mo-page-header .mo-campaign-name-wrapper') ||
            document.querySelector('.mo-campaign-name-wrapper') ||
            document.querySelector('[id$="-campaign-name"]');
        const text = el?.getAttribute('title') || el?.textContent || '';
        return text.trim();
    }

    // --- Toast Notification utilizing existing toast UI ---
    function showApprovalToast(campaign) {
        if (!toastEnabled || !campaign || !campaign.campaignId) return;
        if (shownToastCampaignIds.has(campaign.campaignId)) return;
        shownToastCampaignIds.add(campaign.campaignId);

        const toastId = 'ops-toolshed-toast';
        let toast = document.getElementById(toastId);

        // Ensure toast styles are injected
        const styleId = 'ops-toolshed-toast-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                #${toastId} {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    padding: 15px;
                    border-radius: 8px;
                    z-index: 2147483647;
                    font-family: sans-serif;
                    font-size: 16px;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.25);
                    opacity: 0;
                    transition: opacity 0.3s ease-in-out;
                    color: white;
                }
                #${toastId}.show { opacity: 1; }
                #${toastId}.toast-offset-native { top: 44px; }
                #${toastId}.toast-info { background-color: #0288D1; }
                #${toastId}.toast-success { background-color: #333668; }
                #${toastId}.toast-error { background-color: #D32F2F; }
            `;
            document.head.appendChild(style);
        }

        if (!toast) {
            toast = document.createElement('div');
            toast.id = toastId;
            document.body.appendChild(toast);
        }

        const displayName = truncateString(campaign.campaignName || campaign.campaignId, 28);
        toast.className = 'toast-success toolshed-approval-toast';
        toast.style.pointerEvents = 'auto';
        toast.style.cursor = 'pointer';
        toast.innerHTML = '';

        const textSpan = document.createElement('span');
        textSpan.textContent = '✓ Campaign "' + displayName + '" Approved';
        toast.appendChild(textSpan);

        if (campaign.url) {
            const actionSpan = document.createElement('span');
            actionSpan.textContent = ' ↗';
            actionSpan.style.marginLeft = '6px';
            actionSpan.style.fontSize = '14px';
            actionSpan.style.opacity = '0.85';
            toast.appendChild(actionSpan);

            toast.onclick = function() {
                window.open(campaign.url, '_blank');
            };
        }

        // Animate in
        setTimeout(function() {
            toast.classList.add('show');
        }, 10);

        // Animate out and cleanup after 6 seconds
        setTimeout(function() {
            if (toast && toast.isConnected) {
                toast.classList.remove('show');
            }
        }, 6000);
    }

    // --- Panel / Dropdown ---
    function closeCurrentPanel(options) {
        const panel = currentPanel;
        if (!panel) return;

        const immediate = Boolean(options && options.immediate);
        if (panel.classList.contains('is-closing') && !immediate) return;
        if (currentOutsideClickHandler) {
            document.removeEventListener('click', currentOutsideClickHandler);
            currentOutsideClickHandler = null;
        }
        if (panelCloseTimer) {
            clearTimeout(panelCloseTimer);
            panelCloseTimer = null;
        }

        const removePanel = function() {
            if (panel.isConnected) panel.remove();
            if (currentPanel === panel) currentPanel = null;
            if (panelCloseTimer) {
                clearTimeout(panelCloseTimer);
                panelCloseTimer = null;
            }
        };

        const reducedMotion = typeof window.matchMedia === 'function' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (immediate || reducedMotion) {
            removePanel();
            return;
        }

        panel.classList.add('is-closing');
        panel.classList.remove('is-open');
        panel.addEventListener('transitionend', function handleCloseTransition(event) {
            if (event.target !== panel || event.propertyName !== 'opacity') return;
            panel.removeEventListener('transitionend', handleCloseTransition);
            removePanel();
        });
        panelCloseTimer = setTimeout(removePanel, 240);
    }

    function positionPanel(panel, anchor) {
        const rect = anchor.getBoundingClientRect();
        panel.style.top = (rect.bottom + 8) + 'px';
        const left = Math.max(16, rect.right - 440);
        panel.style.left = left + 'px';
    }

    const CHECKMARK_SVG = '<svg viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>';
    const CLOCK_SVG = '<svg viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/></svg>';
    const REFRESH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.65 6.35A7.95 7.95 0 0012 4a8 8 0 100 16 8 8 0 007.75-6h-2.1A6 6 0 1112 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>';

    const BANNER_INLINE_STYLES = `
        .toolshed-approval-banner-button {
            background: transparent !important;
            color: rgba(255, 255, 255, 0.9) !important;
            border: none !important;
            border-radius: 4px !important;
            padding: 4px 8px !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
            font-size: 13px !important;
            font-weight: 500 !important;
            cursor: pointer !important;
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            transition: background-color 0.15s ease, color 0.15s ease !important;
            margin-right: 10px !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
            position: relative !important;
            user-select: none !important;
            outline: none !important;
            box-shadow: none !important;
            line-height: 1 !important;
            transform: translateY(-1px) !important;
        }
        .toolshed-approval-banner-button:hover,
        .toolshed-approval-banner-button:focus-visible {
            background-color: rgba(255, 255, 255, 0.09) !important;
            color: #ffffff !important;
        }
        .toolshed-approval-banner-button.is-all-approved:hover {
            background-color: rgba(34, 197, 94, 0.14) !important;
        }
        .toolshed-approval-banner-button.is-all-approved .toolshed-approval-banner-icon {
            color: #22c55e !important;
        }
        .toolshed-approval-banner-button.is-partially-approved:hover {
            background-color: rgba(45, 212, 191, 0.14) !important;
        }
        .toolshed-approval-banner-button.is-partially-approved .toolshed-approval-banner-icon {
            color: #2dd4bf !important;
        }
        .toolshed-approval-banner-button.is-pending-only:hover {
            background-color: rgba(56, 189, 248, 0.14) !important;
        }
        .toolshed-approval-banner-button.is-pending-only .toolshed-approval-banner-icon {
            color: #38bdf8 !important;
        }
        .toolshed-approval-banner-button.is-none-tracked {
            color: rgba(255, 255, 255, 0.75) !important;
        }
        .toolshed-approval-banner-button.is-none-tracked .toolshed-approval-banner-icon {
            color: rgba(255, 255, 255, 0.6) !important;
        }
        .toolshed-approval-banner-button.is-none-tracked:hover,
        .toolshed-approval-banner-button.is-none-tracked:focus-visible {
            background-color: rgba(255, 255, 255, 0.09) !important;
            color: #ffffff !important;
        }
        .toolshed-approval-banner-button.is-none-tracked:hover .toolshed-approval-banner-icon,
        .toolshed-approval-banner-button.is-none-tracked:focus-visible .toolshed-approval-banner-icon {
            color: rgba(255, 255, 255, 0.9) !important;
        }
        .toolshed-approval-banner-button.is-hidden,
        .toolshed-approval-banner-button[hidden] {
            display: none !important;
        }
        .toolshed-approval-banner-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            line-height: 1;
        }
        .toolshed-approval-banner-icon svg {
            width: 15px;
            height: 15px;
            fill: currentColor;
            display: block;
        }
        .toolshed-approval-banner-text {
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
        }
    `;

    async function renderApprovalPanel(anchor, options) {
        const skipEntrance = Boolean(options && options.skipEntrance);
        const reuseCurrent = Boolean(
            options && options.reuseCurrent && currentPanel?.isConnected &&
            !currentPanel.classList.contains('is-closing')
        );
        const existingPanel = reuseCurrent ? currentPanel : null;
        if (!reuseCurrent) closeCurrentPanel({ immediate: true });

        if (!isExtensionContextValid()) return null;

        const panel = document.createElement('div');
        panel.className = 'toolshed-approval-panel' + (skipEntrance ? ' is-open' : '');

        const data = await safeStorageGet('local', {
            [PENDING_STORAGE_KEY]: {},
            [APPROVED_STORAGE_KEY]: []
        });
        const approvedList = data[APPROVED_STORAGE_KEY] || [];
        const pendingMap = data[PENDING_STORAGE_KEY] || {};
        const pendingKeys = Object.keys(pendingMap);
        const approvedCount = approvedList.length;
        const pendingCount = pendingKeys.length;
        const totalCount = approvedCount + pendingCount;

        // Header
        const header = document.createElement('div');
        header.className = 'toolshed-approval-panel-header';

        const titleGroup = document.createElement('div');
        titleGroup.className = 'toolshed-approval-panel-title-group';

        const title = document.createElement('h3');
        title.className = 'toolshed-approval-panel-title';
        title.textContent = 'Campaign Approvals';
        titleGroup.appendChild(title);

        if (totalCount > 0) {
            const badge = document.createElement('span');
            badge.className = 'toolshed-approval-panel-badge';
            badge.textContent = `${approvedCount}/${totalCount} Approved`;
            titleGroup.appendChild(badge);
        }
        header.appendChild(titleGroup);

        const actions = document.createElement('div');
        actions.className = 'toolshed-approval-panel-actions';

        const checkNowBtn = document.createElement('button');
        checkNowBtn.type = 'button';
        checkNowBtn.className = 'toolshed-approval-header-btn';
        checkNowBtn.title = 'Check approval status now';
        checkNowBtn.setAttribute('aria-label', 'Check approval status now');
        checkNowBtn.innerHTML = `${REFRESH_SVG}<span aria-live="polite">Check now</span>`;
        checkNowBtn.addEventListener('click', async function(e) {
            e.stopPropagation();
            const panelBeingChecked = currentPanel;
            const label = checkNowBtn.querySelector('span');
            checkNowBtn.classList.remove('is-error');
            checkNowBtn.classList.add('is-checking');
            checkNowBtn.disabled = true;
            checkNowBtn.setAttribute('aria-busy', 'true');
            checkNowBtn.title = 'Checking approval status';
            if (label) label.textContent = 'Checking…';

            let requestError = null;
            const request = safeSendMessage({ action: 'checkApprovalStatusNow' })
                .catch(function(error) {
                    requestError = error;
                });
            try {
                // Keep the busy state visible long enough to be understood,
                // even when the background responds almost immediately.
                await Promise.all([
                    request,
                    new Promise(function(resolve) { setTimeout(resolve, 650); })
                ]);
                if (requestError) throw requestError;
                await updateBannerIndicator();
                if (
                    currentPanel === panelBeingChecked &&
                    panelBeingChecked?.isConnected &&
                    !panelBeingChecked.classList.contains('is-closing')
                ) {
                    await renderApprovalPanel(anchor, { reuseCurrent: true });
                }
            } catch (error) {
                console.warn('[Approval Tracking] Could not check approval status:', error);
                checkNowBtn.classList.add('is-error');
                checkNowBtn.title = 'Approval check failed. Try again';
                if (label) label.textContent = 'Try again';
            } finally {
                checkNowBtn.classList.remove('is-checking');
                checkNowBtn.disabled = false;
                checkNowBtn.removeAttribute('aria-busy');
            }
        });
        actions.appendChild(checkNowBtn);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'toolshed-approval-header-close';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            closeCurrentPanel();
        });
        actions.appendChild(closeBtn);

        header.appendChild(actions);
        panel.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.className = 'toolshed-approval-panel-body';

        if (totalCount === 0) {
            const empty = document.createElement('div');
            empty.className = 'toolshed-approval-empty-state';
            empty.textContent = 'No campaigns currently being tracked for approval.';
            body.appendChild(empty);
        } else {
            // Approved Section
            if (approvedCount > 0) {
                const approvedSection = document.createElement('div');
                approvedSection.className = 'toolshed-approval-section';

                const secHeader = document.createElement('div');
                secHeader.className = 'toolshed-approval-section-header';

                const secTitle = document.createElement('h4');
                secTitle.className = 'toolshed-approval-section-title';
                secTitle.textContent = `Approved Campaigns (${approvedCount})`;
                secHeader.appendChild(secTitle);

                const clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.className = 'toolshed-approval-clear-all-btn';
                clearBtn.textContent = 'Clear All';
                clearBtn.addEventListener('click', async function(e) {
                    e.stopPropagation();
                    await safeSendMessage({ action: 'clearAllApprovedCampaigns' });
                    await updateBannerIndicator();
                    renderApprovalPanel(anchor);
                });
                secHeader.appendChild(clearBtn);
                approvedSection.appendChild(secHeader);

                const list = document.createElement('ul');
                list.className = 'toolshed-approval-list';

                approvedList.forEach(function(item) {
                    const li = document.createElement('li');
                    li.className = 'toolshed-approval-item';

                    const link = document.createElement('a');
                    link.className = 'toolshed-approval-item-link';
                    if (item.url) link.href = item.url;
                    link.target = '_blank';

                    const nameEl = document.createElement('span');
                    nameEl.className = 'toolshed-approval-item-name';
                    nameEl.textContent = truncateString(item.campaignName || item.campaignId, 36);
                    nameEl.title = item.campaignName || item.campaignId;
                    link.appendChild(nameEl);

                    const meta = document.createElement('div');
                    meta.className = 'toolshed-approval-item-meta';

                    const idSpan = document.createElement('span');
                    idSpan.className = 'toolshed-approval-item-cpid';
                    idSpan.textContent = item.campaignId;
                    meta.appendChild(idSpan);

                    if (item.approvedAt) {
                        const timeSpan = document.createElement('span');
                        timeSpan.className = 'toolshed-approval-item-time';
                        timeSpan.textContent = `Approved ${formatRelativeTime(item.approvedAt)}`;
                        meta.appendChild(timeSpan);
                    }

                    const hintSpan = document.createElement('span');
                    hintSpan.className = 'toolshed-approval-item-link-hint';
                    hintSpan.textContent = '↗';
                    meta.appendChild(hintSpan);

                    link.appendChild(meta);
                    link.addEventListener('click', function() {
                        closeCurrentPanel();
                    });
                    li.appendChild(link);

                    const statusCol = document.createElement('div');
                    statusCol.className = 'toolshed-approval-item-status-col';

                    const statusBadge = document.createElement('span');
                    statusBadge.className = 'toolshed-approval-badge-approved';
                    statusBadge.textContent = '✓ Approved';
                    statusCol.appendChild(statusBadge);

                    const dismissBtn = document.createElement('button');
                    dismissBtn.type = 'button';
                    dismissBtn.className = 'toolshed-approval-item-dismiss';
                    dismissBtn.textContent = '✕';
                    dismissBtn.title = 'Remove from approved list';
                    dismissBtn.addEventListener('click', async function(e) {
                        e.stopPropagation();
                        await safeSendMessage({
                            action: 'dismissApprovedCampaign',
                            campaignId: item.campaignId
                        });
                        await updateBannerIndicator();
                        if (isExtensionContextValid()) {
                            renderApprovalPanel(anchor);
                        }
                    });
                    statusCol.appendChild(dismissBtn);

                    li.appendChild(statusCol);
                    list.appendChild(li);
                });

                approvedSection.appendChild(list);
                body.appendChild(approvedSection);
            }

            // Pending Section
            if (pendingCount > 0) {
                const pendingSection = document.createElement('div');
                pendingSection.className = 'toolshed-approval-section';

                const secHeader = document.createElement('div');
                secHeader.className = 'toolshed-approval-section-header';

                const secTitle = document.createElement('h4');
                secTitle.className = 'toolshed-approval-section-title';
                secTitle.textContent = `Pending Approval (${pendingCount})`;
                secHeader.appendChild(secTitle);
                pendingSection.appendChild(secHeader);

                const list = document.createElement('ul');
                list.className = 'toolshed-approval-list';

                pendingKeys.forEach(function(cId) {
                    const item = pendingMap[cId];
                    const li = document.createElement('li');
                    li.className = 'toolshed-approval-item';

                    const link = document.createElement('a');
                    link.className = 'toolshed-approval-item-link';
                    if (item.url) link.href = item.url;
                    link.target = '_blank';

                    const nameEl = document.createElement('span');
                    nameEl.className = 'toolshed-approval-item-name';
                    nameEl.textContent = truncateString(item.campaignName || item.campaignId, 36);
                    nameEl.title = item.campaignName || item.campaignId;
                    link.appendChild(nameEl);

                    const meta = document.createElement('div');
                    meta.className = 'toolshed-approval-item-meta';

                    const idSpan = document.createElement('span');
                    idSpan.className = 'toolshed-approval-item-cpid';
                    idSpan.textContent = item.campaignId;
                    meta.appendChild(idSpan);

                    const timeSpan = document.createElement('span');
                    timeSpan.className = 'toolshed-approval-item-time';
                    timeSpan.textContent = `Submitted ${formatRelativeTime(item.submittedAt)} • Checking every 5m`;
                    meta.appendChild(timeSpan);

                    link.appendChild(meta);
                    link.addEventListener('click', function() {
                        closeCurrentPanel();
                    });
                    li.appendChild(link);

                    const statusCol = document.createElement('div');
                    statusCol.className = 'toolshed-approval-item-status-col';

                    const statusBadge = document.createElement('span');
                    statusBadge.className = 'toolshed-approval-badge-pending';
                    statusBadge.textContent = '⏳ Submitted';
                    statusCol.appendChild(statusBadge);

                    const dismissBtn = document.createElement('button');
                    dismissBtn.type = 'button';
                    dismissBtn.className = 'toolshed-approval-item-dismiss';
                    dismissBtn.textContent = '✕';
                    dismissBtn.title = 'Stop tracking this campaign';
                    dismissBtn.addEventListener('click', async function(e) {
                        e.stopPropagation();
                        await safeSendMessage({
                            action: 'dismissPendingCampaign',
                            campaignId: item.campaignId
                        });
                        await updateBannerIndicator();
                        if (isExtensionContextValid()) {
                            renderApprovalPanel(anchor);
                        }
                    });
                    statusCol.appendChild(dismissBtn);

                    li.appendChild(statusCol);
                    list.appendChild(li);
                });

                pendingSection.appendChild(list);
                body.appendChild(pendingSection);
            }
        }

        panel.appendChild(body);

        // Footer Quick-Track for Current Campaign
        const currentCampaignId = getCampaignId();
        if (currentCampaignId) {
            const footer = document.createElement('div');
            footer.className = 'toolshed-approval-panel-footer';

            const isAlreadyPending = Boolean(pendingMap[currentCampaignId]);
            const isAlreadyApproved = approvedList.some(function(it) { return it.campaignId === currentCampaignId; });

            if (!isAlreadyPending && !isAlreadyApproved) {
                const trackBtn = document.createElement('button');
                trackBtn.type = 'button';
                trackBtn.className = 'toolshed-approval-track-current-btn';
                trackBtn.textContent = `+ Track current campaign (${currentCampaignId})`;
                trackBtn.addEventListener('click', async function(e) {
                    e.stopPropagation();
                    trackBtn.disabled = true;
                    trackBtn.textContent = 'Adding to tracker...';
                    await safeSendMessage({
                        action: 'trackCampaignApproval',
                        campaign: {
                            campaignId: currentCampaignId,
                            campaignName: getCampaignName() || currentCampaignId,
                            url: window.location.href,
                            submittedAt: Date.now()
                        }
                    });
                    checkLiveWorkflowWidget();
                    await updateBannerIndicator();
                    if (isExtensionContextValid()) {
                        renderApprovalPanel(anchor);
                    }
                });
                footer.appendChild(trackBtn);
            } else {
                const note = document.createElement('div');
                note.className = 'toolshed-approval-already-tracked-note';
                note.textContent = isAlreadyApproved
                    ? `✓ Campaign ${currentCampaignId} is marked Approved`
                    : `✓ Currently tracking campaign ${currentCampaignId}`;
                footer.appendChild(note);
            }
            panel.appendChild(footer);
        }

        if (reuseCurrent) {
            if (
                currentPanel !== existingPanel ||
                !existingPanel.isConnected ||
                existingPanel.classList.contains('is-closing')
            ) {
                return null;
            }
            existingPanel.replaceChildren(...Array.from(panel.childNodes));
            positionPanel(existingPanel, anchor);
            return existingPanel;
        }

        document.body.appendChild(panel);
        positionPanel(panel, anchor);
        currentPanel = panel;

        if (!skipEntrance) {
            const showPanel = function() {
                if (currentPanel === panel) panel.classList.add('is-open');
            };
            // A queued task reliably produces a separate rendered frame in
            // both Prisma and jsdom, so the transition starts from its resting
            // hidden state without depending on requestAnimationFrame timing.
            setTimeout(showPanel, 0);
        }

        const handleOutsideClick = function(e) {
            if (!panel.contains(e.target) && !anchor.contains(e.target)) {
                closeCurrentPanel();
            }
        };
        currentOutsideClickHandler = handleOutsideClick;
        setTimeout(function() {
            if (currentPanel === panel) document.addEventListener('click', handleOutsideClick);
        }, 10);
    }

    // --- Banner Button Indicator ---
    function findBannerButtons() {
        const buttons = [];
        for (const root of getBannerRoots()) {
            if (root.nodeType === 1 && root.matches?.('.toolshed-approval-banner-button')) {
                buttons.push(root);
            }
            root.querySelectorAll?.('.toolshed-approval-banner-button').forEach(btn => {
                buttons.push(btn);
            });
        }
        if (bannerButton && !buttons.includes(bannerButton)) {
            buttons.push(bannerButton);
        }
        return Array.from(new Set(buttons.filter(btn => btn && btn.isConnected)));
    }

    async function updateBannerIndicator() {
        if (!isExtensionContextValid()) {
            stopBannerLifecycle();
            return;
        }
        const buttons = findBannerButtons();
        if (buttons.length === 0) return;
        if (!bannerButton || !bannerButton.isConnected) {
            bannerButton = buttons[0];
        }

        if (!bannerEnabled) {
            buttons.forEach(btn => {
                btn.style.setProperty('display', 'none', 'important');
                btn.hidden = true;
                btn.classList.add('is-hidden');
            });
            return;
        }

        const data = await safeStorageGet('local', {
            [PENDING_STORAGE_KEY]: {},
            [APPROVED_STORAGE_KEY]: []
        });
        if (!isExtensionContextValid()) return;
        const approvedList = data[APPROVED_STORAGE_KEY] || [];
        const pendingMap = data[PENDING_STORAGE_KEY] || {};
        const approvedCount = approvedList.length;
        const pendingCount = Object.keys(pendingMap).length;
        const totalCount = approvedCount + pendingCount;

        const noun = totalCount === 1 ? 'Campaign' : 'Campaigns';
        const summaryText = totalCount === 0
            ? 'Campaign Approvals'
            : `${approvedCount}/${totalCount} ${noun} Approved`;

        buttons.forEach(btn => {
            btn.style.removeProperty('display');
            btn.hidden = false;
            btn.classList.remove('is-hidden', 'is-all-approved', 'is-partially-approved', 'is-pending-only', 'is-none-tracked');

            const iconSpan = btn.querySelector('.toolshed-approval-banner-icon');
            const textSpan = btn.querySelector('.toolshed-approval-banner-text');

            if (textSpan) {
                textSpan.textContent = summaryText;
            }

            if (totalCount === 0) {
                btn.classList.add('is-none-tracked');
                btn.title = 'No campaigns currently being tracked for approval - Click to view';
                if (iconSpan) iconSpan.innerHTML = CLOCK_SVG;
            } else if (approvedCount === totalCount) {
                btn.classList.add('is-all-approved');
                btn.title = `All tracked campaigns approved (${approvedCount}/${totalCount}) - Click to view`;
                if (iconSpan) iconSpan.innerHTML = CHECKMARK_SVG;
            } else if (approvedCount > 0) {
                btn.classList.add('is-partially-approved');
                btn.title = `${approvedCount} of ${totalCount} campaigns approved - Click to view`;
                if (iconSpan) iconSpan.innerHTML = CHECKMARK_SVG;
            } else {
                btn.classList.add('is-pending-only');
                btn.title = `Awaiting approval for ${pendingCount} ${noun.toLowerCase()} - Click to view`;
                if (iconSpan) iconSpan.innerHTML = CLOCK_SVG;
            }
        });
    }

    function getBannerRoots() {
        const roots = [document];
        const discovered = [];
        const visited = new Set();

        while (roots.length) {
            const root = roots.shift();
            if (!root || visited.has(root)) continue;
            visited.add(root);
            discovered.push(root);

            const hosts = [];
            if (root.nodeType === 1 && root.matches?.(BANNER_HOST_SELECTOR)) hosts.push(root);
            root.querySelectorAll?.(BANNER_HOST_SELECTOR).forEach(host => hosts.push(host));
            hosts.forEach(host => {
                if (host.shadowRoot) roots.push(host.shadowRoot);
            });
        }

        return discovered;
    }

    function findBannerUserMenu() {
        for (const root of getBannerRoots()) {
            if (root.nodeType === 1 && root.matches?.('mo-banner-user-menu')) return root;
            const userMenu = root.querySelector?.('mo-banner-user-menu');
            if (userMenu) return userMenu;
        }
        return null;
    }

    function scheduleBannerInjection() {
        if (!isExtensionContextValid()) {
            stopBannerLifecycle();
            return;
        }
        if (bannerInjectionQueued || !bannerEnabled) return;
        bannerInjectionQueued = true;
        const schedule = window.queueMicrotask || (callback => Promise.resolve().then(callback));
        schedule(() => {
            bannerInjectionQueued = false;
            if (!isExtensionContextValid()) {
                stopBannerLifecycle();
                return;
            }
            injectBannerButton();
        });
    }

    function mutationContainsBannerHost(mutation) {
        const targetElement = mutation.target?.nodeType === 1 ? mutation.target : mutation.target?.parentElement;
        if (targetElement?.closest?.('.toolshed-approval-banner-button, #toolshed-approval-banner-styles')) {
            return false;
        }

        const removedNodes = Array.from(mutation.removedNodes || []);
        const removedBannerButton = removedNodes.some(node => node?.nodeType === 1 && (
            node.classList?.contains('toolshed-approval-banner-button') ||
            node.querySelector?.('.toolshed-approval-banner-button')
        ));
        if (removedBannerButton) return true;

        const addedNodes = Array.from(mutation.addedNodes || []);
        const onlyExtensionNodes = addedNodes.length > 0 && addedNodes.every(node => {
            if (node?.nodeType !== 1) return false;
            return node.classList?.contains('toolshed-approval-banner-button') ||
                node.id === 'toolshed-approval-banner-styles';
        });
        if (onlyExtensionNodes && removedNodes.length === 0) return false;

        const mutationRoot = mutation.target?.getRootNode?.();
        if (mutationRoot && mutationRoot !== document && bannerObservedRoots.has(mutationRoot)) {
            return true;
        }

        const nodes = [
            ...addedNodes,
            ...removedNodes
        ];
        return nodes.some(node => node?.nodeType === 1 && (
            node.matches?.(BANNER_HOST_SELECTOR) ||
            node.querySelector?.(BANNER_HOST_SELECTOR)
        ));
    }

    function observeBannerRoots() {
        if (!isExtensionContextValid()) {
            stopBannerLifecycle();
            return;
        }
        const Observer = window.MutationObserver ||
            (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
        const currentDoc = typeof document !== 'undefined' ? document : null;
        if (!Observer || !currentDoc?.body) return;

        if (!bannerLifecycleObserver) {
            bannerLifecycleObserver = new Observer(mutations => {
                if (!isExtensionContextValid()) {
                    stopBannerLifecycle();
                    return;
                }
                if (!mutations.some(mutationContainsBannerHost)) return;
                observeBannerRoots();
                scheduleBannerInjection();
            });
        }

        const roots = [currentDoc.body, ...getBannerRoots().filter(root => root !== currentDoc && root)];
        roots.forEach(root => {
            if (!root || bannerObservedRoots.has(root)) return;
            bannerLifecycleObserver.observe(root, { childList: true, subtree: true });
            bannerObservedRoots.add(root);
        });
    }

    function startBannerLifecycle() {
        if (!isExtensionContextValid() || !bannerEnabled) return;
        observeBannerRoots();
        scheduleBannerInjection();
    }

    function stopBannerLifecycle() {
        bannerLifecycleObserver?.takeRecords?.();
        bannerLifecycleObserver?.disconnect();
        bannerLifecycleObserver = null;
        bannerObservedRoots = new WeakSet();
        bannerInjectionQueued = false;
    }

    function handleBannerVisibilityChange() {
        if (document.visibilityState === 'visible') startBannerLifecycle();
    }

    async function injectBannerButton() {
        if (!bannerEnabled) return;
        const existingButtons = findBannerButtons();
        if (existingButtons.length > 0) {
            bannerButton = existingButtons[0];
            await updateBannerIndicator();
            return;
        }

        try {
            const userMenu = findBannerUserMenu();
            const parent = userMenu ? userMenu.parentElement : null;
            if (!parent) {
                observeBannerRoots();
                return;
            }

            // Inject styles inside Shadow Root / parent container if not already present
            const rootNode = parent.getRootNode ? parent.getRootNode() : null;
            const styleContainer = (rootNode && typeof ShadowRoot !== 'undefined' && rootNode instanceof ShadowRoot)
                ? rootNode
                : (document.head || parent);
            if (styleContainer && !styleContainer.querySelector('#toolshed-approval-banner-styles')) {
                const styleEl = document.createElement('style');
                styleEl.id = 'toolshed-approval-banner-styles';
                styleEl.textContent = BANNER_INLINE_STYLES;
                styleContainer.appendChild(styleEl);
            }

            let existingBtn = parent.querySelector('.toolshed-approval-banner-button');
            if (existingBtn) {
                bannerButton = existingBtn;
                await updateBannerIndicator();
                return;
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'toolshed-approval-banner-button';
            btn.title = 'View campaign approvals';

            const iconSpan = document.createElement('span');
            iconSpan.className = 'toolshed-approval-banner-icon';
            iconSpan.innerHTML = CHECKMARK_SVG;
            btn.appendChild(iconSpan);

            const textSpan = document.createElement('span');
            textSpan.className = 'toolshed-approval-banner-text';
            textSpan.textContent = 'Approvals';
            btn.appendChild(textSpan);

            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (currentPanel) {
                    closeCurrentPanel();
                } else {
                    renderApprovalPanel(btn);
                }
            });

            const swapBtn = parent.querySelector('.switch-account-button');
            if (swapBtn) {
                parent.insertBefore(btn, swapBtn);
            } else {
                parent.insertBefore(btn, userMenu);
            }

            bannerButton = btn;
            await updateBannerIndicator();
        } catch (err) {
            console.warn('[Approval Tracking] Could not inject banner button:', err);
        }
    }

    function detectWorkflowApprovalState(value) {
        const text = String(value || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
        if (/\bNOT SUBMITTED\b/.test(text)) return 'not-submitted';
        if (/\bNOT APPROVED\b/.test(text)) return 'not-approved';
        if (/\bAPPROVED\b/.test(text)) return 'approved';
        if (/\bSUBMITTED\b/.test(text)) return 'submitted';
        return 'unknown';
    }

    // --- Live DOM Inspection for Submitted / Approved States ---
    function checkLiveWorkflowWidget() {
        if (!trackingEnabled || !isExtensionContextValid()) return;

        const campaignId = getCampaignId();
        if (!campaignId) return;

        const workflowWidget = document.querySelector('.workflow-widget-wrapper, mo-side-panel, .mo-side-panel, aside[role="complementary"]');
        if (!workflowWidget) return;

        const approvalState = detectWorkflowApprovalState(workflowWidget.textContent);

        if (approvalState === 'approved') {
            try {
                if (!isExtensionContextValid()) return;
                chrome.storage.local.get({ [PENDING_STORAGE_KEY]: {}, [APPROVED_STORAGE_KEY]: [] }, function(data) {
                    if (!isExtensionContextValid() || !data) return;
                    const pending = data[PENDING_STORAGE_KEY] || {};
                    const approvedList = data[APPROVED_STORAGE_KEY] || [];
                    if (pending[campaignId]) {
                        const pendingRecord = pending[campaignId];
                        delete pending[campaignId];
                        const record = {
                            campaignId: campaignId,
                            campaignName: getCampaignName() || campaignId,
                            url: window.location.href,
                            submittedAt: pendingRecord.submittedAt || Date.now(),
                            approvedAt: Date.now()
                        };
                        const existingIdx = approvedList.findIndex(function(item) { return item.campaignId === campaignId; });
                        if (existingIdx >= 0) approvedList.splice(existingIdx, 1);
                        approvedList.unshift(record);

                        chrome.storage.local.set({
                            [PENDING_STORAGE_KEY]: pending,
                            [APPROVED_STORAGE_KEY]: approvedList
                        }, function() {
                            if (!isExtensionContextValid()) return;
                            showApprovalToast(record);
                            updateBannerIndicator();
                            if (currentPanel && bannerButton) {
                                renderApprovalPanel(bannerButton, { reuseCurrent: true });
                            }
                        });
                    }
                });
            } catch (err) {
                if (String(err?.message || err).includes('Extension context invalidated')) {
                    stopBannerLifecycle();
                }
            }
        } else if (approvalState === 'submitted') {
            // Auto-detect submitted campaign and track if not already tracked
            try {
                if (!isExtensionContextValid()) return;
                chrome.storage.local.get({ [PENDING_STORAGE_KEY]: {}, [APPROVED_STORAGE_KEY]: [] }, function(data) {
                    if (!isExtensionContextValid() || !data) return;
                    const pending = data[PENDING_STORAGE_KEY] || {};
                    const approvedList = data[APPROVED_STORAGE_KEY] || [];
                    const isApproved = approvedList.some(function(item) { return item.campaignId === campaignId; });
                    if (!pending[campaignId] && !isApproved) {
                        pending[campaignId] = {
                            campaignId: campaignId,
                            campaignName: getCampaignName() || campaignId,
                            url: window.location.href,
                            submittedAt: Date.now(),
                            lastChecked: Date.now()
                        };
                        chrome.storage.local.set({ [PENDING_STORAGE_KEY]: pending }, function() {
                            if (!isExtensionContextValid()) return;
                            updateBannerIndicator();
                        });
                    }
                });
            } catch (err) {
                if (String(err?.message || err).includes('Extension context invalidated')) {
                    stopBannerLifecycle();
                }
            }
        } else if (approvalState === 'not-submitted') {
            // Correct any stale false-positive entry created when the previous
            // substring check interpreted "NOT SUBMITTED" as "SUBMITTED".
            try {
                if (!isExtensionContextValid()) return;
                chrome.storage.local.get({ [PENDING_STORAGE_KEY]: {} }, function(data) {
                    if (!isExtensionContextValid() || !data) return;
                    const pending = data[PENDING_STORAGE_KEY] || {};
                    if (!pending[campaignId]) return;
                    delete pending[campaignId];
                    chrome.storage.local.set({ [PENDING_STORAGE_KEY]: pending }, function() {
                        if (!isExtensionContextValid()) return;
                        updateBannerIndicator();
                        if (currentPanel && bannerButton) {
                            renderApprovalPanel(bannerButton, { reuseCurrent: true });
                        }
                    });
                });
            } catch (err) {
                if (String(err?.message || err).includes('Extension context invalidated')) {
                    stopBannerLifecycle();
                }
            }
        }
    }

    function setupSubmissionCapture() {
        document.addEventListener('click', function(event) {
            if (!trackingEnabled || !isExtensionContextValid()) return;
            const target = event.target;
            const trigger = target?.closest?.('button, [role="button"], a, mo-button, [data-action]');
            if (!trigger) return;

            const text = (trigger.textContent || '').trim().toLowerCase();
            const action = (trigger.getAttribute('data-action') || '').toLowerCase();
            const isExplicitlyNotSubmitted = /\bnot\s+submitted\b/i.test(text) || /not[-_\s]?submitted/.test(action);
            const isSubmit = !isExplicitlyNotSubmitted && (
                /\bsubmit\b/i.test(text) ||
                /\b(send|request)\b.*\bapproval\b/i.test(text) ||
                action.includes('submit')
            );

            if (isSubmit) {
                const campaignId = getCampaignId();
                if (campaignId) {
                    const campaignName = getCampaignName() || campaignId;
                    const url = window.location.href;
                    setTimeout(async function() {
                        if (!isExtensionContextValid()) return;
                        await safeSendMessage({
                            action: 'trackCampaignApproval',
                            campaign: {
                                campaignId: campaignId,
                                campaignName: campaignName,
                                url: url,
                                submittedAt: Date.now()
                            }
                        });
                        await updateBannerIndicator();
                    }, 500);
                }
            }
        }, true);
    }

    // --- Message & Storage Listeners ---
    function bindListeners() {
        if (!isExtensionContextValid()) return;
        chrome.runtime.onMessage.addListener(function(request) {
            if (!isExtensionContextValid()) return;
            if (request.action === 'campaignApproved' && request.campaign) {
                showApprovalToast(request.campaign);
                updateBannerIndicator();
                if (currentPanel && bannerButton) {
                    renderApprovalPanel(bannerButton, { reuseCurrent: true });
                }
            }
        });

        chrome.storage.onChanged.addListener(function(changes, area) {
            if (!isExtensionContextValid()) return;
            if (area === 'local' && (changes[APPROVED_STORAGE_KEY] || changes[PENDING_STORAGE_KEY])) {
                updateBannerIndicator();
            }
            if (area === 'sync') {
                if (changes[SETTINGS_KEY_TRACKING]) {
                    trackingEnabled = changes[SETTINGS_KEY_TRACKING].newValue !== false;
                }
                if (changes[SETTINGS_KEY_BANNER]) {
                    bannerEnabled = changes[SETTINGS_KEY_BANNER].newValue !== false;
                    if (bannerEnabled) startBannerLifecycle();
                    else {
                        stopBannerLifecycle();
                        updateBannerIndicator();
                    }
                }
                if (changes[SETTINGS_KEY_TOAST]) {
                    toastEnabled = changes[SETTINGS_KEY_TOAST].newValue !== false;
                }
            }
        });
    }

    let isInitialized = false;
    // --- Init ---
    function initialize() {
        if (isInitialized) {
            startBannerLifecycle();
            return;
        }
        isInitialized = true;

        if (!isExtensionContextValid()) return;
        chrome.storage.sync.get({
            [SETTINGS_KEY_TRACKING]: true,
            [SETTINGS_KEY_BANNER]: true,
            [SETTINGS_KEY_TOAST]: true
        }, function(settings) {
            if (!isExtensionContextValid() || !settings) return;
            trackingEnabled = settings[SETTINGS_KEY_TRACKING] !== false;
            bannerEnabled = settings[SETTINGS_KEY_BANNER] !== false;
            toastEnabled = settings[SETTINGS_KEY_TOAST] !== false;

            bindListeners();
            setupSubmissionCapture();
            if (!bannerLifecycleEventsBound) {
                bannerLifecycleEventsBound = true;
                window.addEventListener('pagehide', stopBannerLifecycle);
                window.addEventListener('pageshow', startBannerLifecycle);
                document.addEventListener('visibilitychange', handleBannerVisibilityChange);
            }
            startBannerLifecycle();

            // Re-check live widget periodically when viewing a campaign
            setInterval(checkLiveWorkflowWidget, 10000);
        });
    }

    // Export feature
    window.approvalTrackingFeature = {
        initialize: initialize,
        injectBannerButton: injectBannerButton,
        updateBannerIndicator: updateBannerIndicator,
        showApprovalToast: showApprovalToast,
        detectWorkflowApprovalState: detectWorkflowApprovalState,
        checkLiveWorkflowWidget: checkLiveWorkflowWidget
    };
})();
