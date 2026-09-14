const {
    trackCampaignApproval,
    dismissApprovedCampaign,
    dismissPendingCampaign,
    clearAllApprovedCampaigns,
    pollPendingApprovals,
    getPendingApprovals,
    getApprovedCampaigns,
    PENDING_APPROVAL_KEY,
    APPROVED_CAMPAIGNS_KEY,
    ALARM_NAME
} = require('../../background/approval-polling.js');

describe('Approval Polling Service', () => {
    let localStorageData;
    let syncStorageData;
    let sentMessages;

    beforeEach(() => {
        localStorageData = {};
        syncStorageData = { approvalTrackingEnabled: true };
        sentMessages = [];

        global.chrome = {
            storage: {
                local: {
                    get: jest.fn((keys) => {
                        const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
                        const result = { ...defaults };
                        Object.keys(defaults).forEach(key => {
                            if (key in localStorageData) {
                                result[key] = localStorageData[key];
                            }
                        });
                        return Promise.resolve(result);
                    }),
                    set: jest.fn((items) => {
                        Object.assign(localStorageData, items);
                        return Promise.resolve();
                    })
                },
                sync: {
                    get: jest.fn((keys) => {
                        const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
                        const result = { ...defaults, ...syncStorageData };
                        return Promise.resolve(result);
                    })
                }
            },
            tabs: {
                query: jest.fn().mockResolvedValue([{ id: 101 }, { id: 102 }]),
                sendMessage: jest.fn((tabId, msg) => {
                    sentMessages.push({ tabId, msg });
                    return Promise.resolve();
                })
            },
            alarms: {
                get: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue(undefined)
            }
        };

        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.chrome;
        delete global.fetch;
    });

    test('trackCampaignApproval adds a campaign to pending list', async () => {
        const result = await trackCampaignApproval({
            campaignId: 'CP3GQJ6',
            campaignName: 'Test Campaign 2026',
            url: 'https://groupmuk-prisma.mediaocean.com/campaign-management/#campaign-id=CP3GQJ6'
        });

        expect(result.status).toBe('success');
        expect(localStorageData[PENDING_APPROVAL_KEY]).toBeDefined();
        expect(localStorageData[PENDING_APPROVAL_KEY]['CP3GQJ6']).toMatchObject({
            campaignId: 'CP3GQJ6',
            campaignName: 'Test Campaign 2026'
        });
    });

    test('dismissApprovedCampaign removes campaign from approved list', async () => {
        localStorageData[APPROVED_CAMPAIGNS_KEY] = [
            { campaignId: 'CP1', campaignName: 'Camp 1' },
            { campaignId: 'CP2', campaignName: 'Camp 2' }
        ];

        const result = await dismissApprovedCampaign('CP1');
        expect(result.status).toBe('success');
        expect(localStorageData[APPROVED_CAMPAIGNS_KEY]).toHaveLength(1);
        expect(localStorageData[APPROVED_CAMPAIGNS_KEY][0].campaignId).toBe('CP2');
    });

    test('dismissPendingCampaign removes campaign from pending list', async () => {
        localStorageData[PENDING_APPROVAL_KEY] = {
            'CP1': { campaignId: 'CP1' },
            'CP2': { campaignId: 'CP2' }
        };

        const result = await dismissPendingCampaign('CP1');
        expect(result.status).toBe('success');
        expect(localStorageData[PENDING_APPROVAL_KEY]['CP1']).toBeUndefined();
        expect(localStorageData[PENDING_APPROVAL_KEY]['CP2']).toBeDefined();
    });

    test('clearAllApprovedCampaigns empties the approved list', async () => {
        localStorageData[APPROVED_CAMPAIGNS_KEY] = [
            { campaignId: 'CP1', campaignName: 'Camp 1' }
        ];

        const result = await clearAllApprovedCampaigns();
        expect(result.status).toBe('success');
        expect(localStorageData[APPROVED_CAMPAIGNS_KEY]).toEqual([]);
    });

    test('pollPendingApprovals moves campaign from pending to approved when API returns APPROVED', async () => {
        localStorageData[PENDING_APPROVAL_KEY] = {
            'CP3GQJ6': {
                campaignId: 'CP3GQJ6',
                campaignName: 'Spring Brand',
                url: 'https://test/url',
                submittedAt: Date.now() - 60000
            }
        };

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                budgetApprovalStatus: 'APPROVED',
                name: 'Spring Brand'
            })
        });

        await pollPendingApprovals();

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('CP3GQJ6'),
            expect.objectContaining({ credentials: 'include' })
        );

        // Should be removed from pending
        expect(localStorageData[PENDING_APPROVAL_KEY]['CP3GQJ6']).toBeUndefined();

        // Should be added to approved list
        expect(localStorageData[APPROVED_CAMPAIGNS_KEY]).toHaveLength(1);
        expect(localStorageData[APPROVED_CAMPAIGNS_KEY][0]).toMatchObject({
            campaignId: 'CP3GQJ6',
            campaignName: 'Spring Brand'
        });

        // Should broadcast to active tabs
        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[0].msg).toMatchObject({
            action: 'campaignApproved',
            campaign: { campaignId: 'CP3GQJ6' }
        });
    });

    test('pollPendingApprovals keeps campaign pending when API returns SUBMITTED', async () => {
        localStorageData[PENDING_APPROVAL_KEY] = {
            'CP3GQJ6': {
                campaignId: 'CP3GQJ6',
                campaignName: 'Pending Campaign',
                url: 'https://test/url',
                submittedAt: Date.now()
            }
        };

        global.fetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                budgetApprovalStatus: 'SUBMITTED'
            })
        });

        await pollPendingApprovals();

        expect(localStorageData[PENDING_APPROVAL_KEY]['CP3GQJ6']).toBeDefined();
        expect(localStorageData[APPROVED_CAMPAIGNS_KEY] || []).toHaveLength(0);
        expect(sentMessages).toHaveLength(0);
    });

    test('pollPendingApprovals skips polling if approvalTrackingEnabled is false', async () => {
        syncStorageData.approvalTrackingEnabled = false;
        localStorageData[PENDING_APPROVAL_KEY] = {
            'CP3GQJ6': { campaignId: 'CP3GQJ6' }
        };

        await pollPendingApprovals();
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('Approval Tracking Content Script UI', () => {
    const fs = require('fs');
    const path = require('path');
    const { JSDOM } = require('jsdom');
    const scriptCode = fs.readFileSync(path.resolve(__dirname, '../../features/approval-tracking.js'), 'utf8');
    const approvalCss = fs.readFileSync(path.resolve(__dirname, '../../features/approval-tracking.css'), 'utf8');

    let dom;
    let window;
    let document;
    let localData;
    let syncData;
    let runtimeMessages;

    beforeEach(() => {
        localData = {};
        syncData = {
            approvalTrackingEnabled: true,
            approvalBannerIndicatorEnabled: true,
            approvalToastNotificationEnabled: true
        };
        runtimeMessages = [];

        dom = new JSDOM(`<!DOCTYPE html><html><head></head><body>
            <div id="banner-controls">
                <button class="switch-account-button">Switch Accounts</button>
                <mo-banner-user-menu></mo-banner-user-menu>
            </div>
            <div class="workflow-widget-wrapper">SUBMITTED</div>
        </body></html>`, {
            url: 'https://groupmuk-prisma.mediaocean.com/campaign-management/#campaign-id=CP3GQJ6',
            runScripts: 'dangerously'
        });

        window = dom.window;
        document = window.document;

        window.chrome = {
            storage: {
                local: {
                    get: jest.fn((keys, cb) => {
                        const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
                        const res = { ...defaults };
                        Object.keys(defaults).forEach(k => {
                            if (k in localData) res[k] = localData[k];
                        });
                        if (cb) cb(res);
                        return Promise.resolve(res);
                    }),
                    set: jest.fn((items, cb) => {
                        Object.assign(localData, items);
                        if (cb) cb();
                        return Promise.resolve();
                    })
                },
                sync: {
                    get: jest.fn((keys, cb) => {
                        const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
                        const res = { ...defaults, ...syncData };
                        if (cb) cb(res);
                        return Promise.resolve(res);
                    })
                },
                onChanged: {
                    addListener: jest.fn()
                }
            },
            runtime: {
                id: 'test-extension-id',
                onMessage: {
                    addListener: jest.fn()
                },
                sendMessage: jest.fn((msg) => {
                    runtimeMessages.push(msg);
                    return Promise.resolve({ status: 'success' });
                })
            }
        };

        const scriptEl = document.createElement('script');
        scriptEl.textContent = scriptCode;
        document.head.appendChild(scriptEl);
    });

    afterEach(() => {
        if (dom && dom.window) dom.window.close();
    });

    test('uses the measured Prisma banner baseline offset in both style contexts', () => {
        const externalRule = approvalCss.match(/\.toolshed-approval-banner-button\s*\{([^}]*)\}/)?.[1] || '';
        const inlineRule = scriptCode.match(/\.toolshed-approval-banner-button\s*\{([^}]*)\}/)?.[1] || '';

        expect(externalRule).toMatch(/transform:\s*translateY\(-1px\)/i);
        expect(inlineRule).toMatch(/transform:\s*translateY\(-1px\)/i);
    });

    test('injects banner button before switch-account-button with 1/1 Campaign Approved', async () => {
        localData[APPROVED_CAMPAIGNS_KEY] = [
            { campaignId: 'CP3GQJ6', campaignName: 'Spring 2026', approvedAt: Date.now() }
        ];

        window.approvalTrackingFeature.initialize();
        await Promise.resolve();
        await new Promise(r => setTimeout(r, 10));

        const btn = document.querySelector('.toolshed-approval-banner-button');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toContain('1/1 Campaign Approved');
        expect(btn.classList.contains('is-all-approved')).toBe(true);
    });

    test('injects promptly when Prisma mounts its banner inside Shadow DOM after initialization', async () => {
        document.getElementById('banner-controls').remove();
        localData[APPROVED_CAMPAIGNS_KEY] = [
            { campaignId: 'CP3GQJ6', campaignName: 'Spring 2026', approvedAt: Date.now() }
        ];

        window.approvalTrackingFeature.initialize();
        await Promise.resolve();

        const banner = document.createElement('mo-banner');
        const shadowRoot = banner.attachShadow({ mode: 'open' });
        const controls = document.createElement('div');
        controls.innerHTML = '<button class="switch-account-button">Switch Accounts</button><mo-banner-user-menu></mo-banner-user-menu>';
        shadowRoot.appendChild(controls);
        document.body.appendChild(banner);
        await new Promise(r => setTimeout(r, 10));

        const btn = shadowRoot.querySelector('.toolshed-approval-banner-button');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toContain('1/1 Campaign Approved');
        expect(scriptCode).not.toMatch(/waitForElementInShadow\('mo-banner-user-menu'/);
    });

    test('displays a clear resting state when no tracked campaigns exist', async () => {
        localData[APPROVED_CAMPAIGNS_KEY] = [];
        localData[PENDING_APPROVAL_KEY] = {};

        window.approvalTrackingFeature.initialize();
        await Promise.resolve();
        await new Promise(r => setTimeout(r, 10));

        const btn = document.querySelector('.toolshed-approval-banner-button');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toContain('Campaign Approvals');
        expect(btn.classList.contains('is-none-tracked')).toBe(true);

        btn.click();
        await new Promise(r => setTimeout(r, 10));
        const panel = document.querySelector('.toolshed-approval-panel');
        expect(panel.querySelector('.toolshed-approval-panel-title').textContent).toBe('Campaign Approvals');
        expect(panel.querySelector('.toolshed-approval-panel-badge')).toBeNull();
    });

    test('does not inject banner button when approvalBannerIndicatorEnabled is false', async () => {
        syncData.approvalBannerIndicatorEnabled = false;
        window.approvalTrackingFeature.initialize();
        await Promise.resolve();
        await new Promise(r => setTimeout(r, 10));

        const btn = document.querySelector('.toolshed-approval-banner-button');
        expect(btn).toBeNull();
    });

    test('displays 0/1 Campaign Approved when one campaign is pending and zero approved', async () => {
        localData[APPROVED_CAMPAIGNS_KEY] = [];
        localData[PENDING_APPROVAL_KEY] = {
            'CP1': { campaignId: 'CP1', campaignName: 'Pending Campaign', submittedAt: Date.now() }
        };

        window.approvalTrackingFeature.initialize();
        await Promise.resolve();
        await new Promise(r => setTimeout(r, 10));

        const btn = document.querySelector('.toolshed-approval-banner-button');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toContain('0/1 Campaign Approved');
        expect(btn.classList.contains('is-pending-only')).toBe(true);
    });

    test('displays 1/2 Campaigns Approved when one is approved and one is pending', async () => {
        localData[APPROVED_CAMPAIGNS_KEY] = [
            { campaignId: 'CP1', campaignName: 'Alpha Approved', approvedAt: Date.now() }
        ];
        localData[PENDING_APPROVAL_KEY] = {
            'CP2': { campaignId: 'CP2', campaignName: 'Beta Pending', submittedAt: Date.now() }
        };

        window.approvalTrackingFeature.initialize();
        await Promise.resolve();
        await new Promise(r => setTimeout(r, 10));

        const btn = document.querySelector('.toolshed-approval-banner-button');
        expect(btn).not.toBeNull();
        expect(btn.textContent).toContain('1/2 Campaigns Approved');
        expect(btn.classList.contains('is-partially-approved')).toBe(true);
    });

    test('does not treat NOT SUBMITTED as submitted and removes a stale pending entry', async () => {
        localData[PENDING_APPROVAL_KEY] = {
            CP3GQJ6: {
                campaignId: 'CP3GQJ6',
                campaignName: 'Tempur Social',
                submittedAt: Date.now()
            }
        };
        document.querySelector('.workflow-widget-wrapper').textContent = 'NOT SUBMITTED';

        expect(window.approvalTrackingFeature.detectWorkflowApprovalState('NOT SUBMITTED'))
            .toBe('not-submitted');
        window.approvalTrackingFeature.checkLiveWorkflowWidget();
        await Promise.resolve();

        expect(localData[PENDING_APPROVAL_KEY].CP3GQJ6).toBeUndefined();
    });

    test('keeps exact submitted and approved states distinct from their negative forms', () => {
        const detect = window.approvalTrackingFeature.detectWorkflowApprovalState;

        expect(detect('SUBMITTED')).toBe('submitted');
        expect(detect('APPROVED')).toBe('approved');
        expect(detect('NOT_SUBMITTED')).toBe('not-submitted');
        expect(detect('NOT-APPROVED')).toBe('not-approved');
        expect(detect('DRAFT')).toBe('unknown');
    });

    test('immediately resolves an already-approved campaign tracked from Orders', async () => {
        document.querySelector('.workflow-widget-wrapper').textContent = 'APPROVED';
        window.chrome.runtime.sendMessage.mockImplementation(async msg => {
            runtimeMessages.push(msg);
            if (msg.action === 'trackCampaignApproval') {
                localData[PENDING_APPROVAL_KEY] = {
                    [msg.campaign.campaignId]: { ...msg.campaign, lastChecked: Date.now() }
                };
            }
            return { status: 'success' };
        });

        window.approvalTrackingFeature.initialize();
        await new Promise(r => setTimeout(r, 15));
        document.querySelector('.toolshed-approval-banner-button').click();
        await new Promise(r => setTimeout(r, 15));
        document.querySelector('.toolshed-approval-track-current-btn').click();
        await new Promise(r => setTimeout(r, 30));

        expect(localData[PENDING_APPROVAL_KEY].CP3GQJ6).toBeUndefined();
        expect(localData[APPROVED_CAMPAIGNS_KEY]).toEqual([
            expect.objectContaining({ campaignId: 'CP3GQJ6' })
        ]);
        const panel = document.querySelector('.toolshed-approval-panel');
        expect(panel.querySelector('.toolshed-approval-panel-badge').textContent).toBe('1/1 Approved');
        expect(panel.textContent).toContain('Approved Campaigns (1)');
    });

    test('renders approval panel with Approved and Pending sections', async () => {
        localData[APPROVED_CAMPAIGNS_KEY] = [
            { campaignId: 'CP3GQJ6', campaignName: 'Holiday Promo', approvedAt: Date.now(), url: 'https://test/url' }
        ];
        localData[PENDING_APPROVAL_KEY] = {
            'CP888': { campaignId: 'CP888', campaignName: 'Summer Launch', submittedAt: Date.now() }
        };

        window.approvalTrackingFeature.initialize();
        await Promise.resolve();
        await new Promise(r => setTimeout(r, 15));

        const btn = document.querySelector('.toolshed-approval-banner-button');
        btn.click();
        await Promise.resolve();
        await new Promise(r => setTimeout(r, 15));

        const panel = document.querySelector('.toolshed-approval-panel');
        expect(panel).not.toBeNull();
        expect(panel.textContent).toContain('Campaign Approvals');
        expect(panel.textContent).toContain('1/2 Approved');
        expect(panel.textContent).toContain('Approved Campaigns (1)');
        expect(panel.textContent).toContain('Holiday Promo');
        expect(panel.textContent).toContain('Pending Approval (1)');
        expect(panel.textContent).toContain('Summer Launch');
        expect(panel.textContent).toContain('Check now');
        expect(panel.querySelector('.toolshed-approval-header-btn svg').getAttribute('viewBox')).toBe('0 0 24 24');
    });

    test('closes the approval panel with an exit transition before removing it', async () => {
        localData[APPROVED_CAMPAIGNS_KEY] = [
            { campaignId: 'CP3GQJ6', campaignName: 'Holiday Promo', approvedAt: Date.now() }
        ];

        window.approvalTrackingFeature.initialize();
        await new Promise(r => setTimeout(r, 15));

        document.querySelector('.toolshed-approval-banner-button').click();
        await new Promise(r => setTimeout(r, 15));

        const panel = document.querySelector('.toolshed-approval-panel');
        panel.querySelector('.toolshed-approval-header-close').click();

        expect(panel.isConnected).toBe(true);
        expect(panel.classList.contains('is-open')).toBe(false);
        expect(panel.classList.contains('is-closing')).toBe(true);

        const transitionEnd = new window.Event('transitionend', { bubbles: true });
        Object.defineProperty(transitionEnd, 'propertyName', { value: 'opacity' });
        panel.dispatchEvent(transitionEnd);
        expect(panel.isConnected).toBe(false);
    });

    test('Check now shows a stable busy state and refreshes the existing panel in place', async () => {
        localData[PENDING_APPROVAL_KEY] = {
            CP1: { campaignId: 'CP1', campaignName: 'Pending Campaign', submittedAt: Date.now() }
        };

        window.approvalTrackingFeature.initialize();
        await new Promise(r => setTimeout(r, 15));
        document.querySelector('.toolshed-approval-banner-button').click();
        await new Promise(r => setTimeout(r, 15));

        const firstPanel = document.querySelector('.toolshed-approval-panel');
        const checkNowButton = firstPanel.querySelector('.toolshed-approval-header-btn');
        checkNowButton.click();

        expect(checkNowButton.disabled).toBe(true);
        expect(checkNowButton.classList.contains('is-checking')).toBe(true);
        expect(checkNowButton.getAttribute('aria-busy')).toBe('true');
        expect(checkNowButton.textContent).toContain('Checking…');

        await new Promise(r => setTimeout(r, 700));

        const refreshedPanel = document.querySelector('.toolshed-approval-panel');
        expect(runtimeMessages).toContainEqual({ action: 'checkApprovalStatusNow' });
        expect(refreshedPanel).toBe(firstPanel);
        expect(refreshedPanel.classList.contains('is-open')).toBe(true);
        expect(refreshedPanel.classList.contains('is-closing')).toBe(false);
        expect(refreshedPanel.querySelector('.toolshed-approval-header-btn').textContent)
            .toContain('Check now');
    });

    test('clearing all approved campaigns returns the banner to its resting state', async () => {
        localData[APPROVED_CAMPAIGNS_KEY] = [
            { campaignId: 'CP1', campaignName: 'Campaign 1', approvedAt: Date.now() },
            { campaignId: 'CP2', campaignName: 'Campaign 2', approvedAt: Date.now() }
        ];
        localData[PENDING_APPROVAL_KEY] = {};

        window.approvalTrackingFeature.initialize();
        await new Promise(r => setTimeout(r, 15));

        const btn = document.querySelector('.toolshed-approval-banner-button');
        expect(btn.textContent).toContain('2/2 Campaigns Approved');

        btn.click();
        await new Promise(r => setTimeout(r, 15));

        const panel = document.querySelector('.toolshed-approval-panel');
        const clearAllBtn = panel.querySelector('.toolshed-approval-clear-all-btn');
        expect(clearAllBtn).not.toBeNull();

        window.chrome.runtime.sendMessage.mockImplementation(async msg => {
            if (msg.action === 'clearAllApprovedCampaigns') {
                localData[APPROVED_CAMPAIGNS_KEY] = [];
                return { status: 'success' };
            }
            return { status: 'success' };
        });

        clearAllBtn.click();
        await new Promise(r => setTimeout(r, 30));

        expect(btn.textContent).toContain('Campaign Approvals');
        expect(btn.classList.contains('is-none-tracked')).toBe(true);

        const refreshedPanel = document.querySelector('.toolshed-approval-panel');
        expect(refreshedPanel.textContent).toContain('Campaign Approvals');
        expect(refreshedPanel.textContent).toContain('No campaigns currently being tracked for approval.');
    });

    test('showApprovalToast creates interactive toast reusing ops-toolshed-toast', () => {
        window.open = jest.fn();
        window.approvalTrackingFeature.showApprovalToast({
            campaignId: 'CP999',
            campaignName: 'Summer Launch Campaign Very Long Name That Will Be Truncated',
            url: 'https://groupmuk-prisma.mediaocean.com/#campaign-id=CP999'
        });

        const toast = document.getElementById('ops-toolshed-toast');
        expect(toast).not.toBeNull();
        expect(toast.classList.contains('toolshed-approval-toast')).toBe(true);
        expect(toast.classList.contains('toast-success')).toBe(true);
        expect(toast.textContent).toContain('Approved');

        toast.click();
        expect(window.open).toHaveBeenCalledWith('https://groupmuk-prisma.mediaocean.com/#campaign-id=CP999', '_blank');
    });

    test('gracefully handles invalidated extension context without throwing unhandled exceptions', async () => {
        window.approvalTrackingFeature.initialize();
        await new Promise(r => setTimeout(r, 15));

        // 1. Invalidation before calling
        delete window.chrome.runtime.id;
        await expect(window.approvalTrackingFeature.updateBannerIndicator()).resolves.toBeUndefined();
        expect(() => window.approvalTrackingFeature.checkLiveWorkflowWidget()).not.toThrow();

        // 2. Mid-flight context invalidation rejection
        window.chrome.runtime.id = 'test-extension-id';
        window.chrome.storage.local.get.mockImplementation(() => {
            return Promise.reject(new Error('Extension context invalidated.'));
        });
        await expect(window.approvalTrackingFeature.updateBannerIndicator()).resolves.toBeUndefined();
    });
});
