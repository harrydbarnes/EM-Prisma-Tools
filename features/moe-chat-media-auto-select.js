(function() {
    'use strict';

    const SETTING_KEY = 'moeChatMediaAutoSelectEnabled';
    const ACTION_MARKER = 'opsToolshedMoeMediaAutoSelected';
    const MEDIA_ICON_SELECTOR = [
        '#ptb-header mo-icon[name]',
        '.ptb-header mo-icon[name]',
        '.mo-page-header mo-icon[name]'
    ].join(',');
    const CHAT_FRAME_SELECTOR = [
        'iframe[name="Messaging window"]',
        'iframe[title*="messaging" i]',
        'iframe[title*="chat" i]',
        '#webWidget',
        'iframe#webWidget',
        'iframe[name="webWidget"]'
    ].join(',');
    const MEDIA_ICON_LABELS = Object.freeze({
        digital: 'Digital',
        print: 'Print',
        tv: 'TV',
        television: 'TV',
        radio: 'Radio',
        audio: 'Audio',
        ooh: 'OOH',
        outofhome: 'OOH',
        cinema: 'Cinema',
        social: 'Social',
        video: 'Video'
    });
    const PLACEHOLDER_VALUES = new Set([
        '',
        '-',
        'select media',
        'select',
        'select...',
        'choose media',
        'choose'
    ]);

    let initialized = false;
    let enabled = false;
    let parentObserver = null;
    let observedRoots = new Map();
    let openingControls = new WeakSet();
    let pendingActions = new WeakSet();
    let completedControls = new WeakSet();
    let pendingSendRequests = new Map();
    let pendingScanTimers = new Set();
    let attachedFrameListeners = new Map();
    let controlTimings = new WeakMap();
    let lastTimings = null;
    let cachedMediaIcon = null;
    let cachedMediaType = null;

    function normalize(value) {
        return String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function getNow() {
        return window.opsDiagnostics?.now?.() ?? Date.now();
    }

    function getCampaignMediaType() {
        if (typeof document === 'undefined' || !document.querySelectorAll) return null;
        const icons = Array.from(document.querySelectorAll(MEDIA_ICON_SELECTOR));
        for (const icon of icons) {
            const name = normalize(icon.getAttribute('name'));
            if (MEDIA_ICON_LABELS[name]) {
                if (cachedMediaIcon === icon && cachedMediaType === MEDIA_ICON_LABELS[name]) {
                    return cachedMediaType;
                }
                cachedMediaIcon = icon;
                cachedMediaType = MEDIA_ICON_LABELS[name];
                return cachedMediaType;
            }
        }
        cachedMediaIcon = null;
        cachedMediaType = null;
        return null;
    }

    function getText(element) {
        return normalize(element?.textContent || '');
    }

    function getElementById(root, id) {
        if (!root || !id) return null;
        if (typeof root.getElementById === 'function') return root.getElementById(id);
        return Array.from(root.querySelectorAll?.('[id]') || [])
            .find(element => element.id === id) || null;
    }

    function getAssociatedLabel(control, root) {
        const labelledBy = control.getAttribute?.('aria-labelledby');
        if (labelledBy) {
            const labelText = labelledBy
                .split(/\s+/)
                .map(id => getElementById(root, id))
                .filter(Boolean)
                .map(getText)
                .filter(Boolean)
                .join(' ');
            if (labelText) return labelText;
        }

        const ariaLabel = normalize(control.getAttribute?.('aria-label'));
        if (ariaLabel) return ariaLabel;

        const field = control.closest?.(
            '[data-garden-id="containers.field"], [data-garden-id*="field"], label, fieldset, [role="group"]'
        );
        if (!field) return '';

        const visibleLabel = field.querySelector?.('label, [data-garden-id="labels.field"]');
        return getText(visibleLabel || field);
    }

    function isMediaControl(control, root) {
        const label = getAssociatedLabel(control, root);
        if (label === 'media' || label.startsWith('media ')) return true;

        const labelledBy = control.getAttribute?.('aria-labelledby');
        if (labelledBy && normalize(labelledBy).includes('media')) return true;

        const field = control.closest?.('[data-garden-id*="field"], [role="group"], label');
        return Boolean(field && /^media(?:\s|$)/i.test(field.textContent?.trim() || ''));
    }

    function getMediaControls(root) {
        if (!root?.querySelectorAll) return [];
        return Array.from(root.querySelectorAll('select, [role="combobox"]'))
            .filter(control => isMediaControl(control, root));
    }

    function getControlContainer(control) {
        return control.closest?.(
            '[data-garden-id="containers.field"], [data-garden-id="dropdowns.combobox.trigger"], [role="group"], fieldset, label'
        ) || control.parentElement;
    }

    function getControlValue(control) {
        if (control.matches?.('select')) {
            const selected = control.options?.[control.selectedIndex];
            return normalize(selected?.textContent || control.value);
        }

        const directValue = normalize(control.value || control.getAttribute?.('value'));
        if (directValue && !PLACEHOLDER_VALUES.has(directValue)) return directValue;

        const container = getControlContainer(control);
        const valueNode = container?.querySelector?.('[data-garden-id="dropdowns.combobox.value"]');
        return normalize(valueNode?.textContent || directValue);
    }

    function isPlaceholderControl(control) {
        return PLACEHOLDER_VALUES.has(getControlValue(control));
    }

    function optionLabel(option) {
        return normalize(option?.textContent || option?.getAttribute?.('aria-label'));
    }

    function findMatchingOption(root, control, mediaType) {
        const optionSelector = control.matches?.('select')
            ? 'option'
            : '[role="option"], [data-garden-id*="option"]';
        const options = Array.from(root.querySelectorAll?.(optionSelector) || []);
        const wanted = normalize(mediaType);
        return options.find(option => {
            const label = optionLabel(option);
            return label === wanted || label.startsWith(`${wanted} `);
        }) || null;
    }

    function findControlTrigger(control) {
        const controlsId = control.getAttribute?.('aria-controls');
        const triggerSelector = controlsId
            ? Array.from(control.ownerDocument?.querySelectorAll?.('[aria-controls]') || [])
                .find(element => element !== control && element.getAttribute('aria-controls') === controlsId)
            : null;
        return control.closest?.('[data-garden-id="dropdowns.combobox.trigger"], [data-garden-id*="trigger"]') ||
            triggerSelector ||
            control;
    }

    function openControl(control) {
        if (openingControls.has(control)) return;
        openingControls.add(control);
        const trigger = findControlTrigger(control);
        try {
            if (typeof trigger.focus === 'function') trigger.focus();
            trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            trigger?.click?.();
        } catch (_error) {
            // The chat may be replaced while the dropdown is opening.
        }
    }

    function isSendButton(element) {
        if (!element) return false;
        const tag = (element.tagName || '').toLowerCase();
        if (tag !== 'button' && element.getAttribute?.('role') !== 'button' && element.getAttribute?.('type') !== 'submit') {
            return false;
        }
        return [
            element.textContent,
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('title'),
            element.value
        ].some(value => {
            const text = normalize(value);
            return text === 'send' || text === 'send message' || text.startsWith('send ');
        });
    }

    function findSendButton(root) {
        if (!root?.querySelectorAll) return null;
        return Array.from(root.querySelectorAll('button, [role="button"], input[type="submit"]'))
            .find(isSendButton) || null;
    }

    function isDisabled(button) {
        if (!button) return true;
        return Boolean(
            button.disabled ||
            button.hasAttribute?.('disabled') ||
            button.getAttribute?.('aria-disabled') === 'true' ||
            button.classList?.contains?.('is-disabled') ||
            button.getAttribute?.('disabled') === 'disabled'
        );
    }

    function recordAction(outcome, mediaType, timings = {}) {
        const details = { mediaType };
        if (typeof timings.promptInsertedAt === 'number') details.promptInsertedAt = timings.promptInsertedAt;
        if (typeof timings.optionListInsertedAt === 'number') details.optionListInsertedAt = timings.optionListInsertedAt;
        if (typeof timings.optionSelectedAt === 'number') details.optionSelectedAt = timings.optionSelectedAt;
        if (typeof timings.sendClickedAt === 'number') details.sendClickedAt = timings.sendClickedAt;
        if (typeof timings.promptToOptionMs === 'number') details.promptToOptionMs = timings.promptToOptionMs;
        if (typeof timings.optionToSendMs === 'number') details.optionToSendMs = timings.optionToSendMs;
        if (typeof timings.totalDurationMs === 'number') details.totalDurationMs = timings.totalDurationMs;

        const event = {
            source: 'moe-chat-media',
            operation: 'auto-select-media',
            outcome,
            trigger: 'mutation',
            details
        };
        if (typeof timings.totalDurationMs === 'number') event.durationMs = timings.totalDurationMs;
        window.opsDiagnostics?.record?.(event);
    }

    function getOrCreateTimings(control) {
        let timings = controlTimings.get(control);
        if (!timings) {
            timings = {
                promptInsertedAt: getNow(),
                optionListInsertedAt: null,
                optionSelectedAt: null,
                sendClickedAt: null
            };
            controlTimings.set(control, timings);
        }
        return timings;
    }

    function trySend(request) {
        if (!enabled || !request.control.isConnected) {
            pendingSendRequests.delete(request.control);
            pendingActions.delete(request.control);
            return false;
        }

        if (completedControls.has(request.control) || request.control.dataset?.[ACTION_MARKER] === 'true') {
            pendingSendRequests.delete(request.control);
            pendingActions.delete(request.control);
            return false;
        }

        const sendButton = findSendButton(request.root);
        if (sendButton && !isDisabled(sendButton)) {
            completedControls.add(request.control);
            request.control.dataset[ACTION_MARKER] = 'true';
            pendingSendRequests.delete(request.control);
            pendingActions.delete(request.control);

            request.timings.sendClickedAt = getNow();
            if (request.timings.optionSelectedAt) {
                request.timings.optionToSendMs = Math.max(0, Math.round(request.timings.sendClickedAt - request.timings.optionSelectedAt));
            }
            if (request.timings.promptInsertedAt) {
                request.timings.totalDurationMs = Math.max(0, Math.round(request.timings.sendClickedAt - request.timings.promptInsertedAt));
            }
            lastTimings = { ...request.timings };

            sendButton.click();
            recordAction('success', request.mediaType, request.timings);
            return true;
        }
        return false;
    }

    function scheduleSendAttempt(request) {
        const timer = setTimeout(() => {
            pendingScanTimers.delete(timer);
            if (!enabled || !request.control.isConnected) {
                pendingSendRequests.delete(request.control);
                pendingActions.delete(request.control);
                return;
            }

            if (trySend(request)) return;

            // Wait for a DOM mutation so Send is dispatched as soon as the framework enables it.
            request.waitingForEnable = true;
        }, 0);
        pendingScanTimers.add(timer);
    }

    function selectAndSend(control, option, root, mediaType, timings) {
        if (
            completedControls.has(control) ||
            pendingActions.has(control) ||
            control.dataset?.[ACTION_MARKER] === 'true'
        ) {
            return;
        }
        pendingActions.add(control);

        timings.optionSelectedAt = getNow();

        try {
            if (control.matches?.('select')) {
                control.value = option.value;
                control.dispatchEvent(new Event('input', { bubbles: true }));
                control.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
                option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                option.click?.();
            }
        } catch (_error) {
            pendingActions.delete(control);
            return;
        }

        const request = { control, root, mediaType, timings, waitingForEnable: false };
        pendingSendRequests.set(control, request);

        // Queue Send on the next task to let the selection change event commit,
        // while also registering for instant mutation dispatch once ready.
        scheduleSendAttempt(request);
    }

    function scanRoot(root) {
        if (!enabled || !root?.querySelectorAll || typeof document === 'undefined') return;

        // Check pending send actions that are waiting for enable
        for (const request of Array.from(pendingSendRequests.values())) {
            if (request.root === root && request.waitingForEnable) {
                trySend(request);
            }
        }

        const mediaType = getCampaignMediaType();
        if (!mediaType) return;

        getMediaControls(root).forEach(control => {
            if (
                completedControls.has(control) ||
                pendingActions.has(control) ||
                control.dataset?.[ACTION_MARKER] === 'true'
            ) {
                return;
            }
            if (!isPlaceholderControl(control)) return;

            const timings = getOrCreateTimings(control);
            const option = findMatchingOption(root, control, mediaType);
            if (option) {
                if (!timings.optionListInsertedAt) timings.optionListInsertedAt = getNow();
                if (timings.promptInsertedAt) {
                    timings.promptToOptionMs = Math.max(0, Math.round(timings.optionListInsertedAt - timings.promptInsertedAt));
                }
                openingControls.delete(control);
                selectAndSend(control, option, root, mediaType, timings);
            } else {
                openControl(control);
                // If opening mounted options synchronously, select and send immediately
                const immediateOption = findMatchingOption(root, control, mediaType);
                if (immediateOption) {
                    timings.optionListInsertedAt = getNow();
                    if (timings.promptInsertedAt) {
                        timings.promptToOptionMs = Math.max(0, Math.round(timings.optionListInsertedAt - timings.promptInsertedAt));
                    }
                    openingControls.delete(control);
                    selectAndSend(control, immediateOption, root, mediaType, timings);
                } else if (typeof queueMicrotask === 'function') {
                    queueMicrotask(() => {
                        if (!enabled || !control.isConnected || pendingActions.has(control) || completedControls.has(control)) return;
                        const microOption = findMatchingOption(root, control, mediaType);
                        if (microOption) {
                            timings.optionListInsertedAt = getNow();
                            if (timings.promptInsertedAt) {
                                timings.promptToOptionMs = Math.max(0, Math.round(timings.optionListInsertedAt - timings.promptInsertedAt));
                            }
                            openingControls.delete(control);
                            selectAndSend(control, microOption, root, mediaType, timings);
                        }
                    });
                }
            }
        });
    }

    function observeRoot(root) {
        if (!root || observedRoots.has(root) || typeof MutationObserver !== 'function') return;
        const observer = new MutationObserver(mutations => {
            const hasChildListMutation = mutations.some(mutation => mutation.type === 'childList');
            const hasPendingSendMutation = mutations.some(mutation =>
                mutation.type === 'attributes' &&
                ['disabled', 'aria-disabled', 'class'].includes(mutation.attributeName) &&
                isSendButton(mutation.target)
            );

            if (hasChildListMutation || hasPendingSendMutation) {
                for (const request of Array.from(pendingSendRequests.values())) {
                    if (request.root === root && request.waitingForEnable) {
                        trySend(request);
                    }
                }
            }

            const shouldScan = mutations.some(mutation =>
                mutation.type === 'childList' ||
                (mutation.type === 'attributes' &&
                    ['aria-expanded', 'aria-selected', 'hidden', 'value'].includes(mutation.attributeName))
            );
            if (shouldScan) scanRoot(root);

            if (hasChatFrameMutation(mutations)) {
                const roots = collectChatRoots();
                roots.forEach(observeRoot);
                roots.forEach(scanRoot);
            }
        });
        const target = root.documentElement || root;
        observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
                'aria-expanded',
                'aria-selected',
                'aria-disabled',
                'disabled',
                'hidden',
                'value',
                'class'
            ]
        });
        observedRoots.set(root, observer);
        scanRoot(root);
    }

    function attachFrameListeners(frame) {
        if (!frame || attachedFrameListeners.has(frame)) return;
        const onLoad = () => {
            if (!enabled) return;
            const roots = collectChatRoots();
            roots.forEach(observeRoot);
            roots.forEach(scanRoot);
        };
        try {
            frame.addEventListener('load', onLoad, { passive: true });
            attachedFrameListeners.set(frame, onLoad);
        } catch (_error) {
            // Cross-origin frame listener restriction
        }
    }

    function collectChatRoots() {
        if (typeof document === 'undefined' || !document.querySelectorAll) return [];
        const roots = [];
        const visited = new Set();
        const visit = root => {
            if (!root || visited.has(root)) return;
            visited.add(root);
            roots.push(root);
            root.querySelectorAll?.('iframe').forEach(frame => {
                attachFrameListeners(frame);
                try {
                    if (frame.contentDocument) visit(frame.contentDocument);
                } catch (_error) {
                    // Cross-origin chat frames are intentionally ignored.
                }
            });
        };

        document.querySelectorAll(CHAT_FRAME_SELECTOR).forEach(frame => {
            attachFrameListeners(frame);
            try {
                if (frame.contentDocument) visit(frame.contentDocument);
            } catch (_error) {
                // Cross-origin chat frames are intentionally ignored.
            }
        });
        return roots;
    }

    function hasChatFrameMutation(mutations) {
        return mutations.some(mutation => {
            if (mutation.type !== 'childList') return false;
            return Array.from(mutation.addedNodes || []).some(node =>
                node.nodeType === 1 && (
                    node.matches?.(CHAT_FRAME_SELECTOR) ||
                    node.querySelector?.(CHAT_FRAME_SELECTOR)
                )
            );
        });
    }

    function start() {
        if (parentObserver || typeof MutationObserver !== 'function') {
            collectChatRoots().forEach(observeRoot);
            collectChatRoots().forEach(scanRoot);
            return;
        }

        parentObserver = new MutationObserver(mutations => {
            if (!hasChatFrameMutation(mutations)) return;
            collectChatRoots().forEach(observeRoot);
            collectChatRoots().forEach(scanRoot);
        });
        parentObserver.observe(document.documentElement, { childList: true, subtree: true });
        collectChatRoots().forEach(observeRoot);
    }

    function stop() {
        parentObserver?.disconnect?.();
        parentObserver = null;
        observedRoots.forEach(observer => observer.disconnect?.());
        observedRoots = new Map();
        pendingScanTimers.forEach(timer => clearTimeout(timer));
        pendingScanTimers.clear();
        pendingSendRequests.clear();
        openingControls = new WeakSet();
        pendingActions = new WeakSet();
        completedControls = new WeakSet();
        attachedFrameListeners.forEach((listener, frame) => {
            try {
                frame.removeEventListener('load', listener);
            } catch (_error) {
                // The frame may have been removed while the feature was stopping.
            }
        });
        attachedFrameListeners.clear();
        controlTimings = new WeakMap();
        lastTimings = null;
        cachedMediaIcon = null;
        cachedMediaType = null;
    }

    function setEnabled(nextEnabled) {
        enabled = nextEnabled === true;
        if (enabled) start();
        else stop();
    }

    function initialize() {
        if (initialized) return;
        initialized = true;

        chrome.storage.sync.get({ [SETTING_KEY]: true }, settings => {
            setEnabled(settings?.[SETTING_KEY] !== false);
        });

        chrome.storage.onChanged?.addListener((changes, area) => {
            if (area !== 'sync' || !changes[SETTING_KEY]) return;
            setEnabled(changes[SETTING_KEY].newValue !== false);
        });
    }

    window.moeChatMediaAutoSelectFeature = {
        initialize,
        scan: () => collectChatRoots().forEach(scanRoot),
        getCampaignMediaType,
        getLastTimings: () => (lastTimings ? { ...lastTimings } : null),
        resetCache: () => {
            cachedMediaIcon = null;
            cachedMediaType = null;
            lastTimings = null;
        }
    };
})();
